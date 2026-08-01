import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { AIProvider, ChatMessage, ResponseStats, createAIProvider } from './aiProvider';
import { getWebviewContent } from './webview';
import { getActiveProvider, getApprovalMode as getConfigApprovalMode, getProviderConfig, getProviderType, getSystemPrompt, loadConfig, saveConfig, getConfigPath } from './config';
import { AgentEngine, EngineEvent } from './core/engine';
import { fetchOllamaModels, fetchOpenAICompatibleModels } from './core/providers';
import * as tools from './core/tools';

let currentPanel: vscode.WebviewPanel | undefined = undefined;
let sidebarView: vscode.WebviewView | undefined = undefined;
let showThinking = true;
let logDir: string = '';
let workspaceState: vscode.Memento | undefined;
let approvalIdCounter = 0;
let engine: AgentEngine;
const pendingApprovals = new Map<string, { resolve: (value: boolean) => void }>();

function requestApproval(command: string, dangerous: boolean): Promise<boolean> {
    const id = 'approval-' + (++approvalIdCounter);
    return new Promise<boolean>((resolve) => {
        pendingApprovals.set(id, { resolve });
        postMessageToAllViews({
            type: 'approvalRequest',
            id: id,
            command: command,
            dangerous: dangerous
        });
    });
}

function handleApprovalResponse(id: string, approved: boolean) {
    const pending = pendingApprovals.get(id);
    if (pending) {
        pendingApprovals.delete(id);
        pending.resolve(approved);
    }
}

function resolveAllApprovals() {
    for (const [, pending] of pendingApprovals) {
        pending.resolve(false);
    }
    pendingApprovals.clear();
}

// ── Logging ───────────────────────────────────────────────────────────────────

function ensureLogDir(): string {
    if (!logDir) {
        logDir = path.join(process.env.USERPROFILE || '', '.vscode', 'extensions', 'local-copilot', 'logs');
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }
    return logDir;
}

function getLogFile(): string {
    const dir = ensureLogDir();
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    return path.join(dir, `${date}.log`);
}

function logToFile(entry: string) {
    try {
        const file = getLogFile();
        const timestamp = new Date().toISOString();
        fs.appendFileSync(file, `\n[${timestamp}] ${entry}\n`, 'utf-8');
    } catch (e) {
        console.error('[Maggot] Log write failed:', e);
    }
}

// ── Messaging ─────────────────────────────────────────────────────────────────

function postMessageToAllViews(message: any) {
    console.log('[Maggot] postMessageToAllViews:', message.type, message.text || message.content ? '(has content)' : '');
    let sent = false;
    if (currentPanel) {
        try { currentPanel.webview.postMessage(message); sent = true; } catch (e: any) { console.error('[Maggot] Panel postMessage failed:', e.message); }
    }
    if (sidebarView) {
        try { sidebarView.webview.postMessage(message); sent = true; } catch (e: any) { console.error('[Maggot] Sidebar postMessage failed:', e.message); }
    }
    if (!sent) {
        console.log('[Maggot]   -> WARNING: no views to send to!');
    }
}

function emitEngineEvent(evt: EngineEvent) {
    switch (evt.type) {
        case 'assistantDelta':
            postMessageToAllViews({ type: 'updateAssistantMessage', content: evt.content });
            break;
        case 'updateThinking':
            postMessageToAllViews({ type: 'updateThinkingContent', content: evt.content });
            break;
        case 'finalize':
            postMessageToAllViews({ type: 'finalizeAssistantMessage', content: evt.content, stats: evt.stats, model: evt.model, contextSize: evt.contextSize, thinking: evt.thinking });
            break;
        case 'systemMessage':
            postMessageToAllViews({ type: 'addMessage', role: 'system', content: evt.content });
            break;
        case 'choices':
            postMessageToAllViews({ type: 'choiceRequest', id: evt.id, choices: evt.choices });
            break;
        case 'commandOutput':
            postMessageToAllViews({ type: 'addCommandOutput', output: evt.output, success: evt.success });
            break;
        case 'executingCommand':
            postMessageToAllViews({ type: 'executingCommand', command: evt.command });
            break;
        case 'startAssistant':
            postMessageToAllViews({ type: 'startAssistantMessage' });
            break;
        case 'error':
            postMessageToAllViews({ type: 'error', text: evt.text });
            break;
        case 'clearAndShowCompressed':
            postMessageToAllViews({ type: 'clearAndShowCompressed', count: evt.count });
            break;
        case 'stopped':
            postMessageToAllViews({ type: 'stopComplete' });
            break;
        case 'compressComplete':
            postMessageToAllViews({ type: 'compressComplete' });
            break;
        case 'thinkingToggled':
            postMessageToAllViews({ type: 'thinkingToggled', show: evt.show });
            break;
        case 'clearThinkingContent':
            postMessageToAllViews({ type: 'clearThinkingContent' });
            break;
        case 'sessionStarted':
            postMessageToAllViews({ type: 'sessionStarted', sessionId: evt.sessionId, sessionName: evt.sessionName });
            break;
        case 'sessionSaved':
            postMessageToAllViews({ type: 'sessionSaved', sessionId: evt.sessionId, sessionName: evt.sessionName });
            break;
        case 'sessionLoaded':
            postMessageToAllViews({ type: 'sessionLoaded', sessionId: evt.sessionId, sessionName: evt.sessionName, chatHtml: evt.chatHtml, chatHistory: evt.chatHistory });
            break;
        case 'setProvider':
            postMessageToAllViews({ type: 'setProvider', provider: evt.provider });
            break;
        case 'setModel':
            postMessageToAllViews({ type: 'setModel', model: evt.model });
            break;
        case 'setApproval':
            postMessageToAllViews({ type: 'setApproval', mode: evt.mode });
            break;
        case 'sessionList':
            postMessageToAllViews({ type: 'sessionList', sessions: evt.sessions, activeId: evt.activeId });
            break;
        case 'configSaved':
            postMessageToAllViews({ type: 'configSaved', config: evt.config, configPath: evt.configPath });
            break;
    }
}

function createEngine(): AgentEngine {
    return new AgentEngine({
        emit: emitEngineEvent,
        requestApproval: (command, dangerous) => requestApproval(command, dangerous),
        createProvider: (type, modelOverride) => createAIProvider(type, modelOverride),
        getSystemPrompt: () => getSystemPrompt(),
        getActiveProviderId: () => getActiveProvider(),
        getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        getConfigPath: () => getConfigPath(),
        loadConfig: () => loadConfig(),
        saveConfig: (cfg) => saveConfig(cfg),
        getProviderConfig: (type) => getProviderConfig(type),
        onActiveSessionChange: (id) => { try { workspaceState?.update('activeSessionId', id); } catch {} },
        onGlobalMemoriesChange: (memories) => { try { workspaceState?.update('globalMemories', memories); } catch {} },
        onShowThinkingChange: (show) => { try { workspaceState?.update('showThinking', show); } catch {} },
        onStopRequested: () => { resolveAllApprovals(); },
        log: (entry) => logToFile(entry)
    });
}

// ── Approval mode ─────────────────────────────────────────────────────────────

function getApprovalMode(): string {
    const cfg = getConfigApprovalMode();
    return workspaceState?.get<string>('approvalMode', cfg) || cfg;
}

function handleChangeApproval(mode: string) {
    engine.approvalModeValue = mode;
    workspaceState?.update('approvalMode', mode);
    try {
        const cfg = loadConfig();
        cfg.approvalMode = mode;
        saveConfig(cfg);
    } catch {}
}

// ── Chat state (HTML snapshot) ────────────────────────────────────────────────

function saveChatState(html: string) {
    try {
        workspaceState?.update('chatHtml', html);
        engine.saveSessionHtml(html);
    } catch (e) {
        console.error('[Maggot] Failed to save chat state:', e);
    }
}

function getChatState(): string {
    try {
        return workspaceState?.get<string>('chatHtml', '') || '';
    } catch (e) {
        return '';
    }
}

// ── Command execution (manual, webview-triggered) ─────────────────────────────

function getCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.USERPROFILE || process.cwd();
}

async function handleExecuteCommand(command: string) {
    try {
        postMessageToAllViews({ type: 'executingCommand', command });

        const { stdout, stderr, exitCode } = await tools.executeCommand(command, { cwd: getCwd() });

        // Also show in terminal for visibility
        const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Maggot chat');
        terminal.show();
        terminal.sendText(command, true);

        let output = '';
        if (stdout) output += stdout;
        if (stderr) output += (output ? '\n' : '') + stderr;
        if (!output) output = exitCode === 0 ? '(no output)' : `Exit code: ${exitCode}`;

        postMessageToAllViews({
            type: 'addCommandOutput',
            output: `$ ${command}\n${output}`,
            success: exitCode === 0
        });

        postMessageToAllViews({
            type: 'commandComplete'
        });
    } catch (error: any) {
        postMessageToAllViews({
            type: 'addCommandOutput',
            output: `Error: ${error.message}`,
            success: false
        });
        postMessageToAllViews({
            type: 'commandComplete'
        });
    }
}

// ── Provider / model switching ────────────────────────────────────────────────

function handleChangeProvider(provider: string) {
    engine.changeProvider(provider);

    try {
        const cfg = loadConfig();
        cfg.aiProvider = provider;
        saveConfig(cfg);
    } catch (e: any) {
        console.error('[Maggot] Failed to save provider to config:', e.message);
    }
    vscode.workspace.getConfiguration('local-copilot').update('aiProvider', provider, vscode.ConfigurationTarget.Global);

    postMessageToAllViews({ type: 'configSaved', config: loadConfig(), configPath: getConfigPath() });
}

function handleChangeModel(model: string) {
    engine.changeModel(model);

    const providerType = getActiveProvider();
    try {
        const cfg = loadConfig();
        const prov = (cfg.providers as any)[providerType] || {};
        prov.model = model;
        (cfg.providers as any)[providerType] = prov;
        saveConfig(cfg);
    } catch (e: any) {
        console.error('[Maggot] Failed to save model to config:', e.message);
    }
    const builtinProviders = ['ollama', 'lmstudio', 'janai', 'openai', 'copilot-web', 'vscode-lm'];
    if (builtinProviders.includes(providerType)) {
        const configKey = providerType === 'lmstudio' ? 'lmstudioModel' : providerType === 'janai' ? 'janaiModel' : providerType === 'vscode-lm' ? 'vscodeLmModel' : 'ollamaModel';
        vscode.workspace.getConfiguration('local-copilot').update(configKey, model, vscode.ConfigurationTarget.Global);
    }
}

// ── Model fetching ────────────────────────────────────────────────────────────

function fetchVSCodeLMModels(): Thenable<string[]> {
    return vscode.lm.selectChatModels().then(models => {
        return models.map(m => m.id || m.name || m.family).sort();
    });
}

async function handleFetchModels(providerType?: string) {
    console.log('[Maggot] handleFetchModels called');
    const activeProvider = providerType || getActiveProvider();
    try {
        const connType = getProviderType(activeProvider);
        let models: string[] = [];
        if (connType === 'ollama') {
            models = await fetchOllamaModels(activeProvider);
        } else if (connType === 'openai') {
            models = await fetchOpenAICompatibleModels(activeProvider);
        } else if (connType === 'vscode-lm') {
            models = await fetchVSCodeLMModels();
        }
        console.log('[Maggot] Sending model list to views:', models);
        postMessageToAllViews({
            type: 'modelList',
            models: models,
            provider: activeProvider
        });
        postMessageToAllViews({
            type: 'setModel',
            model: engine.currentModel || ''
        });
    } catch (err: any) {
        console.error('[Maggot] handleFetchModels error:', err.message);
        postMessageToAllViews({
            type: 'modelList',
            models: [],
            error: err.message,
            provider: activeProvider
        });
    }
}

// ── Config UI ─────────────────────────────────────────────────────────────────

function handleSaveConfig(config: any) {
    try {
        // Validate: every provider needs a type; label falls back to id; active provider must exist
        const providers = config.providers || {};
        const ids = Object.keys(providers);
        if (ids.length === 0) {
            throw new Error('At least one provider is required.');
        }
        for (const id of ids) {
            const p = providers[id];
            if (!p.type) p.type = getProviderType(id);
            if (!p.label) p.label = id;
        }
        if (!config.aiProvider || !providers[config.aiProvider]) {
            config.aiProvider = ids[0];
        }
        const saved = saveConfig(config);
        // Re-apply active provider/model from the new config
        const provType = getActiveProvider();
        const provCfg = getProviderConfig(provType);
        engine.currentModel = provCfg.model || '';
        try {
            engine.setProvider(createAIProvider(provType, engine.currentModel || undefined));
        } catch (e: any) {
            console.error('[Maggot] Failed to re-create provider after config save:', e.message);
        }
        postMessageToAllViews({ type: 'configSaved', config: saved, configPath: getConfigPath() });
        logToFile(`[CONFIG] Config saved to ${getConfigPath()}`);
    } catch (err: any) {
        postMessageToAllViews({
            type: 'error',
            text: err.message || 'Failed to save config.'
        });
    }
}

// ── File opening ──────────────────────────────────────────────────────────────

async function handleOpenFile(filePath: string) {
    try {
        if (!filePath) return;
        let uri: vscode.Uri;
        if (/^file:\/\//i.test(filePath)) {
            uri = vscode.Uri.parse(filePath);
        } else if (path.isAbsolute(filePath)) {
            uri = vscode.Uri.file(filePath);
        } else {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            const base = workspaceFolders && workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : '';
            uri = vscode.Uri.file(path.join(base, filePath));
        }
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        logToFile(`[OPEN] Opened file: ${uri.fsPath}`);
    } catch (err: any) {
        logToFile(`[OPEN] Failed to open file ${filePath}: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
    }
}

// ── Compression (manual, webview-triggered) ───────────────────────────────────

async function handleCompressHistory() {
    logToFile(`[COMPRESS] Manual compression triggered`);
    await engine.compressHistory(true);
}

// ── Clipboard image ───────────────────────────────────────────────────────────

async function handleReadClipboardImage() {
    logToFile('[CLIPBOARD] handleReadClipboardImage called');
    try {
        const b64 = await new Promise<string>((resolve, reject) => {
            logToFile('[CLIPBOARD] Executing PowerShell to read clipboard image...');
            exec(
                `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img -ne $null) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bytes = $ms.ToArray(); [Convert]::ToBase64String($bytes) } else { Write-Output '' }"`,
                { timeout: 5000 },
                (err: any, stdout: string, stderr: string) => {
                    if (err) {
                        logToFile('[CLIPBOARD] PowerShell exec error: ' + err.message);
                        reject(err);
                        return;
                    }
                    if (stderr) logToFile('[CLIPBOARD] PowerShell stderr: ' + stderr);
                    logToFile('[CLIPBOARD] PowerShell stdout length: ' + stdout.trim().length);
                    resolve(stdout.trim());
                }
            );
        });
        if (b64) {
            logToFile('[CLIPBOARD] Got clipboard image base64, length: ' + b64.length);
            postMessageToAllViews({ type: 'clipboardImage', base64: b64, mimeType: 'image/png' });
        } else {
            logToFile('[CLIPBOARD] PowerShell returned empty - no image on clipboard');
        }
    } catch (e: any) {
        logToFile('[CLIPBOARD] handleReadClipboardImage failed: ' + e.message);
    }
}

// ── Shared webview message router ─────────────────────────────────────────────

async function handleWebviewMessage(message: any, send: (msg: any) => void) {
    try {
        switch (message.type) {
            case 'sendMessage':
                await engine.sendMessage(message.text, message.images);
                break;
            case 'stopGeneration':
                engine.stop();
                break;
            case 'executeCommand':
                await handleExecuteCommand(message.command);
                break;
            case 'clearChat':
                engine.clearChat();
                break;
            case 'changeProvider':
                handleChangeProvider(message.provider);
                break;
            case 'changeModel':
                handleChangeModel(message.model);
                break;
            case 'fetchModels':
                await handleFetchModels(message.provider);
                break;
            case 'saveChatState':
                saveChatState(message.html);
                break;
            case 'getChatState':
                send({ type: 'initChatState', html: getChatState() });
                break;
            case 'changeApproval':
                handleChangeApproval(message.mode);
                break;
            case 'getApproval':
                send({ type: 'setApproval', mode: getApprovalMode() });
                break;
            case 'getConfig':
                send({ type: 'configLoaded', config: loadConfig(), configPath: getConfigPath() });
                break;
            case 'saveConfig':
                handleSaveConfig(message.config);
                break;
            case 'openLink':
                vscode.env.openExternal(vscode.Uri.parse(message.url))
                    .then(() => {}, (err: any) => vscode.window.showErrorMessage(`Failed to open link: ${err.message}`));
                break;
            case 'openFile':
                handleOpenFile(message.path);
                break;
            case 'approvalResponse':
                handleApprovalResponse(message.id, message.approved);
                break;
            case 'newSession':
                engine.newSession();
                break;
            case 'saveSession':
                engine.saveSession(message.name);
                break;
            case 'loadSession':
                engine.loadSession(message.sessionId);
                break;
            case 'deleteSession':
                engine.deleteSession(message.sessionId);
                break;
            case 'getSessions':
                engine.refreshSessionList();
                break;
            case 'compressHistory':
                await handleCompressHistory();
                break;
            case 'runBenchmark':
                await handleBenchmark();
                break;
            case 'runBatchBenchmark':
                await handleBatchBenchmark(message.tries || 2);
                break;
            case 'choiceResponse':
                await engine.sendMessage(`[User choice: ${message.choice}]`);
                break;
            case 'toggleThinking':
                engine.toggleThinking();
                break;
            case 'getThinkingState':
                send({ type: 'thinkingToggled', show: engine.showThinkingValue });
                break;
            case 'log':
                logToFile('[WEBVIEW] ' + (message.text || ''));
                break;
            case 'saveCmdHistory':
                workspaceState?.update('cmdHistory', message.history);
                break;
            case 'getCmdHistory':
                send({ type: 'cmdHistory', history: workspaceState?.get<string[]>('cmdHistory', []) });
                break;
            case 'readClipboardImage':
                logToFile('[CLIPBOARD] Webview received readClipboardImage message');
                await handleReadClipboardImage();
                break;
        }
    } catch (err: any) {
        console.error('[Maggot] message handler error:', err);
        postMessageToAllViews({ type: 'error', text: err.message || 'Internal error' });
    }
}

// ── Sidebar provider ──────────────────────────────────────────────────────────

class SidebarProvider implements vscode.WebviewViewProvider {
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        sidebarView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'out')
            ]
        };

        webviewView.webview.html = getWebviewContent(this._extensionUri, webviewView.webview);

        const currentProviderType = getActiveProvider();
        webviewView.webview.postMessage({ type: 'setProvider', provider: currentProviderType });
        if (currentProviderType === 'ollama' || currentProviderType === 'lmstudio' || currentProviderType === 'janai' || currentProviderType === 'vscode-lm') {
            handleFetchModels(currentProviderType);
        }

        this._disposables.push(
            webviewView.webview.onDidReceiveMessage(
                async (message) => {
                    console.log('[Maggot] Sidebar received message:', message.type);
                    await handleWebviewMessage(message, (msg) => webviewView.webview.postMessage(msg));
                }
            )
        );

        this._disposables.push(
            webviewView.onDidDispose(() => {
                sidebarView = undefined;
                this._disposables.forEach(d => d.dispose());
                this._disposables = [];
            })
        );
    }
}

// ── Activation ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    console.log('Maggot chat extension is now active!');
    workspaceState = context.workspaceState;
    showThinking = workspaceState?.get<boolean>('showThinking', true) ?? true;

    engine = createEngine();
    engine.setShowThinking(showThinking);
    engine.approvalModeValue = getApprovalMode();
    engine.setState({ globalMemories: workspaceState?.get<string[]>('globalMemories', []) || [] });

    // Initialize session: restore last active session or create a new one
    const lastActiveId = workspaceState?.get<string>('activeSessionId', '') || '';
    if (lastActiveId) {
        const session = engine.getSessionStore().load(lastActiveId);
        if (session) {
            engine.setState({
                chatHistory: [...session.chatHistory],
                compressedHistories: session.compressedHistories ? [...session.compressedHistories] : [],
                sessionMemories: session.memories ? [...session.memories] : [],
                model: session.model,
                activeSessionId: lastActiveId,
                provider: (() => {
                    try { return createAIProvider(session.provider, session.model || undefined); } catch { return null; }
                })()
            });
            engine.refreshContextSize(session.model, session.provider);
            logToFile(`[SESSION] Restored session: ${lastActiveId} (${session.name}), ${session.chatHistory.length} messages`);
        } else {
            engine.newSession();
        }
    } else {
        engine.newSession();
    }

    const sidebarProvider = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('local-copilot.chatView', sidebarProvider)
    );

    const openChatCommand = vscode.commands.registerCommand('local-copilot.openChat', () => {
        createOrShowChatPanel(context);
    });

    const runInTerminalCommand = vscode.commands.registerCommand('local-copilot.runInTerminal', () => {
        runSelectedInTerminal();
    });

    const configureOllamaCommand = vscode.commands.registerCommand('local-copilot.configureOllamaNetwork', async () => {
        const host = getProviderConfig('ollama').host || '0.0.0.0';
        const choice = await vscode.window.showInformationMessage(
            `Set Ollama to bind on ${host} (all network interfaces) and restart?`,
            { modal: true },
            'Yes, restart Ollama'
        );
        if (choice !== 'Yes, restart Ollama') return;

        const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Ollama Config');
        terminal.show();
        terminal.sendText(`[System.Environment]::SetEnvironmentVariable("OLLAMA_HOST", "${host}", "User")`, true);
        terminal.sendText('Stop-Service ollama -ErrorAction SilentlyContinue; Start-Sleep 2; Start-Service ollama -ErrorAction SilentlyContinue', true);
        terminal.sendText('if ($?) { echo "Ollama service restarted with OLLAMA_HOST=' + host + '" } else { echo "Service restart failed. Run: $env:OLLAMA_HOST=\"' + host + '" then: ollama serve" }', true);

        const ep = host === '0.0.0.0' ? 'http://localhost:11434' : `http://${host}:11434`;
        const config = vscode.workspace.getConfiguration('local-copilot');
        await config.update('ollamaEndpoint', ep, vscode.ConfigurationTarget.Global);

        if (engine.getProvider()) {
            try { engine.setProvider(createAIProvider('ollama', engine.currentModel || undefined)); } catch {}
        }

        setTimeout(() => {
            vscode.window.showInformationMessage(`Ollama configured. Endpoint set to ${ep}. If the service failed to start, try running 'ollama serve' manually.`);
        }, 3000);
    });

    context.subscriptions.push(openChatCommand);
    context.subscriptions.push(runInTerminalCommand);
    context.subscriptions.push(configureOllamaCommand);

    const toggleThinkingCommand = vscode.commands.registerCommand('local-copilot.toggleThinking', () => {
        engine.toggleThinking();
    });
    context.subscriptions.push(toggleThinkingCommand);

    const openConfigCommand = vscode.commands.registerCommand('local-copilot.openConfigFile', async () => {
        try {
            const configPath = getConfigPath();
            const doc = await vscode.workspace.openTextDocument(configPath);
            await vscode.window.showTextDocument(doc);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to open config file: ${e.message}`);
        }
    });
    context.subscriptions.push(openConfigCommand);

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(comment-discussion) Maggot chat";
    statusBarItem.command = 'local-copilot.openChat';
    statusBarItem.tooltip = 'Open Maggot chat';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
}

function createOrShowChatPanel(context: vscode.ExtensionContext) {
    if (currentPanel) {
        currentPanel.reveal(vscode.ViewColumn.One);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'localCopilotChat',
        'Maggot chat',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'out')
            ]
        }
    );

    currentPanel.webview.html = getWebviewContent(context.extensionUri, currentPanel.webview);

    {
        const provType = getActiveProvider();
        currentPanel.webview.postMessage({ type: 'setProvider', provider: provType });
        if (provType === 'ollama' || provType === 'lmstudio' || provType === 'janai' || provType === 'vscode-lm') {
            handleFetchModels(provType);
        }
    }

    currentPanel.webview.onDidReceiveMessage(
        async (message) => {
            console.log('[Maggot] Panel received message:', message.type);
            await handleWebviewMessage(message, (msg) => currentPanel?.webview.postMessage(msg));
        },
        undefined,
        context.subscriptions
    );

    currentPanel.onDidDispose(
        () => {
            currentPanel = undefined;
        },
        null,
        context.subscriptions
    );
}

function runSelectedInTerminal() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('No active editor found.');
        return;
    }

    const selection = editor.selection;
    const text = editor.document.getText(selection);

    if (!text) {
        vscode.window.showInformationMessage('No text selected.');
        return;
    }

    const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Maggot chat');
    terminal.show();
    terminal.sendText(text, true);
}

// ── Benchmark ─────────────────────────────────────────────────────────────────

async function handleBenchmark(): Promise<void> {
    logToFile(`[BENCHMARK] Starting benchmark`);
    if (engine.isProcessingMessage) {
        postMessageToAllViews({ type: 'addMessage', role: 'system', content: '⚠️ Already processing a message, please wait.' });
        postMessageToAllViews({ type: 'benchmarkComplete' });
        return;
    }
    engine.setProcessing(true);
    let provider: AIProvider;
    try {
        provider = engine.ensureProvider();
    } catch (err: any) {
        postMessageToAllViews({ type: 'error', text: err.message || 'Failed to initialize AI provider.' });
        postMessageToAllViews({ type: 'benchmarkComplete' });
        engine.setProcessing(false);
        return;
    }

    const systemPrompt = getSystemPrompt();

    const extPath = path.resolve(__dirname, '..');
    const taskPath = path.join(extPath, 'benchmark-task.json');
    let task: any;
    try {
        const taskRaw = fs.readFileSync(taskPath, 'utf-8');
        task = JSON.parse(taskRaw);
    } catch {
        postMessageToAllViews({ type: 'error', text: 'Could not load benchmark-task.json' });
        postMessageToAllViews({ type: 'benchmarkComplete' });
        engine.setProcessing(false);
        return;
    }

    const benchmarkPrompt = task.prompt;
    logToFile(`[BENCHMARK] Running task: ${task.name} (${task.id})`);

    postMessageToAllViews({
        type: 'addMessage',
        role: 'user',
        content: `[BENCHMARK] ${task.name}\n\n${benchmarkPrompt}`
    });

    const messages: ChatMessage[] = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: benchmarkPrompt });

    let fullResponse = '';
    let responseStats: ResponseStats | undefined;

    postMessageToAllViews({ type: 'startAssistantMessage' });

    try {
        const result = await provider.sendMessage(messages, (chunk: string) => {
            fullResponse += chunk;
            postMessageToAllViews({
                type: 'updateAssistantMessage',
                content: fullResponse
            });
        });
        fullResponse = result.content;
        responseStats = result.stats;
    } catch (err: any) {
        postMessageToAllViews({
            type: 'finalizeAssistantMessage',
            content: fullResponse || `❌ Benchmark failed: ${err.message}`,
            stats: responseStats,
            model: engine.currentModel,
            contextSize: engine.currentContextSize
        });
        postMessageToAllViews({ type: 'benchmarkComplete' });
        engine.setProcessing(false);
        return;
    }

    postMessageToAllViews({
        type: 'finalizeAssistantMessage',
        content: fullResponse,
        stats: responseStats,
        model: engine.currentModel,
        contextSize: engine.currentContextSize
    });

    const benchmarkDir = path.join(extPath, 'benchmark');
    if (!fs.existsSync(benchmarkDir)) {
        fs.mkdirSync(benchmarkDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeModel = engine.currentModel.replace(/[^a-zA-Z0-9_-]/g, '_');
    const resultFile = path.join(benchmarkDir, `result-${task.id}-${safeModel}-${timestamp}.json`);
    const resultData = {
        timestamp: new Date().toISOString(),
        task: task,
        model: engine.currentModel,
        provider: getActiveProvider(),
        contextSize: engine.currentContextSize,
        stats: responseStats,
        prompt: benchmarkPrompt,
        response: fullResponse
    };
    fs.writeFileSync(resultFile, JSON.stringify(resultData, null, 2), 'utf-8');
    logToFile(`[BENCHMARK] Results saved to ${resultFile}`);

    const summaryMsg = `✅ Benchmark complete (${task.name})
Model: ${engine.currentModel}
Tokens: ${responseStats?.tokenCount || 'N/A'}
Duration: ${responseStats?.durationMs ? (responseStats.durationMs / 1000).toFixed(1) + 's' : 'N/A'}
Results saved to: ${resultFile}`;
    postMessageToAllViews({
        type: 'addMessage',
        role: 'system',
        content: summaryMsg
    });

    postMessageToAllViews({ type: 'benchmarkComplete' });
    engine.setProcessing(false);
}

interface BenchmarkEntry {
    provider: string;
    model: string;
}

async function discoverBenchmarkEntries(): Promise<BenchmarkEntry[]> {
    const entries: BenchmarkEntry[] = [];

    const discoverResults = await Promise.allSettled([
        (async () => { const m = await fetchOllamaModels('ollama'); return m.map(model => ({ provider: 'ollama', model })); })(),
        (async () => { const m = await fetchOpenAICompatibleModels('lmstudio'); return m.map(model => ({ provider: 'lmstudio', model })); })(),
        (async () => { const m = await fetchOpenAICompatibleModels('janai'); return m.filter(model => /jan/i.test(model)).map(model => ({ provider: 'janai', model })); })(),
        (async () => { const m = await fetchVSCodeLMModels(); return m.map(model => ({ provider: 'vscode-lm', model })); })(),
    ]);

    for (const r of discoverResults) {
        if (r.status === 'fulfilled') entries.push(...r.value);
    }

    return entries;
}

async function handleBatchBenchmark(tries: number): Promise<void> {
    logToFile(`[BATCH BENCHMARK] Starting batch benchmark, tries=${tries}`);

    if (engine.isProcessingMessage) {
        postMessageToAllViews({ type: 'benchmarkProgress', text: 'Already processing, please wait.' });
        postMessageToAllViews({ type: 'batchBenchmarkComplete' });
        return;
    }
    engine.setProcessing(true);
    engine.setStreaming(true);

    postMessageToAllViews({ type: 'benchmarkProgress', text: 'Discovering models from all providers...' });

    const entries = await discoverBenchmarkEntries();
    if (!engine.isStreamingValue) { cleanup(); return; }
    if (entries.length === 0) {
        postMessageToAllViews({ type: 'benchmarkProgress', text: 'No models discovered from any provider.' });
        cleanup(); return;
    }

    const extPath = path.resolve(__dirname, '..');
    const inputsDir = path.join(extPath, 'benchmark-inputs');
    if (!fs.existsSync(inputsDir)) {
        postMessageToAllViews({ type: 'benchmarkProgress', text: `benchmark-inputs folder not found at ${inputsDir}` });
        cleanup(); return;
    }

    const inputFiles = fs.readdirSync(inputsDir).filter(f => f.endsWith('.json'));
    if (inputFiles.length === 0) {
        postMessageToAllViews({ type: 'benchmarkProgress', text: 'No input files found in benchmark-inputs/' });
        cleanup(); return;
    }

    const tasks: any[] = [];
    for (const file of inputFiles) {
        try {
            const raw = fs.readFileSync(path.join(inputsDir, file), 'utf-8');
            tasks.push(JSON.parse(raw));
        } catch (e: any) {
            logToFile(`[BATCH BENCHMARK] Failed to read input ${file}: ${e.message}`);
        }
    }
    if (tasks.length === 0) {
        postMessageToAllViews({ type: 'benchmarkProgress', text: 'No valid task files found in benchmark-inputs/.' });
        cleanup(); return;
    }

    const systemPrompt = getSystemPrompt();
    const benchmarkDir = path.join(extPath, 'benchmark');
    if (!fs.existsSync(benchmarkDir)) {
        fs.mkdirSync(benchmarkDir, { recursive: true });
    }

    let totalRuns = entries.length * tasks.length * tries;
    let completedRuns = 0;
    let failedRuns = 0;
    let stoppedEarly = false;

    const summaryLines: string[] = [];
    summaryLines.push(`# Batch Benchmark Report`);
    summaryLines.push(`Date: ${new Date().toISOString()}`);
    summaryLines.push(`Tries per model: ${tries}`);
    summaryLines.push(`Inputs: ${tasks.map(t => t.name).join(', ')}`);
    summaryLines.push(`Models discovered: ${entries.length}`);
    summaryLines.push('');

    outer:
    for (const entry of entries) {
        if (!engine.isStreamingValue) { stoppedEarly = true; break; }
        logToFile(`[BATCH BENCHMARK] Provider=${entry.provider}, Model=${entry.model || '(default)'}`);

        for (const task of tasks) {
            if (!engine.isStreamingValue) { stoppedEarly = true; break outer; }
            for (let t = 1; t <= tries; t++) {
                if (!engine.isStreamingValue) { stoppedEarly = true; break outer; }

                completedRuns++;
                const progressText = `[${completedRuns}/${totalRuns}] ${entry.provider}/${entry.model || '(default)'} — ${task.name} (try ${t}/${tries})`;
                postMessageToAllViews({ type: 'benchmarkProgress', text: progressText });
                logToFile(`[BATCH BENCHMARK] ${progressText}`);

                let provider: AIProvider;
                try {
                    provider = createAIProvider(entry.provider, entry.model || undefined);
                    engine.setProvider(provider);
                } catch (err: any) {
                    logToFile(`[BATCH BENCHMARK] Failed to create provider ${entry.provider}: ${err.message}`);
                    failedRuns++;
                    continue;
                }

                const messages: ChatMessage[] = [];
                if (systemPrompt) {
                    messages.push({ role: 'system', content: systemPrompt });
                }
                messages.push({ role: 'user', content: task.prompt });

                const startTime = Date.now();
                let fullResponse = '';
                let responseStats: ResponseStats | undefined;

                try {
                    const result = await provider.sendMessage(messages, (chunk: string) => {
                        fullResponse += chunk;
                    });
                    fullResponse = result.content;
                    responseStats = result.stats;
                } catch (err: any) {
                    logToFile(`[BATCH BENCHMARK] Run failed: ${err.message}`);
                    failedRuns++;
                    fullResponse = `[ERROR] ${err.message}`;
                }

                const durationMs = Date.now() - startTime;
                const safeProvider = entry.provider.replace(/[^a-zA-Z0-9_-]/g, '_');
                const safeModel = (entry.model || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const resultFile = path.join(benchmarkDir, `batch-${task.id}-${safeProvider}-${safeModel}-try${t}-${timestamp}.json`);

                const resultData = {
                    timestamp: new Date().toISOString(),
                    task: task,
                    provider: entry.provider,
                    model: entry.model || '',
                    try: t,
                    tries: tries,
                    stats: {
                        durationMs: durationMs,
                        tokenCount: responseStats?.tokenCount,
                        tokensPerSec: responseStats?.tokensPerSec,
                        promptEvalCount: responseStats?.promptEvalCount,
                    },
                    prompt: task.prompt,
                    response: fullResponse,
                };
                fs.writeFileSync(resultFile, JSON.stringify(resultData, null, 2), 'utf-8');
                logToFile(`[BATCH BENCHMARK] Saved to ${resultFile}`);
            }
        }

        summaryLines.push(`## ${entry.provider} / ${entry.model || '(default)'}`);
        summaryLines.push(`Total: ${tries * tasks.length} runs`);
        summaryLines.push('');
    }

    summaryLines.push(`## Summary`);
    summaryLines.push(`Total runs: ${totalRuns}`);
    summaryLines.push(`Completed: ${completedRuns}`);
    summaryLines.push(`Failed: ${failedRuns}`);
    if (stoppedEarly) summaryLines.push(`Status: **STOPPED BY USER**`);
    summaryLines.push('');

    const reportFile = path.join(benchmarkDir, `batch-report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(reportFile, summaryLines.join('\n'), 'utf-8');
    logToFile(`[BATCH BENCHMARK] Report saved to ${reportFile}`);

    postMessageToAllViews({
        type: 'addMessage',
        role: 'system',
        content: `${stoppedEarly ? '🛑' : '✅'} Batch benchmark ${stoppedEarly ? 'stopped' : 'complete'}\n\nModels tested: ${entries.length}\nInputs: ${tasks.length}\nTries per model: ${tries}\nTotal runs: ${totalRuns}\nCompleted: ${completedRuns}\nFailed: ${failedRuns}\n\nReport: ${reportFile}`
    });

    cleanup();

    function cleanup() {
        engine.setStreaming(false);
        engine.setProcessing(false);
        postMessageToAllViews({ type: 'batchBenchmarkComplete' });
    }
}

export function deactivate() {
    if (currentPanel) {
        currentPanel.dispose();
        currentPanel = undefined;
    }
    engine?.setProvider(null);
}
