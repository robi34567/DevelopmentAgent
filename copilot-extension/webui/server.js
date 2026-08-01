'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { getWebUiPageHtml } = require('../out/webview.js');
const { AgentEngine } = require('../out/core/engine.js');
const { createCoreProvider, fetchOllamaModels, fetchOpenAICompatibleModels } = require('../out/core/providers.js');
const {
    getActiveProvider,
    getApprovalMode,
    getConfigPath,
    getDataDir,
    getProviderConfig,
    getProviderList,
    getProviderType,
    getSystemPrompt,
    loadConfig,
    saveConfig
} = require('../out/core/config.js');

const args = process.argv.slice(2);
const PORT = parseInt(process.env.MAGGOT_PORT || args[0] || '8787', 10);
const WORKSPACE = path.resolve(args[1] || process.cwd());
const HOST = '127.0.0.1';

// ── Logging: keep engine debug out of the server console ─────────────────────
const logDir = path.join(getDataDir(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `webui-${new Date().toISOString().split('T')[0]}.log`);
function appendLog(line) {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf-8'); } catch (e) {}
}
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);
console.log = (...a) => appendLog('[LOG] ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
console.error = (...a) => {
    const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    appendLog('[ERR] ' + line);
    origConsoleError(line);
};

// ── Clients & approvals ───────────────────────────────────────────────────────
const clients = new Set();
let approvalIdCounter = 0;
const pendingApprovals = new Map(); // id -> resolve(boolean)

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
        if (ws.readyState === 1) {
            try { ws.send(data); } catch (e) {}
        }
    }
}

// Map EngineEvent -> client message (same mapping as src/extension.ts)
function emitEngineEvent(evt) {
    switch (evt.type) {
        case 'assistantDelta':
            broadcast({ type: 'updateAssistantMessage', content: evt.content });
            break;
        case 'updateThinking':
            broadcast({ type: 'updateThinkingContent', content: evt.content });
            break;
        case 'finalize':
            broadcast({ type: 'finalizeAssistantMessage', content: evt.content, stats: evt.stats, model: evt.model, contextSize: evt.contextSize, thinking: evt.thinking });
            break;
        case 'systemMessage':
            broadcast({ type: 'addMessage', role: 'system', content: evt.content });
            break;
        case 'choices':
            broadcast({ type: 'choiceRequest', id: evt.id, choices: evt.choices });
            break;
        case 'commandOutput':
            broadcast({ type: 'addCommandOutput', output: evt.output, success: evt.success });
            break;
        case 'executingCommand':
            broadcast({ type: 'executingCommand', command: evt.command });
            break;
        case 'startAssistant':
            broadcast({ type: 'startAssistantMessage' });
            break;
        case 'error':
            broadcast({ type: 'error', text: evt.text });
            break;
        case 'clearAndShowCompressed':
            broadcast({ type: 'clearAndShowCompressed', count: evt.count });
            break;
        case 'stopped':
            broadcast({ type: 'stopComplete' });
            break;
        case 'compressComplete':
            broadcast({ type: 'compressComplete' });
            break;
        case 'thinkingToggled':
            broadcast({ type: 'thinkingToggled', show: evt.show });
            break;
        case 'clearThinkingContent':
            broadcast({ type: 'clearThinkingContent' });
            break;
        case 'sessionStarted':
            broadcast({ type: 'sessionStarted', sessionId: evt.sessionId, sessionName: evt.sessionName });
            break;
        case 'sessionSaved':
            broadcast({ type: 'sessionSaved', sessionId: evt.sessionId, sessionName: evt.sessionName });
            break;
        case 'sessionLoaded':
            broadcast({ type: 'sessionLoaded', sessionId: evt.sessionId, sessionName: evt.sessionName, chatHtml: evt.chatHtml, chatHistory: evt.chatHistory });
            break;
        case 'setProvider':
            broadcast({ type: 'setProvider', provider: evt.provider });
            break;
        case 'setModel':
            broadcast({ type: 'setModel', model: evt.model });
            break;
        case 'setApproval':
            broadcast({ type: 'setApproval', mode: evt.mode });
            break;
        case 'sessionList':
            broadcast({ type: 'sessionList', sessions: evt.sessions, activeId: evt.activeId });
            break;
        case 'configSaved':
            broadcast({ type: 'configSaved', config: evt.config, configPath: evt.configPath });
            break;
    }
}

const engine = new AgentEngine({
    emit: emitEngineEvent,
    requestApproval: (command, dangerous) => new Promise((resolve) => {
        if (clients.size === 0) { resolve(false); return; }
        const id = 'approval-' + (++approvalIdCounter);
        pendingApprovals.set(id, { resolve, command, dangerous });
        broadcast({ type: 'approvalRequest', id, command, dangerous });
    }),
    createProvider: (type, modelOverride) => {
        if (type === 'copilot-web' || type === 'vscode-lm') {
            throw new Error(`Provider '${type}' is only available inside VS Code. Use /provider to switch to ollama, openai, lmstudio, or janai.`);
        }
        return createCoreProvider(type, modelOverride);
    },
    getSystemPrompt: () => getSystemPrompt(),
    getActiveProviderId: () => getActiveProvider(),
    getWorkspaceRoot: () => WORKSPACE,
    getConfigPath: () => getConfigPath(),
    loadConfig: () => loadConfig(),
    saveConfig: (cfg) => saveConfig(cfg),
    getProviderConfig: (type) => getProviderConfig(type),
    log: (entry) => appendLog('[ENGINE] ' + entry)
});

// ── Config / provider handlers (mirror src/extension.ts, no vscode) ───────────

function handleSaveConfig(config) {
    try {
        const providers = config.providers || {};
        const ids = Object.keys(providers);
        if (ids.length === 0) throw new Error('At least one provider is required.');
        for (const id of ids) {
            const p = providers[id];
            if (!p.type) p.type = getProviderType(id);
            if (!p.label) p.label = id;
        }
        if (!config.aiProvider || !providers[config.aiProvider]) config.aiProvider = ids[0];
        const saved = saveConfig(config);
        const provType = getActiveProvider();
        const provCfg = getProviderConfig(provType);
        engine.currentModel = provCfg.model || '';
        try {
            engine.setProvider(createCoreProvider(provType, engine.currentModel || undefined));
        } catch (e) {
            appendLog('[CONFIG] Failed to re-create provider: ' + e.message);
        }
        broadcast({ type: 'configSaved', config: saved, configPath: getConfigPath() });
    } catch (err) {
        broadcast({ type: 'error', text: err.message || 'Failed to save config.' });
    }
}

function handleChangeProvider(provider) {
    engine.changeProvider(provider);
    try {
        const cfg = loadConfig();
        cfg.aiProvider = provider;
        saveConfig(cfg);
    } catch (e) {
        appendLog('[CONFIG] Failed to save provider: ' + e.message);
    }
    broadcast({ type: 'configSaved', config: loadConfig(), configPath: getConfigPath() });
}

function handleChangeModel(model) {
    engine.changeModel(model);
    const providerType = getActiveProvider();
    try {
        const cfg = loadConfig();
        const prov = (cfg.providers)[providerType] || {};
        prov.model = model;
        (cfg.providers)[providerType] = prov;
        saveConfig(cfg);
    } catch (e) {
        appendLog('[CONFIG] Failed to save model: ' + e.message);
    }
}

async function handleFetchModels(providerType) {
    const activeProvider = providerType || getActiveProvider();
    try {
        const connType = getProviderType(activeProvider);
        let models = [];
        if (connType === 'ollama') {
            models = await fetchOllamaModels(activeProvider);
        } else if (connType === 'openai') {
            models = await fetchOpenAICompatibleModels(activeProvider);
        } else {
            broadcast({ type: 'modelList', models: [], provider: activeProvider, error: `Provider '${activeProvider}' is only available inside VS Code.` });
            return;
        }
        broadcast({ type: 'modelList', models, provider: activeProvider });
        broadcast({ type: 'setModel', model: engine.currentModel || '' });
    } catch (err) {
        broadcast({ type: 'modelList', models: [], provider: activeProvider, error: err.message });
    }
}

// ── Per-connection init state ─────────────────────────────────────────────────

function sendInitState(ws) {
    const send = (msg) => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch (e) {} } };
    send({ type: 'configLoaded', config: loadConfig(), configPath: getConfigPath() });
    send({ type: 'setProvider', provider: getActiveProvider() });
    send({ type: 'setModel', model: engine.currentModel || '' });
    send({ type: 'setApproval', mode: getApprovalMode() });
    send({ type: 'thinkingToggled', show: engine.showThinkingValue });
    const history = engine.getChatHistory();
    if (history.length > 0) {
        send({ type: 'sessionLoaded', sessionId: engine.activeSession, sessionName: '', chatHtml: '', chatHistory: history });
    }
    engine.refreshSessionList();
}

// ── WebSocket message handling ────────────────────────────────────────────────

const cmdHistoryStore = [];

async function handleClientMessage(msg, ws) {
    switch (msg.type) {
        case 'sendMessage':
            await engine.sendMessage(msg.text, msg.images);
            break;
        case 'stopGeneration':
            engine.stop();
            break;
        case 'clearChat':
            engine.clearChat();
            break;
        case 'changeProvider':
            handleChangeProvider(msg.provider);
            break;
        case 'changeModel':
            handleChangeModel(msg.model);
            break;
        case 'changeApproval':
            engine.approvalModeValue = msg.mode;
            broadcast({ type: 'setApproval', mode: msg.mode });
            break;
        case 'fetchModels':
            await handleFetchModels(msg.provider);
            break;
        case 'getConfig':
            broadcast({ type: 'configLoaded', config: loadConfig(), configPath: getConfigPath() });
            break;
        case 'saveConfig':
            handleSaveConfig(msg.config);
            break;
        case 'getChatState':
            broadcast({ type: 'initChatState', html: '' });
            break;
        case 'getCmdHistory':
            broadcast({ type: 'cmdHistory', history: cmdHistoryStore });
            break;
        case 'saveCmdHistory':
            cmdHistoryStore.length = 0;
            cmdHistoryStore.push(...(msg.history || []));
            break;
        case 'getApproval':
            broadcast({ type: 'setApproval', mode: getApprovalMode() });
            break;
        case 'getSessions':
            engine.refreshSessionList();
            break;
        case 'getThinkingState':
            broadcast({ type: 'thinkingToggled', show: engine.showThinkingValue });
            break;
        case 'newSession':
            engine.newSession();
            break;
        case 'saveSession':
            engine.saveSession(msg.name);
            break;
        case 'deleteSession':
            engine.deleteSession(msg.sessionId);
            break;
        case 'loadSession':
            engine.loadSession(msg.sessionId);
            break;
        case 'saveChatState':
            engine.saveSessionHtml(msg.html || '');
            break;
        case 'choiceResponse':
            await engine.sendMessage(`[User choice: ${msg.choice}]`);
            break;
        case 'approvalResponse':
            handleApprovalResponse(msg.id, msg.approved);
            break;
        case 'toggleThinking':
            engine.toggleThinking();
            break;
        case 'compressHistory':
            await engine.compressHistory(true);
            break;
        case 'runBenchmark':
        case 'runBatchBenchmark':
            broadcast({ type: 'systemMessage', content: '⚠️ Benchmark is only available in the VS Code extension.' });
            break;
        case 'log':
            appendLog('[WEBVIEW] ' + (msg.text || ''));
            break;
        case 'executeCommand':
            broadcast({ type: 'addMessage', role: 'system', content: '⚠️ Terminal execution is only available in the VS Code extension.' });
            break;
        case 'openLink':
        case 'openFile':
        case 'readClipboardImage':
            break;
    }
}

function handleApprovalResponse(id, approved) {
    const pending = pendingApprovals.get(id);
    if (pending) {
        pendingApprovals.delete(id);
        pending.resolve(!!approved);
    }
}

// ── HTTP server + static files ────────────────────────────────────────────────

const STATIC_DIR = path.join(__dirname, 'static');
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
    try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/' || urlPath === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(getWebUiPageHtml());
            return;
        }
        if (urlPath === '/static/main.js') {
            const file = path.join(__dirname, '..', 'out', 'main.js');
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            res.end(fs.readFileSync(file));
            return;
        }
        if (urlPath === '/static/shim.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            res.end(fs.readFileSync(path.join(STATIC_DIR, 'shim.js')));
            return;
        }
        if (urlPath === '/favicon.ico') {
            res.writeHead(204);
            res.end();
            return;
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error: ' + err.message);
    }
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
    clients.add(ws);
    sendInitState(ws);
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        handleClientMessage(msg, ws).catch((err) => {
            broadcast({ type: 'error', text: err.message || 'Internal error' });
        });
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
});

// ── Startup ───────────────────────────────────────────────────────────────────

engine.newSession();

process.stdout.write('\n');
process.stdout.write('  🐛 Maggot webUI\n');
process.stdout.write(`  URL:        http://${HOST}:${PORT}\n`);
process.stdout.write(`  workspace:  ${WORKSPACE}\n`);
process.stdout.write(`  config:     ${getConfigPath()}\n`);
process.stdout.write(`  provider:   ${getActiveProvider()}\n`);
process.stdout.write('  (localhost only - no auth)\n');
process.stdout.write('\n');

server.listen(PORT, HOST, () => {
    process.stdout.write(`  listening on http://${HOST}:${PORT}\n`);
});
