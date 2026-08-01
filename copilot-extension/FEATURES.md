# Local Copilot — Features & Usage Guide

A Copilot-like chat assistant for VS Code with local command execution. Chat with AI models
(Ollama, LM Studio, JAN AI, OpenAI-compatible endpoints, GitHub Copilot, or the VS Code LM API),
let the model run commands, read/write files, search your workspace, and ask you questions —
all from the activity-bar chat panel.

---

## Quick Start

1. Build the extension from `copilot-extension/`:
   ```
   npm install
   npm run compile
   ```
2. Copy `out/**` and `package.json` into the installed extension folder
   (`~/.vscode/extensions/local-dev.local-copilot`) and run **Developer: Reload Window**.
3. Open the **Local Copilot** chat from the activity bar (or Command Palette →
   `Local Copilot: Open Chat`).
4. Make sure your provider is running (e.g. `ollama serve`) and start chatting.

---

## Providers

Providers are **freely extensible**. Built-in defaults:

| Provider | Type | Default endpoint |
|----------|------|------------------|
| Ollama (Local) | `ollama` | `http://127.0.0.1:11434` |
| LM Studio (Local) | `openai` | `http://127.0.0.1:1234/v1` |
| JAN AI (Local) | `openai` | `http://127.0.0.1:1337/v1` |
| OpenAI | `openai` | `https://api.openai.com/v1` |
| GitHub Copilot | `copilot-web` | — (uses installed Copilot extension) |
| VS Code LM API | `vscode-lm` | — (uses VS Code model providers) |

### Adding / editing / removing providers

Click the **⚙** button in the chat header to open Settings. The **Providers** section lists every
configured provider as an editable block:

- **ID** — unique key used to reference the provider (e.g. `my-gpu-server`).
- **Label** — display name shown in the provider dropdown.
- **Type** — connection protocol:
  - **Ollama compatible** — talks to `/api/chat`.
  - **OpenAI compatible** — talks to `<endpoint>/chat/completions`; an API key is optional and is
    only sent if you provide one.
  - **GitHub Copilot** — uses your installed Copilot extension.
  - **VS Code LM** — uses VS Code's model API (model IDs auto-discovered).
- **Endpoint** — base URL (hidden for Copilot).
- **Model** — model name; leave empty where the server auto-selects the loaded model.
- **API Key** — only shown for OpenAI-compatible providers.

Use **+ Add provider** to create new entries and **🗑** to delete. The last remaining provider cannot
be deleted. Fields show/hide depending on the selected type.

> Provider/endpoint/model/API-key fields are stored in the config file
> (`~/.vscode/extensions/local-copilot/config.json`), not in `settings.json`. The config file is the
> source of truth; VS Code settings only act as fallbacks.

---

## Configuration

### Settings modal (⚙)

- **Active Provider** — which provider receives messages.
- **Approval Mode** — how commands are approved (see below).
- **System Prompt** — the base prompt sent with every message; leave empty for the default.

### Config file

`~/.vscode/extensions/local-copilot/config.json` (Windows:
`C:\Users\<you>\.vscode\extensions\local-copilot\config.json`).

- Use **Command Palette → `Local Copilot: Open Config File`** to edit it directly.
- Any provider with a missing `type`/`label` is normalized on load; legacy `vscodeLm` keys are
  migrated automatically.

### VS Code settings (legacy fallbacks)

Search `local-copilot` in Settings (`Ctrl+,`): `aiProvider`, `ollamaEndpoint`/`ollamaModel`,
`lmstudioEndpoint`/`lmstudioModel`, `janaiEndpoint`/`janaiModel`, `openaiApiKey`/`openaiModel`/
`openaiEndpoint`, `vscodeLmModel`, `systemPrompt`.

---

## Chat Features

- **Streaming responses** — text appears as it is generated; a **Stop** button cancels generation.
- **Thinking/reasoning display** — toggle with the **🧠** button; reasoning is streamed when the
  model exposes it.
- **Image support** — paste/screenshot an image into the input box. If the selected model does not
  support vision, the extension automatically retries with text only and warns you.
- **Context stats** — each assistant message shows token count and (for Ollama) context usage as a
  percentage of the model's context window.
- **Auto-compression** — long histories are summarized automatically; use **Compress** to force it.
- **Clear chat** — resets the current conversation.

### Sessions

- **+ New** creates a session, **Save** persists it, the dropdown loads saved sessions,
  **🗑** deletes.
- Sessions are auto-named by timestamp and auto-renamed to a short title after the first message.
- Saved sessions restore their full history.

### Memories

- `/memorize` — extract key context from the conversation into **session** memory.
- `/memorize_global` — extract key context into **global** memory (across all sessions).
- Memories are injected into every subsequent request as `[Memory]` / `[Global Memory]`.

### Approval modes

| Mode | Behavior |
|------|----------|
| **Auto: Safe Only** | Safe commands run without asking; potentially destructive commands require approval |
| **Auto: All** | All commands run without asking |
| **Always Ask** | Every command requires explicit approval |

Approval prompts show the command and **Approve / Deny** buttons.

---

## Tool Markers

The model drives tools by emitting markers in its response. The agentic loop runs repeatedly until
the model produces a final answer.

| Marker | Purpose |
|--------|---------|
| `[CMD]command[/CMD]` | Run a shell command; output is returned in `[OUTPUT]...[/OUTPUT]` or `[ERROR]...[/ERROR]` |
| `[ASK]question[/ASK]` | Ask you a question; chat pauses for your typed answer |
| `[CHOICES]a\|b\|c[/CHOICES]` | Offer clickable choices; a `Custom...` free-text box is **always** auto-added |
| `[READ]path[/READ]` | Read a file (absolute or workspace-relative); contents come back in `[OUTPUT]` |
| `[WRITE]path\ncontent[/WRITE]` | Create or overwrite a file (first line = path, rest = content) |
| `[SEARCH]pattern[/SEARCH]` | Regex search across workspace file contents |
| `[FILES]**\/*.ts[/FILES]` | List files matching a glob (`**` for recursive) |

> The model is instructed never to add its own "Custom"/"Other" choice option, because the
> `Custom...` button is always appended automatically.

### Clickable links

Any web link (`https://…`) or file path (absolute, workspace-relative, or with a known file
extension) in a response is turned into a clickable link with an **open** badge:

- **Web link** → opens in your default browser.
- **File path** → opens the file in VS Code (relative paths are resolved against the workspace root).

---

## Commands (Command Palette)

| Command | What it does |
|---------|--------------|
| `Local Copilot: Open Chat` | Open the chat panel |
| `Local Copilot: Run Selected Command in Terminal` | Run the highlighted text in a terminal |
| `Local Copilot: Configure Ollama for Network Access (bind 0.0.0.0)` | Helper to let Ollama listen on all interfaces |
| `Local Copilot: Toggle Thinking Display` | Turn reasoning display on/off |
| `Local Copilot: Open Config File` | Open `config.json` in the editor |

---

## Benchmarking

- **Benchmark** — runs a predefined task (`benchmark-task.json`) against the current model and
  writes the result to `benchmark/result-*.json`.
- **Batch** — discovers models from all providers and runs every `benchmark-inputs/*` task against
  each model; `tries` controls runs per model. Writes individual results and a combined
  `benchmark/batch-report-*.md`.

---

## Storage Locations (Windows)

| Item | Path |
|------|------|
| Config file | `~\.vscode\extensions\local-copilot\config.json` |
| Sessions | `~\.vscode\extensions\local-copilot\sessions\` |
| Logs | `~\.vscode\extensions\local-copilot\logs\` |
| Benchmark results | `<extension root>\benchmark\` |
| Benchmark inputs | `<extension root>\benchmark-inputs\` |

---

## Troubleshooting

- **No response / connection refused** — verify the server is running and the endpoint in ⚙
  Settings matches (e.g. Ollama on `http://127.0.0.1:11434`).
- **OpenAI error about API key** — add it in ⚙ Settings (OpenAI provider → API Key).
- **"does not support image input"** — expected when the active model lacks vision; the message
  tells you the image was stripped and only text was sent.
- **GPU/VRAM out of memory (`cudaMalloc failed`)** — the model is too large for your GPU; pick a
  smaller model.
- **Changes not appearing** — after rebuilding, copy `out/**` + `package.json` into
  `~/.vscode/extensions/local-dev.local-copilot`, then run **Developer: Reload Window**.
- **No model listed** — use **Batch** or the provider's model dropdown; for VS Code LM, install a
  model provider extension (e.g. GitHub Copilot) and sign in.
