# Architecture: Local Copilot VS Code Extension

## Overview

A VS Code extension providing a Copilot-like AI chat sidebar/panel with local command execution. The model communicates via an **agentic loop**: it outputs `[CMD]...[/CMD]` blocks which the extension executes and feeds back as context.

---

## 1. Communication Architecture

```
main.js (webview)  <--postMessage-->  extension.ts (host)  <--HTTP/VS Code API-->  AI Provider
```

- **`extension.ts`** is the host process — owns session state, provider lifecycle, command execution, and logging.
- **`main.js`** is the frontend running inside a VS Code webview — renders chat UI, captures user input, sends/receives typed messages.
- **`webview.ts`** generates the HTML/CSS template; the compiled `main.js` is injected as a script.
- Messages are JSON with a `type` field (e.g. `sendMessage`, `changeProvider`, `modelList`).

---

## 2. Provider System (Key Design Element)

### Interface (`aiProvider.ts:18-21`)

```typescript
export interface AIProvider {
    sendMessage(messages, onChunk): Promise<{ content, stats }>;
    abort(): void;
}
```

Every provider implements this interface. The `stats` field carries `tokenCount`, `durationMs`, `tokensPerSec`, and optionally `promptEvalCount` / `contextSize`.

### Factory pattern (`aiProvider.ts:493-509`)

`createAIProvider(type, modelOverride?)` is a switch-based factory. Each provider is instantiated from its config settings.

### Two streaming wire formats

| Format | Parser | Provider | Data format |
|--------|--------|----------|-------------|
| NDJSON (Ollama) | `readStream()` (lines 73-166) | Ollama | `{"message":{"content":"..."},"done":true/false}` |
| SSE (OpenAI-compat) | `readSSEStream()` (lines 168-246) | LM Studio, JAN AI, OpenAI | `data: {"choices":[{"delta":{"content":"..."}}]}` |

The SSE parser also captures `usage.prompt_tokens` / `usage.completion_tokens` from the final chunk.

### Provider categories

- **Local model servers** (Ollama, LM Studio, JAN AI): HTTP to localhost, list models via API, require no auth.
- **Remote API** (OpenAI): HTTPS to cloud, requires API key.
- **Extension-based** (GitHub Copilot): Uses VS Code extension API (`getChatCompletions`).

### Pattern for adding a new local provider

Local providers that speak OpenAI-compatible SSE need changes in **5 files**:

| Step | File | What to change |
|------|------|----------------|
| 1 | `package.json` | Add name to `aiProvider` enum; add `*Endpoint` + `*Model` config properties |
| 2 | `src/aiProvider.ts` | Create class implementing `AIProvider`; add `case` to factory |
| 3 | `src/extension.ts` | Add `fetch*Models()`; update `handleFetchModels`, `handleChangeModel`, `fetchModelContextSize`, `ensureProvider`; update both webview startup guards |
| 4 | `src/webview.ts` | Add `<option>` to the provider `<select>` |
| 5 | `src/main.js` | Add provider name to every `if (ollama || lmstudio)` guard (6 occurrences) |

---

## 3. Session Management (`extension.ts:46-315`)

### Storage
Sessions are JSON files at `%USERPROFILE%\.vscode\extensions\local-copilot\sessions\{id}.json`.

### Session data model
```typescript
interface Session {
    id: string;
    name: string;
    timestamp: string;
    chatHistory: ChatMessage[];
    chatHtml: string;       // snapshot of rendered HTML for restoring UI
    model: string;
    provider: string;
    approvalMode: string;
}
```

### Lifecycle
- `activate()` restores the last active session or creates a new one.
- `handleNewSession()` saves the current session (if any), clears state, creates a fresh session.
- `handleSaveSession()` persists the current chat history.
- `handleLoadSession(id)` saves the current session, then loads the target one — including restoring the correct provider and model.
- `handleDeleteSession(id)` removes the file; if it's the active session, a new one is created.

### Active session ID persistence
The active session ID is stored in `workspaceState` (VS Code's global state key-value store), so it survives extension reloads.

---

## 4. Agentic Loop (`extension.ts:769-913`)

`handleSendMessage()` runs up to `MAX_TOOL_ROUNDS` (10) iterations:

```
1.  Build messages[] with system prompt + chat history
2.  Call provider.sendMessage(messages, onChunk) — chunks streamed to webview in real-time
3.  Extract [CMD]...[/CMD] blocks from the full response
4.  If none → finalize, exit loop
5.  If found → finalize the response, then for each command:
    a. Check approval mode (all/safe/ask)
    b. If approved, execute via child_process.exec()
    c. Wrap stdout in [OUTPUT]...[/OUTPUT], stderr in [ERROR]...[/ERROR]
6.  Append command output as a user message, show typing indicator, loop back to step 1
```

### Approval system (`extension.ts:366-382`)

Three modes selected via dropdown:
- **all**: auto-execute every command
- **safe**: auto-execute only safe commands (whitelist at line 317-327), ask for others
- **ask**: always prompt user

Dangerous commands (line 329-346) are flagged with a warning in the approval prompt.

---

## 5. Provider API Integration Points

### Where each provider reference lives

| Purpose | File | Comments |
|---------|------|----------|
| Provider dropdown options | `webview.ts:411-417` | HTML `<option>` elements |
| Provider enum validation | `package.json:54-59` | VS Code settings schema |
| Provider factory | `aiProvider.ts:493-509` | `createAIProvider()` switch |
| Provider class definitions | `aiProvider.ts` | One class per provider |
| Model fetch routing | `extension.ts:1131-1159` | `handleFetchModels()` dispatches by type |
| Model config key mapping | `extension.ts:1006` | `handleChangeModel()` selects config key |
| Context size fetching | `extension.ts:1161-1197` | Currently only Ollama supports this |
| Model selector visibility | `main.js:53, 389, 518` | Show model dropdown for local providers |
| Startup model fetch | `extension.ts:507, 666` | Fetch models on webview creation |

---

## 6. Model Fetching

Each local provider has a dedicated `fetch*Models()` function that:
1. Reads the endpoint from config
2. Makes a GET request to the model list API
3. Parses the response (`parsed.models[].name` for Ollama, `parsed.data[].id` for OpenAI-compatible)
4. Returns a sorted `string[]`

Results are posted to the webview as a `modelList` message.

---

## 7. File Layout

```
copilot-extension/
  package.json                   # Extension manifest + VS Code config schema
  install.ps1                    # Deploy script (copies out/ + package.json)
  tsconfig.json
  src/
    aiProvider.ts                # AIProvider interface, all providers, factory, HTTP helpers
    extension.ts                 # Activation, session management, agentic loop, command execution
    webview.ts                   # HTML template + CSS for the chat UI
    main.js                      # Frontend JS (NOT TypeScript — edited directly)
  out/                           # Compiled output (tsc generates .js + .map + .d.ts)
```

---

## 8. Build & Deploy

```powershell
npx tsc -p ./                   # Compile .ts → .js in out/
.\install.ps1                    # Copy out/ + package.json to %USERPROFILE%\.vscode\extensions\...
# Then reload VS Code window
```

---

## 9. Chat History Compression

To prevent unbounded context growth, the extension automatically compresses the chat history when it exceeds a threshold (30,000 characters total).

### How it works

After each `handleSendMessage()` call completes, `compressChatHistory()` checks the total character count of all messages in `chatHistory`. If it exceeds `COMPRESSION_THRESHOLD_CHARS`:

1. All messages except system prompts and the last user+assistant exchange are collected.
2. These messages are sent to the current AI provider with a summarization system prompt.
3. The model returns a concise summary preserving key information (file paths, code changes, commands, decisions, etc.).
4. The original messages are stored as a JSON string in the `compressedHistories` array (persisted in the session file).
5. The original messages in `chatHistory` are replaced with a single system message: `[Chat history compressed]: <summary>`.
6. A system message is displayed in the UI: "Chat history compressed: N previous messages summarized..."
7. The session is saved automatically.

### Session data model

```typescript
interface Session {
    // ... existing fields
    compressedHistories: string[];   // JSON-serialized original messages, one entry per compression event
}
```

### Code location

- `COMPRESSION_THRESHOLD_CHARS` constant: `extension.ts:10`
- `compressChatHistory()` function: `extension.ts:768-818`
- Called at `extension.ts:977` — after the agentic loop finishes and `isProcessingMessage` is released.

### Compression prompt

The summarization uses: *"Summarize the following chat conversation concisely but thoroughly. Preserve ALL key information: file paths, code changes, commands run, errors encountered, decisions made, user preferences, and any other context needed to continue the conversation seamlessly."*

---

## 10. Logging

The extension writes daily log files to `%USERPROFILE%\.vscode\extensions\local-copilot\logs\YYYY-MM-DD.log`.
It logs session operations, model calls (with truncated content), command executions, and errors.
All console output is prefixed with `[Local Copilot]` for easy filtering in the VS Code Developer Tools console.

---

## 10. Security

- **`makeRequest()`**: Forces IPv4 (`family: 4`), 30s timeout, HTTP/HTTPS auto-detection, `rejectUnauthorized: false` for HTTPS (to support self-signed certs on local providers).
- **Command approval**: Commands are classified as safe (whitelist), dangerous (regex patterns), or neutral. Approval mode controls whether execution is automatic or requires user confirmation.
- **`abort()`**: Every provider supports cancellation via `AbortController`. The stop handler also resolves all pending approval promises as denied.
