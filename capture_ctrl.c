// capture_ctrl.c -- Phase 1 (Linux-side capture control) daemon.
//
// Implements the producer/consumer model from diagrams/arch.md's
// "Linux-side capture control" section on top of the already-validated
// Phase 1/2 DMA transport (hdmi/adc_dma_writer.v -> 8 MiB ring at physical
// 0x20000000). See diagrams/phase1_requirements.md for the full functional
// requirements this implements (FR1-FR5).
//
// One process, single-threaded, select()-based event loop -- deliberately
// NOT multi-threaded: this project has no connected hardware to validate
// concurrency bugs against right now, so a simple, single-threaded design
// that's easy to reason about beats a "clever" one that's hard to debug
// blind. Reuses the exact /dev/mem mmap technique already proven by
// software/dma_e2e_test.c (same GP register page + ring mapping).
//
// Modes (mutually exclusive, all built on ONE producer/consumer model --
// see "Core abstraction" in arch.md):
//   IDLE            -- dma_en=0, nothing happening.
//   RECORDING       -- manual record (FR1): dma_en=1, consumer_pos fixed at
//                      the position recording started; auto-stops when the
//                      ring is about to wrap back over that position.
//   ARMED_SCANNING  -- armed/trigger (FR3): dma_en=1, ring free-running,
//                      background scanner looks for a match; consumer_pos
//                      not yet meaningful.
//   ARMED_CAPTURING -- post-trigger (FR3): consumer_pos set from the match
//                      position, capturing for a configured post-trigger
//                      length, then auto-stops exactly like RECORDING.
//   STREAMING       -- a client is connected and draining the ring live
//                      (FR2); can be entered from any of the above (a
//                      client connecting mid-session converts it to a live
//                      drain) or from IDLE (a fresh live tail).
//
// Control plane: a Unix domain socket at /tmp/capture_ctrl.sock, one
// command per connection (connect, send one line, get one line back,
// close) -- simple enough for both a human via `nc -U` and the small CLI
// client (capture_ctl.c) or, later, qt_ui. Commands: STATUS, RECORD_START,
// RECORD_STOP, DUMP <path> (FR1.4: writes the last finalized capture
// window to a file), ARM <pattern_hex> <mask_hex> [post_trigger_bursts],
// DISARM, RATE <divider>.
//
// Data plane: a TCP listen server (port 9998 by default -- deliberately
// different from adc_recorder.c's existing 9999, so the old gpi_out-based
// streaming feature and this new DMA-ring-based one can coexist without
// colliding) that streams raw 32-bit tagged stream words, in order, to
// whichever single client is connected.
//
// Build (cross-compile from WSL, static -- see dma_notes.md's GLIBC note):
//   arm-linux-gnueabihf-gcc -O2 -Wall -static -o capture_ctrl capture_ctrl.c
//
// Run on the board (as root): ./capture_ctrl [--stream-port N]

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <time.h>
#include <errno.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>

// ==========================================================================
// Constants shared with software/dma_e2e_test.c (must match
// hdmi/adc_dma_writer.v's parameters and C5Test.v's instantiation -- see
// diagrams/dma_notes.md).
// ==========================================================================
#define GP_PAGE_BASE   0xFF706000UL
#define GP_PAGE_SIZE   0x1000UL
#define GP_OUT_OFF     0x10          // HPS -> FPGA (write)
#define GP_IN_OFF      0x14          // FPGA -> HPS (read)

#define GPMAGIC        0xA0000000UL
#define BIT_DMA_EN     (1UL << 24)
#define BIT_DIAG_MODE  (1UL << 26)
#define BIT_VIEW17     (1UL << 17)
#define BIT_VIEW18     (1UL << 18)

#define GPOUT_DMA_OFF        (GPMAGIC)
#define GPOUT_DMA_ON_STATUS  (GPMAGIC | BIT_DMA_EN | BIT_DIAG_MODE)
// NOTE: there are deliberately no GPOUT_DMA_ON_BURSTS/DROPPED constants
// here -- see diag_view_gpout() below for why a fixed constant that bakes
// in BIT_DMA_EN is exactly the bug that let a diag-view read silently
// force the DMA on regardless of the daemon's actual intended state.

// Phase 1 config-register write sub-channel (magic 0xB, see C5Test.v).
// Encoding: [31:28]=0xB [27:24]=reg addr [23:0]=value.
#define CFGMAGIC       0xB0000000UL
#define CFG_REG_RATE_DIV 0x0UL
#define CFG_WRITE(reg, value) (CFGMAGIC | (((uint32_t)(reg) & 0xF) << 24) | ((uint32_t)(value) & 0x00FFFFFFUL))

#define RING_BASE_PHYS   0x20000000UL
#define RING_WORDS       0x100000UL      // 1M 64-bit words = 8 MiB
#define RING_BYTES       (RING_WORDS * 8UL)
#define BURST_BEATS      16UL
#define RING_BURST_SLOTS (RING_WORDS / BURST_BEATS)   // 65536

#define DEFAULT_STREAM_PORT 9998
#define CONTROL_SOCK_PATH   "/tmp/capture_ctrl.sock"

// ==========================================================================
// Global mmap'd hardware access (same technique as dma_e2e_test.c)
// ==========================================================================
static volatile uint32_t *gp_map;
static volatile uint64_t *ring_map;
static int g_sim_mode = 0; // set by --sim: use the mock hardware model below
                            // instead of /dev/mem, so the daemon's LOGIC
                            // (record/stream/trigger/dump) can be exercised
                            // as a real running process on a plain WSL/Linux
                            // host with no board attached. See
                            // diagrams/phase1_requirements.md's "WSL/
                            // ModelSim test coverage" section.

static double now_sec(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

// ==========================================================================
// Mock hardware model (--sim only). Stands in for the FPGA side: tracks
// the last-written gp_out value and, on read, computes the same diag-view
// response C5Test.v's combinational mux would produce (status/bursts_done/
// dropped_words tags), and advances a simulated bursts_done counter over
// real wall-clock time whenever the simulated dma_en bit is set -- exactly
// mirroring adc_dma_writer.v's dma_en-gated behavior, just in software.
// Ring content is a simple, fully deterministic pattern -- tag=0xC AND
// both ch1_present/ch0_present bits set (0xCC in the top byte, matching
// hdmi/adc2ch_sim.v's real word format: {4'hC, ch1_valid, ch0_valid,
// 2'b00, ch1[11:0], ch0[11:0]} -- word_looks_valid() in this file requires
// both valid bits set, so getting this wrong makes every simulated word
// look "structurally invalid" and silently unmatchable -- found by this
// project's own dynamic testing), low 24 bits = a running global sample
// index. NOT a re-implementation of adc2ch_sim.v's actual sine/trapezoid
// generator (that RTL is already covered by its own ModelSim testbenches);
// this model only needs to exercise the DAEMON's control-flow logic
// against known, easily-predicted content.
// ==========================================================================
static uint32_t sim_gp_out = 0;
static uint32_t sim_bursts_done = 0;
static uint32_t sim_dropped_words = 0;
static uint32_t sim_rate_div_written = 52000; // last CFG_WRITE(0,...) value seen
static double   sim_last_tick_t = 0.0;
static double   sim_carry = 0.0;
static uint32_t sim_bursts_per_real_second = 50000; // fast: a full 65536-slot
                                                      // ring wraps in ~1.3s,
                                                      // so tests run quickly

static void sim_ring_write_burst(uint32_t idx) {
    uint64_t slot = idx % RING_BURST_SLOTS;
    uint64_t word_idx = slot * BURST_BEATS;
    for (uint32_t beat = 0; beat < BURST_BEATS; beat++) {
        uint32_t sample_idx = idx * 32 + beat * 2;
        uint32_t w_lo = 0xCC000000u | (sample_idx & 0x00FFFFFFu);
        uint32_t w_hi = 0xCC000000u | ((sample_idx + 1) & 0x00FFFFFFu);
        ring_map[word_idx + beat] = ((uint64_t)w_hi << 32) | (uint64_t)w_lo;
    }
}

// Called once per main-loop tick (--sim only): advances the simulated
// producer at sim_bursts_per_real_second while the simulated dma_en bit is
// set, exactly like the real DMA free-runs while hardware dma_en=1.
static void sim_hardware_tick(void) {
    double t = now_sec();
    if (sim_last_tick_t == 0.0) { sim_last_tick_t = t; return; }
    double dt = t - sim_last_tick_t;
    sim_last_tick_t = t;

    int magic_ok = ((sim_gp_out >> 28) == 0xA);
    int dma_en_now = magic_ok && ((sim_gp_out & BIT_DMA_EN) != 0);
    if (!dma_en_now) return;

    sim_carry += dt * (double)sim_bursts_per_real_second;
    uint32_t n = (uint32_t)sim_carry;
    sim_carry -= (double)n;
    for (uint32_t i = 0; i < n; i++) {
        sim_ring_write_burst(sim_bursts_done);
        sim_bursts_done++;
    }
}

static void sim_gp_write(uint32_t v) {
    sim_gp_out = v;
    if ((v >> 28) == 0xB) { // config-register write, mirrors C5Test.v's magic 0xB
        uint32_t reg = (v >> 24) & 0xF;
        uint32_t val = v & 0x00FFFFFFu;
        if (reg == CFG_REG_RATE_DIV) sim_rate_div_written = val;
    }
}

static uint32_t sim_gp_read(void) {
    if ((sim_gp_out >> 28) != 0xA) return 0;
    if (((sim_gp_out >> 26) & 1) == 0) return 0xA0000000u; // diag_mode not set
    uint32_t view = (sim_gp_out >> 17) & 0x3;
    if (view == 0x1) return 0xE0000000u | (sim_bursts_done & 0x07FFFFFFu);
    if (view & 0x2)  return 0xF0000000u | (sim_dropped_words & 0x07FFFFFFu);
    return 0xD0000000u; // status view (not consumed by the daemon's own logic)
}

static void gp_write(uint32_t v) {
    if (g_sim_mode) { sim_gp_write(v); return; }
    gp_map[GP_OUT_OFF / 4] = v;
}
static uint32_t gp_read(void) {
    if (g_sim_mode) return sim_gp_read();
    return gp_map[GP_IN_OFF / 4];
}

// Single source of truth for the INTENDED dma_en state (declared here,
// ahead of the diag-view read helpers below, which must consult it -- see
// the bug note on diag_view_gpout()).
static int dma_enabled = 0;

// CRITICAL FIX (found via real hardware testing, 2026-07-17): a diag-view
// read must NEVER change the actual dma_en bit as a side effect of
// selecting which counter to read. The original code hardcoded
// BIT_DMA_EN into the view-select write constants (GPOUT_DMA_ON_BURSTS/
// DROPPED), so simply reading bursts_done/dropped_words -- which
// policy_tick() does every ~20ms, unconditionally, regardless of mode --
// silently forced dma_en=1 on real gp_out every single tick, keeping the
// DMA running continuously even while the daemon's own state said IDLE/
// dma_en=0. Invisible in --sim testing (the mock model doesn't
// distinguish "logically wanted" from "actually written" state), but
// unmistakable on real hardware: bursts_done kept advancing during
// STATUS polls while STATUS itself reported dma_en=0. Fix: compute the
// diag-view write value from the CURRENT dma_enabled variable, never a
// fixed constant.
static uint32_t diag_view_gpout(uint32_t view_bits) {
    uint32_t v = GPMAGIC | BIT_DIAG_MODE | view_bits;
    if (dma_enabled) v |= BIT_DMA_EN;
    return v;
}

// Read the bursts_done producer counter (0xE tag, bits[26:0]=count). This
// is producer_pos (FR5.1) -- the ONLY producer signal that exists today;
// no dedicated mailbox register, per FR5.2/phase1_requirements.md.
static uint32_t read_bursts_done(void) {
    gp_write(diag_view_gpout(BIT_VIEW17));
    uint32_t v = gp_read();
    return v & 0x07FFFFFF;
}

static uint32_t read_dropped_words(void) {
    gp_write(diag_view_gpout(BIT_VIEW18));
    uint32_t v = gp_read();
    return v & 0x07FFFFFF;
}

// dma_en is bit 24 of gp_out, combined with whatever diag view is
// currently selected. We always reassert the full magic+bit pattern each
// time (gp_out is a level, not a latch, and other logic -- display, etc.
// -- may also be writing it; recall that a diag_mode write in this
// codebase is understood to be used only during a dedicated capture
// session, same caveat as dma_e2e_test.c/dma_notes.md already document).
static void set_dma_en(int enable) {
    dma_enabled = enable ? 1 : 0;
    gp_write(dma_enabled ? GPOUT_DMA_ON_STATUS : GPOUT_DMA_OFF);
}

// FR4.2/FR4.3: runtime rate-divider config-register write. div=0 is
// reserved/ignored by the RTL (see adc2ch_sim.v's rate_div_active gate),
// so guard against sending 0 here too.
// Tracks the LAST CONFIGURED divider (distinct from g_rate_est_bursts_per_sec
// in policy_tick(), which is an EMPIRICAL measurement that necessarily lags
// behind -- producer_pos only advances while dma_en=1, so right after a RATE
// change made while IDLE, the empirical estimate is stale/zero until a
// session is already running. theoretical_bursts_per_sec() below uses this
// instead so RECORD_START/ARM can reject an unsafe rate immediately, before
// ever entering the mode -- see those handlers' entry guard.
static uint32_t g_configured_rate_div = 52000; // matches ADC_GEN_DIV default
static void set_rate_div(uint32_t div) {
    if (div == 0) div = 1;
    g_configured_rate_div = div;
    gp_write(CFG_WRITE(CFG_REG_RATE_DIV, div));
    // Config writes are edge-triggered on the FPGA side (see C5Test.v's
    // cfg_magic_prev); return gp_out to whatever the current dma_en state
    // needs so normal operation (and any future config write) still works.
    gp_write(dma_enabled ? GPOUT_DMA_ON_STATUS : GPOUT_DMA_OFF);
}

// Forward declaration: defined below alongside safety_margin_bursts(), but
// needed here since handle_command()'s RECORD_START/ARM guards (further
// down, but still textually before that definition) call it.
static uint32_t theoretical_margin_bursts(void);

// ==========================================================================
// Ring geometry helpers (identical modulo-addressing technique as
// dma_e2e_test.c, reused here for both recording and streaming).
// ==========================================================================

// Decode one 32-bit tagged stream word's structural fields (see
// hdmi/adc2ch_sim.v's FIFO word format comment). Returns 1 if the
// structural tag/valid bits look sane, 0 otherwise (does not stop
// anything, just lets the caller log an anomaly).
static int word_looks_valid(uint32_t w) {
    uint32_t tag = (w >> 28) & 0xF;
    uint32_t ch1_present = (w >> 27) & 1;
    uint32_t ch0_present = (w >> 26) & 1;
    return (tag == 0xC) && ch1_present && ch0_present;
}

// Read the two 32-bit stream words belonging to burst-index `idx`
// (absolute, cumulative since power-on -- matches bursts_done's units)
// into out[0..31] (32 words per burst: 16 beats * 2 words/beat). Handles
// ring wraparound via the burst-slot modulus, exactly like
// dma_e2e_test.c's content verifier.
static void read_burst(uint32_t idx, uint32_t *out /* [32] */) {
    uint64_t slot = idx % RING_BURST_SLOTS;
    uint64_t word_idx = slot * BURST_BEATS;
    for (uint32_t beat = 0; beat < BURST_BEATS; beat++) {
        uint64_t beat_val = ring_map[word_idx + beat];
        out[beat * 2 + 0] = (uint32_t)(beat_val & 0xFFFFFFFFULL);   // earlier
        out[beat * 2 + 1] = (uint32_t)(beat_val >> 32);             // later
    }
}

// ==========================================================================
// Trigger predicate (FR3.2): Phase 1 only implements a raw pattern+mask
// leaf match. Deliberately behind a small function-pointer-style interface
// (trigger_match()) so Phase 3 can add protocol-message leaves and
// AND/OR/NOT combinators (arch.md's "Extensible trigger predicate design")
// without the scanner loop itself changing.
// ==========================================================================
typedef struct {
    int      active;
    uint32_t pattern;
    uint32_t mask;
} trigger_cfg_t;

static int trigger_match(const trigger_cfg_t *t, uint32_t word) {
    if (!t->active) return 0;
    return (word & t->mask) == (t->pattern & t->mask);
}

// ==========================================================================
// Capture session state (FR5.3: one model, several policies)
// ==========================================================================
typedef enum {
    MODE_IDLE = 0,
    MODE_RECORDING,
    MODE_ARMED_SCANNING,
    MODE_ARMED_CAPTURING,
} capture_mode_t;

static capture_mode_t g_mode = MODE_IDLE;
static uint32_t g_consumer_pos = 0;   // meaning depends on mode (see below)
static uint32_t g_record_start = 0;   // producer_pos at RECORDING start
static uint32_t g_record_stop  = 0;   // producer_pos when the last session stopped (FR1.4: DUMP range)
static int      g_have_last_capture = 0; // whether [g_consumer_pos, g_record_stop) is valid to DUMP
static uint32_t g_post_trigger_bursts = 64; // default post-trigger length
static uint32_t g_trigger_match_pos = 0;
static trigger_cfg_t g_trigger = {0, 0, 0};

// Streaming client state (FR2). Only one client at a time in Phase 1.
static int      g_stream_client_fd = -1;
static uint32_t g_stream_consumer = 0; // next burst index to send to the client
static int      g_stream_consumer_init = 0; // whether g_stream_consumer has been set for this connection
static int      g_stream_was_live_tail = 0; // this connection's dma_en was turned on purely for streaming (IDLE-connect case)

static void mode_enter_idle(void) {
    // FR1.4: a window is DUMP-able if we're leaving a mode that had a real
    // capture in progress. MODE_RECORDING always qualifies. MODE_ARMED_
    // CAPTURING qualifies (a trigger already matched, even if we're
    // stopping early/on-full). MODE_ARMED_SCANNING does NOT -- no trigger
    // ever fired, so [g_consumer_pos, now) is meaningless noise, not a
    // real capture.
    if (g_mode == MODE_RECORDING || g_mode == MODE_ARMED_CAPTURING) {
        g_record_stop = read_bursts_done();
        g_have_last_capture = 1;
    }
    set_dma_en(0);
    g_mode = MODE_IDLE;
    fprintf(stderr, "[capture_ctrl] -> IDLE (dma_en=0)\n");
}

static const char *mode_name(capture_mode_t m) {
    switch (m) {
        case MODE_IDLE: return "IDLE";
        case MODE_RECORDING: return "RECORDING";
        case MODE_ARMED_SCANNING: return "ARMED_SCANNING";
        case MODE_ARMED_CAPTURING: return "ARMED_CAPTURING";
    }
    return "?";
}

// FR3.3: lag budget, in bursts and seconds, given the current rate.
// rate_bursts_per_sec is an ESTIMATE the caller must supply (derived from
// two bursts_done samples over a known interval) -- there is no direct
// hardware readback of "current rate" beyond observing the counter move.
// NFR5: must be logged/reportable, not silently assumed -- used both in
// the ARMED_SCANNING log line and the STATUS command below.
static double lag_budget_seconds(double rate_bursts_per_sec) {
    if (rate_bursts_per_sec <= 0.0) return -1.0; // unknown / not moving
    return (double)RING_BURST_SLOTS / rate_bursts_per_sec;
}

// Tracks producer_pos across policy_tick() calls to estimate the current
// burst rate for the lag-budget report (NFR5) -- a simple derivative, not
// a hardware readback (none exists).
static uint32_t g_rate_est_prev_pos = 0;
static double   g_rate_est_prev_t = 0.0;
static double   g_rate_est_bursts_per_sec = 0.0;
static void update_rate_estimate(uint32_t producer_pos) {
    double t = now_sec();
    if (g_rate_est_prev_t > 0.0) {
        double dt = t - g_rate_est_prev_t;
        if (dt > 0.0) {
            uint32_t delta = producer_pos - g_rate_est_prev_pos; // wraps correctly
            g_rate_est_bursts_per_sec = (double)delta / dt;
        }
    }
    g_rate_est_prev_pos = producer_pos;
    g_rate_est_prev_t   = t;
}

// ==========================================================================
// FR1.4: dump the last finalized capture window ([g_consumer_pos,
// g_record_stop)) to a file, as raw 32-bit tagged stream words in order.
// This is the only way today to actually retrieve a manual/armed capture
// -- without it, RECORD_STOP/DISARM would report a window that can never
// be gotten back out (see phase1_requirements.md's FR1.4).
// ==========================================================================
static int dump_capture_to_file(const char *path, char *reply, size_t reply_sz) {
    if (!g_have_last_capture) {
        snprintf(reply, reply_sz, "ERR no valid capture to dump (record/arm+trigger first)\n");
        return -1;
    }
    FILE *f = fopen(path, "wb");
    if (!f) {
        snprintf(reply, reply_sz, "ERR could not open '%s' for writing\n", path);
        return -1;
    }
    uint32_t start = g_consumer_pos;
    uint32_t stop  = g_record_stop;
    uint32_t count = stop - start; // wraps correctly if it ever somehow did
    uint32_t words[32];
    uint64_t total_words = 0;
    for (uint32_t i = start; i != stop; i++) {
        read_burst(i, words);
        fwrite(words, sizeof(words), 1, f);
        total_words += 32;
    }
    fclose(f);
    snprintf(reply, reply_sz, "OK dumped %u bursts (%llu words) to '%s'\n",
             count, (unsigned long long)total_words, path);
    return 0;
}

// ==========================================================================
// Control-plane command handling (Unix domain socket, one line in, one
// line reply out, per connection).
// ==========================================================================
static void handle_command(const char *cmd, char *reply, size_t reply_sz) {
    char verb[32] = {0};
    unsigned long a1 = 0, a2 = 0, a3 = 0;
    int n = sscanf(cmd, "%31s %lx %lx %lu", verb, &a1, &a2, &a3);

    // DUMP takes a filesystem path, not a hex number -- parse it separately
    // before falling into the generic numeric-argument handling above.
    {
        char dump_verb[32] = {0};
        char dump_path[256] = {0};
        if (sscanf(cmd, "%31s %255s", dump_verb, dump_path) == 2 &&
            strcmp(dump_verb, "DUMP") == 0) {
            dump_capture_to_file(dump_path, reply, reply_sz);
            return;
        }
    }

    if (strcmp(verb, "RECORD_START") == 0) {
        if (g_mode != MODE_IDLE) {
            snprintf(reply, reply_sz, "ERR busy (mode=%s)\n", mode_name(g_mode));
            return;
        }
        uint32_t tm = theoretical_margin_bursts();
        if (tm >= RING_BURST_SLOTS) {
            snprintf(reply, reply_sz,
                     "ERR rate too high for buffered recording (configured divider=%u -> "
                     "safety margin %u bursts >= ring capacity %lu bursts); reduce RATE, "
                     "or attach a streaming client instead of buffered RECORD_START\n",
                     g_configured_rate_div, tm, (unsigned long)RING_BURST_SLOTS);
            return;
        }
        set_dma_en(1);
        uint32_t p = read_bursts_done();
        g_record_start  = p;
        g_consumer_pos  = p;
        g_have_last_capture = 0; // a new session invalidates the previous DUMP-able window
        g_mode = MODE_RECORDING;
        snprintf(reply, reply_sz, "OK RECORDING start=%u\n", p);

    } else if (strcmp(verb, "RECORD_STOP") == 0) {
        if (g_mode != MODE_RECORDING && g_mode != MODE_ARMED_CAPTURING) {
            snprintf(reply, reply_sz, "ERR not recording (mode=%s)\n", mode_name(g_mode));
            return;
        }
        mode_enter_idle(); // finalizes g_record_stop/g_have_last_capture (FR1.4)
        snprintf(reply, reply_sz, "OK stopped at=%u (DUMP <path> to save [%u,%u))\n",
                 g_record_stop, g_consumer_pos, g_record_stop);

    } else if (strcmp(verb, "ARM") == 0) {
        // ARM <pattern_hex> <mask_hex> [post_trigger_bursts]
        if (n < 3) {
            snprintf(reply, reply_sz, "ERR usage: ARM <pattern_hex> <mask_hex> [post_trigger_bursts]\n");
            return;
        }
        if (g_mode != MODE_IDLE) {
            snprintf(reply, reply_sz, "ERR busy (mode=%s)\n", mode_name(g_mode));
            return;
        }
        {
            uint32_t tm = theoretical_margin_bursts();
            if (tm >= RING_BURST_SLOTS) {
                snprintf(reply, reply_sz,
                         "ERR rate too high for buffered arm/capture (configured divider=%u -> "
                         "safety margin %u bursts >= ring capacity %lu bursts); reduce RATE, "
                         "or attach a streaming client instead\n",
                         g_configured_rate_div, tm, (unsigned long)RING_BURST_SLOTS);
                return;
            }
        }
        g_trigger.active  = 1;
        g_trigger.pattern = (uint32_t)a1;
        g_trigger.mask    = (uint32_t)a2;
        if (n >= 4) g_post_trigger_bursts = (uint32_t)a3;
        g_have_last_capture = 0; // a new arm cycle invalidates the previous DUMP-able window
        set_dma_en(1);
        g_mode = MODE_ARMED_SCANNING;
        fprintf(stderr, "[capture_ctrl] -> ARMED_SCANNING pattern=0x%08lX mask=0x%08lX post_trigger_bursts=%u\n",
                a1, a2, g_post_trigger_bursts);
        snprintf(reply, reply_sz, "OK ARMED_SCANNING\n");

    } else if (strcmp(verb, "DISARM") == 0) {
        if (g_mode != MODE_ARMED_SCANNING && g_mode != MODE_ARMED_CAPTURING) {
            snprintf(reply, reply_sz, "ERR not armed (mode=%s)\n", mode_name(g_mode));
            return;
        }
        g_trigger.active = 0;
        mode_enter_idle();
        snprintf(reply, reply_sz, "OK disarmed\n");

    } else if (strcmp(verb, "RATE") == 0) {
        // RATE <divider> -- DECIMAL, matching the ADC_GEN_DIV convention
        // used everywhere else in this project (52000, not 0xCB20). Parsed
        // separately from the generic hex-based a1/a2/a3 above, which is
        // only correct for ARM's pattern/mask.
        unsigned long rate_val;
        if (sscanf(cmd, "%*s %lu", &rate_val) != 1) {
            snprintf(reply, reply_sz, "ERR usage: RATE <divider_decimal>\n");
            return;
        }
        set_rate_div((uint32_t)rate_val);
        snprintf(reply, reply_sz, "OK rate_div=%lu\n", rate_val);

    } else if (strcmp(verb, "STATUS") == 0) {
        uint32_t p = read_bursts_done();
        uint32_t d = read_dropped_words();
        double lag_s = lag_budget_seconds(g_rate_est_bursts_per_sec);
        snprintf(reply, reply_sz,
                 "OK mode=%s producer_pos=%u consumer_pos=%u dropped_words=%u "
                 "dma_en=%d stream_client=%s rate_bursts_per_sec=%.1f lag_budget_sec=%.3f "
                 "dump_available=%s%s\n",
                 mode_name(g_mode), p, g_consumer_pos, d, dma_enabled,
                 g_stream_client_fd >= 0 ? "connected" : "none",
                 g_rate_est_bursts_per_sec, lag_s,
                 g_have_last_capture ? "yes" : "no",
                 g_have_last_capture ? "" : " (record/arm+trigger, then stop, before DUMP)");

    } else {
        snprintf(reply, reply_sz, "ERR unknown command\n");
    }
}

// ==========================================================================
// Streaming (FR2): send raw 32-bit tagged stream words to the connected
// client, in order, draining new bursts as bursts_done advances.
// ==========================================================================
static void stream_send_available(uint32_t producer_pos) {
    if (g_stream_client_fd < 0) return;

    // First data since this client connected: decide where to start.
    //   - RECORDING/ARMED_CAPTURING: catch up from the session's start /
    //     trigger-match position (FR2.1's "ring-buffer catch-up + live
    //     stream" -- the client should see the whole in-progress capture,
    //     not just what's produced after it happened to connect).
    //   - IDLE/ARMED_SCANNING: nothing meaningful has a "start" yet, so
    //     behave as a fresh live tail (FR2 standalone streaming) from now.
    if (!g_stream_consumer_init) {
        if (g_mode == MODE_RECORDING || g_mode == MODE_ARMED_CAPTURING) {
            g_stream_consumer = g_consumer_pos;
        } else {
            g_stream_consumer = producer_pos;
        }
        g_stream_consumer_init = 1;
    }

    uint32_t words[32];
    while (g_stream_consumer != producer_pos) {
        read_burst(g_stream_consumer, words);
        ssize_t want = (ssize_t)sizeof(words);
        ssize_t got = send(g_stream_client_fd, words, (size_t)want, MSG_NOSIGNAL);
        if (got != want) {
            // Client fell behind / disconnected -- drop it (FR2.4: revert
            // to the normal stop-on-full behavior for whatever mode is
            // active; we do not retry indefinitely).
            fprintf(stderr, "[capture_ctrl] stream client disconnected/stalled, dropping\n");
            close(g_stream_client_fd);
            g_stream_client_fd = -1;
            g_stream_consumer_init = 0;
            // Safety fix: if dma_en was only ever turned on because this
            // client connected while IDLE (a pure live-tail session with
            // no manual/armed session under it), turn it back off now --
            // otherwise the ring keeps free-running unattended forever
            // with nobody watching (violates NFR1's spirit).
            if (g_stream_was_live_tail && g_mode == MODE_IDLE) {
                fprintf(stderr, "[capture_ctrl] live-tail client gone, re-idling (dma_en=0)\n");
                mode_enter_idle();
            }
            g_stream_was_live_tail = 0;
            return;
        }
        g_stream_consumer++;
        // FR2.2: a connected, keeping-up client IS a consumer -- advance
        // the shared consumer_pos to track it (only ever forward) so the
        // ring-full stop-on-full check (FR1.3/FR3.5) sees this data as
        // "safely consumed" and never triggers while streaming keeps up,
        // regardless of which mode is active.
        g_consumer_pos = g_stream_consumer;
    }
}

// ==========================================================================
// Main policy tick: called periodically. Implements FR1.3/FR3.3-3.5's
// stop-on-full and trigger-scan logic. One function, all modes, per
// FR5.3's "one model, not three state machines" requirement.
// ==========================================================================

// Poll tick interval (matches the ~50Hz select() timeout in main()).
#define POLL_INTERVAL_SEC 0.02

// The stop-on-full safety margin MUST be rate-aware: at a fixed small
// margin, a high enough burst rate can advance producer_pos by far more
// than the margin within a single poll tick, overshooting past a full
// ring wrap before policy_tick() ever notices (found by WSL dynamic
// testing at a fast simulated rate -- at real full hardware rate
// (~2,000,000 bursts/sec), up to ~40,000 bursts can occur in one 20ms
// tick against a ring of only 65,536 slots, which a fixed margin of 4
// does not remotely cover). Scale the margin to comfortably exceed one
// poll tick's worth of bursts at the current observed rate, with a
// generous safety factor for scheduling jitter, floored at a small
// constant for the low/unknown-rate case.
static uint32_t safety_margin_bursts(void) {
    const uint32_t floor_margin = 4;
    const double safety_factor = 4.0; // headroom for scheduling jitter
    double rate_based = g_rate_est_bursts_per_sec * POLL_INTERVAL_SEC * safety_factor;
    uint32_t m = (uint32_t)rate_based;
    return m > floor_margin ? m : floor_margin;
}

// adc_clk is exactly 65 MHz (hdmi/pll_65m.v: 50MHz*13/10); each generator
// tick produces one 32-bit tagged word carrying BOTH channels (DUAL mode),
// and one burst packs BURST_BEATS(16) beats * 2 words/beat (see
// read_burst()'s w_lo/w_hi split) = 32 ticks' worth of data.
#define ADC_CLK_HZ         65000000.0
#define TICKS_PER_BURST    32.0

// Deterministic counterpart to safety_margin_bursts(): computed from the
// CONFIGURED divider (known immediately) rather than the empirical rate
// estimate (which lags -- see set_rate_div()'s comment). Used only as a
// pre-flight check so RECORD_START/ARM can reject a rate that's fundamentally
// too fast for this ring size (RING_BURST_SLOTS) and poll interval to safely
// auto-stop, instead of silently entering the mode and auto-stopping again
// within about one tick with little to no captured data -- a real, confusing
// failure mode discovered at the true full ADC rate (divider=1): the
// computed safety margin (~162,500 bursts) alone already exceeds the entire
// 65,536-slot ring, so RECORDING/ARMED_CAPTURING could never stay up long
// enough to capture anything meaningful at that rate.
static uint32_t theoretical_margin_bursts(void) {
    double bursts_per_sec = ADC_CLK_HZ / ((double)g_configured_rate_div * TICKS_PER_BURST);
    double rate_based = bursts_per_sec * POLL_INTERVAL_SEC * 4.0; // same safety_factor as safety_margin_bursts()
    return (uint32_t)rate_based;
}

static void policy_tick(void) {
    uint32_t producer_pos = read_bursts_done();
    update_rate_estimate(producer_pos);

    switch (g_mode) {
    case MODE_IDLE:
        break;

    case MODE_RECORDING: {
        // FR2.2: use consumer_pos (not the frozen record_start) so an
        // actively-draining stream client keeps pushing this floor
        // forward and the ring never reports "full" while it keeps up --
        // consumer_pos only equals record_start for as long as nothing is
        // streaming.
        uint32_t used = producer_pos - g_consumer_pos; // wraps correctly (uint32_t)
        // FR1.3: stop before the ring wraps back over unread data. Margin
        // is rate-aware (see safety_margin_bursts()) so a poll tick can
        // never let producer lap consumer between checks, at any rate.
        uint32_t margin = safety_margin_bursts();
        if (used + margin >= RING_BURST_SLOTS) {
            fprintf(stderr, "[capture_ctrl] RECORDING: ring full (used=%u/%lu, margin=%u), stopping\n",
                    used, (unsigned long)RING_BURST_SLOTS, margin);
            mode_enter_idle();
        }
        break;
    }

    case MODE_ARMED_SCANNING: {
        // Scan whatever has newly arrived since we last looked.
        static uint32_t scan_pos = 0;
        static int scan_pos_init = 0;
        if (!scan_pos_init) { scan_pos = producer_pos; scan_pos_init = 1; }

        uint32_t words[32];
        while (scan_pos != producer_pos) {
            read_burst(scan_pos, words);
            int matched = 0;
            for (int i = 0; i < 32 && !matched; i++) {
                if (!word_looks_valid(words[i])) continue; // skip structurally bad words
                if (trigger_match(&g_trigger, words[i])) matched = 1;
            }
            scan_pos++;
            if (matched) {
                g_trigger_match_pos = scan_pos; // capture begins just after the match
                g_consumer_pos = g_trigger_match_pos;
                g_mode = MODE_ARMED_CAPTURING;
                fprintf(stderr, "[capture_ctrl] TRIGGER matched at burst %u -> ARMED_CAPTURING "
                        "(lag_budget=%.3fs at current rate %.1f bursts/sec)\n",
                        g_trigger_match_pos, lag_budget_seconds(g_rate_est_bursts_per_sec),
                        g_rate_est_bursts_per_sec);
                scan_pos_init = 0; // reset static for next arm cycle
                break;
            }
        }
        break;
    }

    case MODE_ARMED_CAPTURING: {
        // Post-trigger LENGTH is a deliberate, fixed recording duration
        // setting ("how much to keep after the trigger") -- it is NOT a
        // ring-capacity concept, so it always measures from the fixed
        // g_trigger_match_pos, streaming or not.
        uint32_t post_used = producer_pos - g_trigger_match_pos;
        if (post_used >= g_post_trigger_bursts) {
            fprintf(stderr, "[capture_ctrl] ARMED_CAPTURING: post-trigger length reached (used=%u), stopping\n",
                    post_used);
            mode_enter_idle();
            break;
        }
        // Ring-full guard (in case post_trigger_bursts was configured
        // larger than the ring itself): same FR2.2 fix as MODE_RECORDING --
        // measure from consumer_pos, which an actively-draining stream
        // client keeps advancing, so this never falsely triggers while
        // streaming keeps up. Margin is rate-aware, same as MODE_RECORDING.
        uint32_t ring_used = producer_pos - g_consumer_pos;
        uint32_t margin = safety_margin_bursts();
        if (ring_used + margin >= RING_BURST_SLOTS) {
            fprintf(stderr, "[capture_ctrl] ARMED_CAPTURING: ring full before post-trigger length reached, stopping\n");
            mode_enter_idle();
        }
        break;
    }
    }

    // FR2: stream whatever's new to a connected client, regardless of mode
    // (a client can attach during any session -- FR2.3).
    stream_send_available(producer_pos);
}

// ==========================================================================
// Socket plumbing
// ==========================================================================
static int make_control_listener(void) {
    unlink(CONTROL_SOCK_PATH);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket(AF_UNIX)"); exit(1); }
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, CONTROL_SOCK_PATH, sizeof(addr.sun_path) - 1);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { perror("bind(control)"); exit(1); }
    if (listen(fd, 4) < 0) { perror("listen(control)"); exit(1); }
    return fd;
}

static int make_stream_listener(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket(AF_INET)"); exit(1); }
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((uint16_t)port);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { perror("bind(stream)"); exit(1); }
    if (listen(fd, 1) < 0) { perror("listen(stream)"); exit(1); }
    return fd;
}

static volatile sig_atomic_t g_shutdown = 0;
static void on_sigterm(int sig) { (void)sig; g_shutdown = 1; }

int main(int argc, char **argv) {
    int stream_port = DEFAULT_STREAM_PORT;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--stream-port") == 0 && i + 1 < argc) {
            stream_port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--sim") == 0) {
            g_sim_mode = 1;
        } else if (strcmp(argv[i], "--sim-rate") == 0 && i + 1 < argc) {
            sim_bursts_per_real_second = (uint32_t)atoi(argv[++i]);
        }
    }

    signal(SIGINT, on_sigterm);
    signal(SIGTERM, on_sigterm);
    signal(SIGPIPE, SIG_IGN); // a dropped stream client must not kill the daemon

    if (g_sim_mode) {
        // Plain heap memory standing in for the GP register page and the
        // ring -- no /dev/mem, no physical addresses, runs anywhere
        // (including a WSL/Linux host with no board). See
        // diagrams/phase1_requirements.md's WSL test-harness section.
        static uint32_t sim_gp_backing[GP_PAGE_SIZE / 4];
        gp_map = sim_gp_backing;
        ring_map = (volatile uint64_t *)calloc(RING_WORDS, sizeof(uint64_t));
        if (!ring_map) { perror("calloc ring (sim)"); return 1; }
        fprintf(stderr, "[capture_ctrl] --sim mode: mock hardware backend, no /dev/mem\n");
    } else {
        int fd = open("/dev/mem", O_RDWR | O_SYNC);
        if (fd < 0) { perror("open /dev/mem"); return 1; }

        gp_map = (volatile uint32_t *)mmap(NULL, GP_PAGE_SIZE, PROT_READ | PROT_WRITE,
                                            MAP_SHARED, fd, GP_PAGE_BASE);
        if (gp_map == MAP_FAILED) { perror("mmap gp"); return 1; }

        ring_map = (volatile uint64_t *)mmap(NULL, RING_BYTES, PROT_READ,
                                              MAP_SHARED, fd, RING_BASE_PHYS);
        if (ring_map == MAP_FAILED) { perror("mmap ring"); return 1; }
    }

    // NFR1: start safe -- DMA explicitly disabled at daemon startup,
    // regardless of whatever state gp_out happened to be left in.
    mode_enter_idle();

    int ctrl_listen_fd   = make_control_listener();
    int stream_listen_fd = make_stream_listener(stream_port);

    fprintf(stderr, "[capture_ctrl] ready. control=%s stream_port=%d ring=0x%08lX (%lu MiB)\n",
            CONTROL_SOCK_PATH, stream_port, RING_BASE_PHYS, (unsigned long)(RING_BYTES / (1024 * 1024)));

    double last_tick = now_sec();
    while (!g_shutdown) {
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(ctrl_listen_fd, &rfds);
        FD_SET(stream_listen_fd, &rfds);
        int maxfd = ctrl_listen_fd > stream_listen_fd ? ctrl_listen_fd : stream_listen_fd;

        struct timeval tv = { 0, 20000 }; // 20ms poll tick -- see policy_tick's stop-on-full margin
        int r = select(maxfd + 1, &rfds, NULL, NULL, &tv);
        if (r < 0) {
            if (errno == EINTR) continue;
            perror("select");
            break;
        }

        if (r > 0 && FD_ISSET(ctrl_listen_fd, &rfds)) {
            int cfd = accept(ctrl_listen_fd, NULL, NULL);
            if (cfd >= 0) {
                char buf[128] = {0};
                ssize_t rn = read(cfd, buf, sizeof(buf) - 1);
                if (rn > 0) {
                    buf[rn] = 0;
                    char *nl = strpbrk(buf, "\r\n");
                    if (nl) *nl = 0;
                    char reply[320];
                    handle_command(buf, reply, sizeof(reply));
                    ssize_t wn = write(cfd, reply, strlen(reply));
                    (void)wn; // best-effort reply; client dropping early is not fatal
                }
                close(cfd);
            }
        }

        if (r > 0 && FD_ISSET(stream_listen_fd, &rfds)) {
            int cfd = accept(stream_listen_fd, NULL, NULL);
            if (cfd >= 0) {
                if (g_stream_client_fd >= 0) {
                    // Phase 1: one client at a time -- reject a second.
                    close(cfd);
                } else {
                    int one = 1;
                    setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
                    g_stream_client_fd = cfd;
                    g_stream_consumer_init = 0; // stream_send_available() sets the start point (FR2.1/FR2 fresh-tail)
                    g_stream_was_live_tail = (g_mode == MODE_IDLE);
                    if (g_mode == MODE_IDLE) set_dma_en(1); // FR2 standalone live tail
                    fprintf(stderr, "[capture_ctrl] stream client connected (mode=%s)\n", mode_name(g_mode));
                }
            }
        }

        double t = now_sec();
        if (t - last_tick >= 0.02) { // ~50Hz, matches the select() timeout above
            if (g_sim_mode) sim_hardware_tick();
            policy_tick();
            last_tick = t;
        }
    }

    fprintf(stderr, "[capture_ctrl] shutting down, forcing dma_en=0\n");
    mode_enter_idle(); // NFR1: never leave the DMA running unattended; also
                        // finalizes a DUMP-able window if one was in progress
    if (g_stream_client_fd >= 0) close(g_stream_client_fd);
    close(ctrl_listen_fd);
    close(stream_listen_fd);
    unlink(CONTROL_SOCK_PATH);
    return 0;
}
