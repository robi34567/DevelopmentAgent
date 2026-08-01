# Architecture: Maggot

## Overview

Maggot is a local, agentic coding assistant. The same model-handling/agent engine powers three frontends:

- **Maggot chat** — VS Code extension (the current `local-copilot` product, rebranded).
- **Maggot CLI** — a terminal REPL (no `vscode-lm`, no VS Code).
- **Maggot webUI** — a self-hosted web UI (no `vscode-lm`).

All frontends share one core: **Maggot Agent Engine** (pure TypeScript/Node, zero `vscode` imports).

---

## 1. Target Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  MAGGO T AGENT ENGINE  (copilot-extension/src/core)          │
│                                                             │
│  - AgentEngine: agentic loop ([CMD]/[READ]/[WRITE]/[SEARCH]  │
│    /[FILES]/[ASK]/[CHOICES]), emits EngineEvent async iterable│
│  - ToolExecutor: safe/dangerous command classification,      │
│    approval modes (safe/auto/ask), file read/write/search    │
│  - Provider registry + HTTP-only providers (ollama, openai,  │
│    lmstudio, janai)                                          │
│  - SessionStore + memory/compression                         │
│  - Pure Node config (shared config.json format)              │
│  - EngineEvent types: assistantDelta, finalize, toolStart,   │
│    toolOutput, ask, choices, choiceResult, error             │
└───────────────┬─────────────────────────────────────────────┘
                │
   ┌────────────┼─────────────────┐
   ▼            ▼                 ▼
Maggot chat   Maggot CLI      Maggot webUI
(VS Code)     (readline REPL) (Node server + WebSocket)
   │            │                 │
   │  transport shim (postMessage ↔ EngineEvent)
   │  vscode-lm + GitHub Copilot providers registered HERE (VS Code-only)
   ▼            ▼                 ▼
 shared config.json / sessions / logs (%USERPROFILE%\.vscode\extensions\local-copilot\)
```

Key properties:

- `core/` contains **no `vscode` import** — it runs in Node with only `http`/`https`/`fs`/`path`/`os`.
- The VS Code adapter (`src/aiProvider.ts`, `src/config.ts`) registers `vscode-lm` and GitHub Copilot providers and reroutes config fallbacks; the engine is otherwise identical across frontends.
- Config, sessions, and logs share one on-disk format (`config.json`, `sessions/{id}.json`, `logs/YYYY-MM-DD.log`) so switching frontends is seamless. Web adds token auth on top; CLI uses plain text.

### Engine construction

```typescript
const engine = createEngine(config, {
    sessionStore,      // load/save session JSON
    logger?,           // optional logger
    envHooks?,         // openLink, openFile, terminal display
});
for await (const evt of engine.stream('user message')) { /* handle EngineEvent */ }
```

### EngineEvent

| Event | Payload | Meaning |
|-------|---------|---------|
| `assistantDelta` | `{ text }` | streaming assistant text |
| `finalize` | `{ content, stats }` | assistant message finished |
| `toolStart` | `{ name, args }` | about to run a tool (e.g. `[CMD]`) |
| `toolOutput` | `{ name, output }` | tool result (`[OUTPUT]`/`[ERROR]`) |
| `ask` | `{ question }` | model asked the user (`[ASK]`) |
| `choices` | `{ options }` | model offered choices (`[CHOICES]`) |
| `choiceResult` | `{ selected }` | user's selection |
| `error` | `{ message }` | error, loop aborts |

---

## 2. Provider System

### Interface (`core/types.ts`)

```typescript
export interface AIProvider {
    sendMessage(messages, onChunk): Promise<{ content, stats, thinking? }>;
    abort(): void;
}
```

### Pure HTTP providers (core, no vscode)

- `OllamaProvider` — NDJSON (`readStream`).
- `OpenAIProvider`, `LMStudioProvider`, `JanAIProvider` — SSE (`readSSEStream`).
- `createCoreProvider(type, modelOverride?)` — factory for the pure providers.

### VS Code-only providers (registered in the VS Code adapter)

- `VSCodeLMProvider` — `vscode.lm.selectChatModels()` / `LanguageModelChat`.
- `CopilotWebProvider` — `GitHub.copilot` extension `getChatCompletions`.

The adapter's `createAIProvider(type, modelOverride?)` keeps the same signature as today and delegates non-`vscode-lm`/non-`copilot-web` types to `createCoreProvider`.

### Config access

`core/config.ts` reads/writes `config.json` only. The VS Code adapter adds `vscode.workspace.getConfiguration('local-copilot')` values as fallbacks, preserving today's precedence (file wins, settings fill gaps).

---

## 3. Session Management

Unchanged on-disk model:

```typescript
interface Session {
    id: string;
    name: string;
    timestamp: string;
    chatHistory: ChatMessage[];
    chatHtml: string;          // VS Code chat only; other frontends render their own
    model: string;
    provider: string;
    approvalMode: string;
    compressedHistories: string[];
}
```

`SessionStore` in core owns load/save/delete/list. `chatHtml` snapshots are VS Code-specific and ignored by CLI/web.

---

## 4. Agentic Loop

Moved into `core/AgentEngine`. Up to `MAX_TOOL_ROUNDS` (10) iterations:

1. Build messages (system prompt + history).
2. `provider.sendMessage` — chunks streamed as `assistantDelta`.
3. Parse `[CMD]`, `[READ]`, `[WRITE]`, `[SEARCH]`, `[FILES]`, `[ASK]`, `[CHOICES]`.
4. No tool tags → `finalize`, exit.
5. Tools run via `ToolExecutor` after approval; results wrapped in `[OUTPUT]`/`[ERROR]`, appended as a user message, loop back.

### Approval modes

- **all**: auto-execute every command.
- **safe**: auto-execute whitelisted commands only, ask for others.
- **ask**: always prompt.

Dangerous commands (regex patterns) are flagged in the approval prompt.

### Memory / compression

Unchanged: `COMPRESSION_THRESHOLD_CHARS` (30,000), `compressChatHistory()` in core, results persisted in `compressedHistories`.

---

## 5. Frontend Adapters

### Maggot chat (VS Code extension)

- `src/extension.ts` — activation, sessions, webview wiring. Replaced by a thin host that drives the engine and forwards `EngineEvent`s to `main.js` via `postMessage`.
- `src/main.js` — webview client. Only VS Code coupling is `acquireVsCodeApi()` + `postMessage`; a transport shim maps messages to `EngineEvent`.
- `src/config.ts`, `src/aiProvider.ts` — adapters adding `vscode` fallbacks + `vscode-lm`/Copilot providers.

### Maggot CLI

- Node `readline` REPL (`src/cli.ts`, `npm run cli`). No webview; renders `assistantDelta` to stdout, prompts for approvals/choices/asks, uses `process.cwd()` as the workspace root.
- Uses pure providers + `core/config.ts` (no VS Code settings fallback). Redirects engine `console.*` debug output to `logs/cli-*.log` so stdout stays clean for the REPL.
- `/provider` persists the new `aiProvider` to the shared `config.json` (same behavior as the VS Code UI), so `changeModel` resolves the provider from the active config.
- VS Code-only providers (`copilot-web`, `vscode-lm`) are rejected with a hint to switch provider.

### Maggot webUI

- Node `http` server + WebSocket (`webui/server.js`, `ws` package). Serves the same `main.js` UI
  via a transport shim (`webui/static/shim.js`) that provides `acquireVsCodeApi()` over WebSocket
  and a fallback `--vscode-*` theme so the panel looks like VS Code.
- Reuses the shared HTML template: `webview.ts` lazily `require('vscode')` only inside
  `getWebviewContent`, and exports `getWebUiPageHtml()` that is vscode-free.
- One shared `AgentEngine`; events are broadcast to all connected clients. Approval requests go to
  all clients and the first response wins.
- Localhost only, no auth (binds `127.0.0.1`). Run: `npm run webui` (from `webui/`) or
  `node webui/server.js [port] [workspace-root]`.

---

## 6. File Layout (target)

```
copilot-extension/
  package.json                   # Maggot chat manifest (VS Code schema)
  tsconfig.json
  src/
    core/                        # Maggot Agent Engine (pure TS/Node, no vscode)
      types.ts                   # ChatMessage, AIProvider, EngineEvent, Session, ...
      config.ts                  # config.json load/save, provider config
      providers.ts               # pure HTTP providers + createCoreProvider
      engine.ts                  # AgentEngine (agentic loop) + EngineEvent stream
      tools.ts                   # ToolExecutor (commands, files, search, approval)
      session.ts                 # SessionStore, memory/compression
    config.ts                    # VS Code adapter over core/config.ts
    aiProvider.ts                # VS Code adapter: VSCodeLM + Copilot providers
    cli.ts                       # Maggot CLI REPL (readline on the engine, no vscode)
    extension.ts                 # Maggot chat host (engine + webview wiring)
    webview.ts                   # HTML/CSS template (lazy vscode; also serves webUI via getWebUiPageHtml)
    main.js                      # shared frontend JS (webview / web transport shim)
  out/                           # compiled output
  webui/
    package.json                 # maggot-webui (dependency: ws)
    server.js                    # http + WebSocket server on the shared engine
    static/shim.js               # acquireVsCodeApi() transport shim for the browser
```

CLI and webUI live in sibling packages that `tsc` the `core/` sources directly.

---

## 7. Naming

| Product | Old name | New name |
|---------|----------|----------|
| VS Code extension | Local Copilot | Maggot chat |
| CLI | — | Maggot CLI |
| Web UI | — | Maggot webUI |
| Engine | — | Maggot Agent Engine |

`package.json` `displayName`, extension view titles, and UI copy migrate to "Maggot". Console/log prefixes become `[Maggot]`. The on-disk data directory and `config.json` format are **not** renamed (compatibility).

---

## 8. Migration Plan

1. **Core foundation (this commit):** extract `core/types.ts`, `core/config.ts`, `core/providers.ts`; `src/config.ts` and `src/aiProvider.ts` become thin adapters. Behavior identical, extension still compiles and runs.
2. **Agent engine:** move the agentic loop, tool executors, session store, memory, and approval logic into `core/engine.ts` / `core/tools.ts` / `core/session.ts`; `extension.ts` drives the engine.
3. **Maggot chat rename:** update `package.json`, webview copy, log prefixes.
4. **Maggot CLI (done):** `readline` REPL on the engine (`src/cli.ts`, `npm run cli`).
5. **Maggot webUI (done):** Node server + WebSocket + transport shim (`webui/`). Fixed a pre-existing
   engine bug along the way: `sendMessage` no longer wedges `isProcessing` when provider creation fails.
6. **Docs:** update FEATURES.md and this file as each step lands.

---

## 9. Build & Deploy (VS Code)

```powershell
npm run compile                # tsc -p ./ + copy src\main.js out\main.js
.\install.ps1                  # copy out/ + package.json (UTF-8, NO BOM)
# full VS Code restart
```

**Important:** never write `package.json` or TypeScript/JSON sources with a UTF-8 BOM — VS Code rejects `package.json` with a BOM (icon disappears).

---

## 10. Security (unchanged)

- `makeRequest()`: IPv4 only, 30s timeout, HTTP/HTTPS auto-detection, `rejectUnauthorized: false` for self-signed local HTTPS.
- Command approval: safe whitelist / dangerous regex / neutral; approval mode gates execution.
- `abort()`: every provider supports cancellation via `AbortController`; stop handler denies pending approvals.
- Web UI adds token auth; CLI is local-only.
