import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { AIProvider, ChatMessage, ResponseStats, createAIProvider } from './aiProvider';
import { getWebviewContent } from './webview';

const MAX_TOOL_ROUNDS = 10;
const COMPRESSION_THRESHOLD_CHARS = 30000;

let currentPanel: vscode.WebviewPanel | undefined = undefined;
let sidebarView: vscode.WebviewView | undefined = undefined;
let currentProvider: AIProvider | null = null;
let currentModel: string = '';
let currentContextSize: number = 0;
let chatHistory: ChatMessage[] = [];
let isStreaming = false;
let isProcessingMessage = false;
let logDir: string = '';
let workspaceState: vscode.Memento | undefined;
let approvalMode: string = 'safe';
let approvalIdCounter = 0;
let compressedHistories: string[] = [];
let sessionMemories: string[] = [];
let globalMemories: string[] = [];
const pendingApprovals = new Map<string, { resolve: (value: boolean) => void }>();

function requestApproval(command: string): Promise<boolean> {
    const id = 'approval-' + (++approvalIdCounter);
    return new Promise<boolean>((resolve) => {
        pendingApprovals.set(id, { resolve });
        postMessageToAllViews({
            type: 'approvalRequest',
            id: id,
            command: command,
            dangerous: isDangerousCommand(command)
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

// ── Session management ──────────────────────────────────────────────────────────

interface Session {
    id: string;
    name: string;
    timestamp: string;
    chatHistory: ChatMessage[];
    chatHtml: string;
    model: string;
    provider: string;
    approvalMode: string;
    compressedHistories: string[];
    memories: string[];
}

let activeSessionId: string = '';
let sessionsDir: string = '';

function getSessionsDir(): string {
    if (!sessionsDir) {
        const extDir = path.join(process.env.USERPROFILE || '', '.vscode', 'extensions', 'local-copilot');
        sessionsDir = path.join(extDir, 'sessions');
        if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
        }
    }
    return sessionsDir;
}

function generateSessionId(): string {
    return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
}

function generateSessionName(): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const h = pad(now.getHours()), m = pad(now.getMinutes()), s = pad(now.getSeconds());
    // Check if a session with this name already exists; append counter if so
    const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${h}:${m}:${s}`;
    const existing = listSessions().filter(s => s.name.startsWith(base));
    return existing.length === 0 ? base : `${base} (${existing.length + 1})`;
}

function saveSession(session: Session): void {
    try {
        const dir = getSessionsDir();
        const filePath = path.join(dir, `${session.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
        logToFile(`[SESSION] Saved: ${session.id} (${session.name})`);
    } catch (e: any) {
        console.error('[Local Copilot] Failed to save session:', e);
        logToFile(`[SESSION] Save failed: ${e.message}`);
    }
}

function loadSession(id: string): Session | null {
    try {
        const filePath = path.join(getSessionsDir(), `${id}.json`);
        if (!fs.existsSync(filePath)) return null;
        const data = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(data) as Session;
    } catch (e: any) {
        console.error('[Local Copilot] Failed to load session:', e);
        return null;
    }
}

function deleteSessionFile(id: string): boolean {
    try {
        const filePath = path.join(getSessionsDir(), `${id}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            logToFile(`[SESSION] Deleted: ${id}`);
            return true;
        }
        return false;
    } catch (e: any) {
        console.error('[Local Copilot] Failed to delete session:', e);
        return false;
    }
}

function listSessions(): Session[] {
    try {
        const dir = getSessionsDir();
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        const sessions: Session[] = [];
        for (const file of files) {
            try {
                const data = fs.readFileSync(path.join(dir, file), 'utf-8');
                const session = JSON.parse(data) as Session;
                if (session.id && session.chatHistory) {
                    sessions.push(session);
                }
            } catch {
                // skip corrupt files
            }
        }
        sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        return sessions;
    } catch {
        return [];
    }
}

function getActiveSessionId(): string {
    if (activeSessionId) return activeSessionId;
    try {
        activeSessionId = workspaceState?.get<string>('activeSessionId', '') || '';
    } catch {}
    return activeSessionId;
}

function setActiveSessionId(id: string) {
    activeSessionId = id;
    try {
        workspaceState?.update('activeSessionId', id);
    } catch {}
}

function handleNewSession() {
    // Save current session if it has content
    const currentId = getActiveSessionId();
    if (currentId && chatHistory.length > 0) {
        const existing = loadSession(currentId);
        if (existing) {
            existing.chatHistory = [...chatHistory];
            saveSession(existing);
        }
    }

    // Create new session
    const id = generateSessionId();
    const session: Session = {
        id,
        name: generateSessionName(),
        timestamp: new Date().toISOString(),
        chatHistory: [],
        chatHtml: '',
        model: currentModel,
        provider: vscode.workspace.getConfiguration('local-copilot').get<string>('aiProvider', 'ollama'),
        approvalMode: approvalMode,
        compressedHistories: [],
        memories: []
    };
    saveSession(session);
    setActiveSessionId(id);

    // Clear current state
    chatHistory = [];
    compressedHistories = [];
    sessionMemories = [];
    handleClearChat();
    postMessageToAllViews({ type: 'sessionStarted', sessionId: id, sessionName: session.name });
    sendSessionList();
    logToFile(`[SESSION] New session: ${id} (${session.name})`);
}

function handleSaveSession(name?: string) {
    const id = getActiveSessionId() || generateSessionId();
    const existing = loadSession(id);
    const session: Session = {
        id,
        name: name || (existing ? existing.name : generateSessionName()),
        timestamp: new Date().toISOString(),
        chatHistory: [...chatHistory],
        chatHtml: '',
        model: currentModel,
        provider: vscode.workspace.getConfiguration('local-copilot').get<string>('aiProvider', 'ollama'),
        approvalMode: approvalMode,
        compressedHistories: [...compressedHistories],
        memories: [...sessionMemories]
    };

    // If we have a saved HTML from the webview, use the latest
    if (existing?.chatHtml) {
        session.chatHtml = existing.chatHtml;
    }

    saveSession(session);
    setActiveSessionId(id);
    postMessageToAllViews({ type: 'sessionSaved', sessionId: id, sessionName: session.name });
    sendSessionList();
    logToFile(`[SESSION] Saved session: ${id} (${session.name})`);
}

function handleSaveSessionHtml(html: string) {
    const id = getActiveSessionId();
    if (!id) return;
    const existing = loadSession(id);
    if (existing) {
        existing.chatHtml = html;
        saveSession(existing);
    }
}

function handleLoadSession(id: string) {
    const session = loadSession(id);
    if (!session) {
        postMessageToAllViews({ type: 'error', text: `Session not found: ${id}` });
        return;
    }

    // Save current session first if it has content
    const currentId = getActiveSessionId();
    if (currentId && currentId !== id && chatHistory.length > 0) {
        const current = loadSession(currentId);
        if (current) {
            current.chatHistory = [...chatHistory];
            saveSession(current);
        }
    }

    // Load the session
    chatHistory = [...session.chatHistory];
    compressedHistories = session.compressedHistories ? [...session.compressedHistories] : [];
    sessionMemories = session.memories ? [...session.memories] : [];
    currentModel = session.model;
    fetchModelContextSize(session.model, session.provider);
    setActiveSessionId(id);

    // Restore provider and model
    try {
        currentProvider = createAIProvider(session.provider, session.model || undefined);
    } catch {}

    // Send state to webview
    postMessageToAllViews({
        type: 'sessionLoaded',
        sessionId: id,
        sessionName: session.name,
        chatHtml: session.chatHtml,
        chatHistory: session.chatHistory
    });
    postMessageToAllViews({ type: 'setProvider', provider: session.provider });
    postMessageToAllViews({ type: 'setModel', model: currentModel || '' });
    postMessageToAllViews({ type: 'setApproval', mode: session.approvalMode });

    sendSessionList();
    logToFile(`[SESSION] Loaded session: ${id} (${session.name}), ${chatHistory.length} messages`);
}

function handleDeleteSession(id: string) {
    const wasActive = getActiveSessionId() === id;
    deleteSessionFile(id);

    if (wasActive) {
        // Start a new session
        const newId = generateSessionId();
        const session: Session = {
            id: newId,
            name: generateSessionName(),
            timestamp: new Date().toISOString(),
            chatHistory: [],
            chatHtml: '',
            model: currentModel,
            provider: vscode.workspace.getConfiguration('local-copilot').get<string>('aiProvider', 'ollama'),
            approvalMode,
            compressedHistories: [],
            memories: []
        };
        saveSession(session);
        setActiveSessionId(newId);
        chatHistory = [];
        compressedHistories = [];
        sessionMemories = [];
        handleClearChat();
        postMessageToAllViews({ type: 'sessionStarted', sessionId: newId, sessionName: session.name });
    }

    sendSessionList();
    logToFile(`[SESSION] Deleted session: ${id}`);
}

function sendSessionList() {
    const sessions = listSessions();
    const activeId = getActiveSessionId();
    postMessageToAllViews({
        type: 'sessionList',
        sessions: sessions.map(s => ({ id: s.id, name: s.name, timestamp: s.timestamp })),
        activeId
    });
}

const SAFE_COMMANDS = [
    'ls', 'dir', 'pwd', 'cd', 'cat', 'type', 'head', 'tail', 'less', 'more',
    'grep', 'find', 'where', 'which', 'whoami', 'hostname', 'date', 'echo',
    'env', 'set', 'printenv', 'tree', 'du', 'df', 'wc', 'file', 'stat',
    'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
    'git status', 'git log', 'git diff', 'git show', 'git branch', 'git remote',
    'npm list', 'npm ls', 'npm info', 'npm view', 'npm outdated',
    'pip list', 'pip show',
    'python --version', 'python3 --version', 'node --version', 'npm --version',
    'git --version', 'curl --version',
];

const DANGEROUS_PATTERNS = [
    /\brm\b/, /\brmdir\b/, /\bdel\b/, /\berase\b/,
    /\bsudo\b/, /\bdoas\b/,
    /\bchmod\b/, /\bchown\b/, /\bchgrp\b/,
    /\bmv\b/, /\brename\b/,
    /\bcp\b/, /\bcopy\b/,
    /\bformat\b/, /\bmkfs\b/,
    /\bdd\b/, /\bkill\b/, /\bkillall\b/,
    /\bsystemctl\b/, /\bservice\b/,
    /\breg\b/, /\bregedit\b/,
    /\bshutdown\b/, /\breboot\b/,
    /\bcurl\b.*\b-o\b/, /\bwget\b/,
    /\bnpm install\b/, /\bnpm uninstall\b/,
    /\bpip install\b/, /\bpip uninstall\b/,
    /\byarn\b/, /\bpnpm\b/,
    />\s*\//, />\s*[a-zA-Z]:/, /\|\s*rm/, /\|\s*sudo/,
    /\bWrite-Host\b/, /\bSet-Content\b/, /\bRemove-Item\b/,
];

function isSafeCommand(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    for (const safe of SAFE_COMMANDS) {
        if (trimmed === safe || trimmed.startsWith(safe + ' ') || trimmed.startsWith(safe + '\t')) {
            return true;
        }
    }
    return false;
}

function isDangerousCommand(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) return true;
    }
    return false;
}

async function shouldExecuteCommand(command: string): Promise<boolean> {
    if (approvalMode === 'all') {
        logToFile(`[APPROVAL] Auto-approved (mode: all): ${command}`);
        return true;
    }
    if (approvalMode === 'safe') {
        if (isSafeCommand(command)) {
            logToFile(`[APPROVAL] Auto-approved (mode: safe, isSafe): ${command}`);
            return true;
        }
    }

    logToFile(`[APPROVAL] Requesting approval: ${command}`);
    const allowed = await requestApproval(command);
    logToFile(`[APPROVAL] User chose: ${allowed ? 'EXECUTE' : 'DENY'}`);
    return allowed;
}

function getApprovalMode(): string {
    return workspaceState?.get<string>('approvalMode', 'safe') || 'safe';
}

function saveApprovalMode(mode: string) {
    approvalMode = mode;
    workspaceState?.update('approvalMode', mode);
}

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
        console.error('[Local Copilot] Log write failed:', e);
    }
}

function logModelCall(messages: ChatMessage[], round: number) {
    logToFile(`=== MODEL CALL (round ${round}) ===`);
    for (const msg of messages) {
        const label = msg.role === 'system' ? 'SYSTEM' : msg.role === 'user' ? 'USER' : 'ASSISTANT';
        const preview = msg.content.length > 500 ? msg.content.substring(0, 500) + '... [truncated]' : msg.content;
        logToFile(`[${label}]\n${preview}`);
    }
    logToFile(`=== END CALL ===`);
}

function logModelResponse(content: string, stats?: ResponseStats) {
    logToFile(`=== MODEL RESPONSE ===`);
    logToFile(content);
    if (stats) {
        logToFile(`[STATS] ${JSON.stringify(stats)}`);
    }
    logToFile(`=== END RESPONSE ===`);
}

function saveChatState(html: string) {
    try {
        workspaceState?.update('chatHtml', html);
        handleSaveSessionHtml(html);
    } catch (e) {
        console.error('[Local Copilot] Failed to save chat state:', e);
    }
}

function getChatState(): string {
    try {
        return workspaceState?.get<string>('chatHtml', '') || '';
    } catch (e) {
        return '';
    }
}

function postMessageToAllViews(message: any) {
    console.log('[Local Copilot] postMessageToAllViews:', message.type, message.text || message.content ? '(has content)' : '');
    let sent = false;
    if (currentPanel) {
        try { currentPanel.webview.postMessage(message); sent = true; } catch (e: any) { console.error('[Local Copilot] Panel postMessage failed:', e.message); }
    }
    if (sidebarView) {
        try { sidebarView.webview.postMessage(message); sent = true; } catch (e: any) { console.error('[Local Copilot] Sidebar postMessage failed:', e.message); }
    }
    if (!sent) {
        console.log('[Local Copilot]   -> WARNING: no views to send to!');
    }
}

function executeCommandWithOutput(command: string, timeoutMs: number = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.USERPROFILE || process.cwd();
        console.log('[Local Copilot] Executing command:', command, 'in', cwd);
        exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            const exitCode = error ? Number(error.code) || 1 : 0;
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
        });
    });
}

// Sidebar provider for the activity bar view
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

        // Push current provider and models to the webview after it loads
        const config = vscode.workspace.getConfiguration('local-copilot');
        const currentProviderType = config.get<string>('aiProvider', 'ollama');
        webviewView.webview.postMessage({ type: 'setProvider', provider: currentProviderType });
        if (currentProviderType === 'ollama' || currentProviderType === 'lmstudio' || currentProviderType === 'janai') {
            handleFetchModels(currentProviderType);
        }

        // Handle messages from the webview
        this._disposables.push(
            webviewView.webview.onDidReceiveMessage(
                async (message) => {
                    console.log('[Local Copilot] Sidebar received message:', message.type);
                    try {
                        switch (message.type) {
                            case 'sendMessage':
                                await handleSendMessage(message.text);
                                break;
                            case 'stopGeneration':
                                handleStopGeneration();
                                break;
                            case 'executeCommand':
                                await handleExecuteCommand(message.command);
                                break;
                            case 'clearChat':
                                handleClearChat();
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
                                const savedHtml = getChatState();
                                webviewView.webview.postMessage({ type: 'initChatState', html: savedHtml });
                                break;
                            case 'changeApproval':
                                saveApprovalMode(message.mode);
                                break;
                            case 'getApproval':
                                webviewView.webview.postMessage({ type: 'setApproval', mode: getApprovalMode() });
                                break;
                            case 'approvalResponse':
                                handleApprovalResponse(message.id, message.approved);
                                break;
                            case 'newSession':
                                handleNewSession();
                                break;
                            case 'saveSession':
                                handleSaveSession(message.name);
                                break;
                            case 'loadSession':
                                handleLoadSession(message.sessionId);
                                break;
                            case 'deleteSession':
                                handleDeleteSession(message.sessionId);
                                break;
                            case 'getSessions':
                                sendSessionList();
                                break;
                            case 'compressHistory':
                                await handleCompressHistory();
                                break;
                        }
                    } catch (err: any) {
                        console.error('[Local Copilot] Sidebar message handler error:', err);
                        postMessageToAllViews({ type: 'error', text: err.message || 'Internal error' });
                    }
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

export function activate(context: vscode.ExtensionContext) {
    console.log('Local Copilot extension is now active!');
    workspaceState = context.workspaceState;
    approvalMode = getApprovalMode();

    // Initialize session: restore last active session or create a new one
    const lastActiveId = workspaceState?.get<string>('activeSessionId', '') || '';
    globalMemories = workspaceState?.get<string[]>('globalMemories', []) || [];
    if (lastActiveId) {
        const session = loadSession(lastActiveId);
        if (session) {
            chatHistory = [...session.chatHistory];
            compressedHistories = session.compressedHistories ? [...session.compressedHistories] : [];
            sessionMemories = session.memories ? [...session.memories] : [];
            currentModel = session.model;
            fetchModelContextSize(session.model, session.provider);
            setActiveSessionId(lastActiveId);
            try { currentProvider = createAIProvider(session.provider, session.model || undefined); } catch {}
            logToFile(`[SESSION] Restored session: ${lastActiveId} (${session.name}), ${chatHistory.length} messages`);
        } else {
            handleNewSession();
        }
    } else {
        handleNewSession();
    }

    // Register the sidebar webview view provider
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('local-copilot.chatView', sidebarProvider)
    );

    // Register the main command to open the chat panel (opens on the left side)
    const openChatCommand = vscode.commands.registerCommand('local-copilot.openChat', () => {
        createOrShowChatPanel(context);
    });

    // Register the command to run selected text in terminal
    const runInTerminalCommand = vscode.commands.registerCommand('local-copilot.runInTerminal', () => {
        runSelectedInTerminal();
    });

    context.subscriptions.push(openChatCommand);
    context.subscriptions.push(runInTerminalCommand);

    // Register a status bar item
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(comment-discussion) Local Copilot";
    statusBarItem.command = 'local-copilot.openChat';
    statusBarItem.tooltip = 'Open Local Copilot Chat';
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
        'Local Copilot',
        vscode.ViewColumn.One, // Open on the left side
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'out')
            ]
        }
    );

    currentPanel.webview.html = getWebviewContent(context.extensionUri, currentPanel.webview);

    // Push current provider and models to the webview after it loads
    {
        const cfg = vscode.workspace.getConfiguration('local-copilot');
        const provType = cfg.get<string>('aiProvider', 'ollama');
        currentPanel.webview.postMessage({ type: 'setProvider', provider: provType });
        if (provType === 'ollama' || provType === 'lmstudio' || provType === 'janai') {
            handleFetchModels(provType);
        }
    }

    // Handle messages from the webview
    currentPanel.webview.onDidReceiveMessage(
        async (message) => {
            console.log('[Local Copilot] Panel received message:', message.type);
            try {
                switch (message.type) {
                    case 'sendMessage':
                        await handleSendMessage(message.text);
                        break;
                    case 'stopGeneration':
                        handleStopGeneration();
                        break;
                    case 'executeCommand':
                        await handleExecuteCommand(message.command);
                        break;
                    case 'clearChat':
                        handleClearChat();
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
                        const savedPanelHtml = getChatState();
                        currentPanel?.webview.postMessage({ type: 'initChatState', html: savedPanelHtml });
                        break;
                    case 'changeApproval':
                        saveApprovalMode(message.mode);
                        break;
                    case 'getApproval':
                        currentPanel?.webview.postMessage({ type: 'setApproval', mode: getApprovalMode() });
                        break;
                    case 'approvalResponse':
                        handleApprovalResponse(message.id, message.approved);
                        break;
                    case 'newSession':
                        handleNewSession();
                        break;
                    case 'saveSession':
                        handleSaveSession(message.name);
                        break;
                    case 'loadSession':
                        handleLoadSession(message.sessionId);
                        break;
                    case 'deleteSession':
                        handleDeleteSession(message.sessionId);
                        break;
                    case 'getSessions':
                        sendSessionList();
                        break;
                    case 'compressHistory':
                        await handleCompressHistory();
                        break;
                }
            } catch (err: any) {
                console.error('[Local Copilot] Panel message handler error:', err);
                postMessageToAllViews({ type: 'error', text: err.message || 'Internal error' });
            }
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

function ensureProvider(): AIProvider {
    if (!currentProvider) {
        const config = vscode.workspace.getConfiguration('local-copilot');
        const provType = config.get<string>('aiProvider', 'ollama');
        currentModel = provType === 'lmstudio' ? config.get<string>('lmstudioModel', '') : provType === 'janai' ? config.get<string>('janaiModel', '') : config.get<string>('ollamaModel', 'qwen2.5-coder:3b');
        currentProvider = createAIProvider(provType, currentModel || undefined);
    }
    return currentProvider;
}

async function compressChatHistory(provider: AIProvider, manual: boolean = false): Promise<boolean> {
    const totalChars = chatHistory.reduce((sum, m) => sum + m.content.length, 0);
    logToFile(`[COMPRESS] compressChatHistory called, manual=${manual}, totalChars=${totalChars}, historyLen=${chatHistory.length}`);
    if (!manual && totalChars < COMPRESSION_THRESHOLD_CHARS) return false;
    if (chatHistory.length < 3) {
        if (manual) {
            postMessageToAllViews({
                type: 'addMessage',
                role: 'system',
                content: 'Not enough chat history to compress (need at least 3 messages).'
            });
        }
        return false;
    }

    let compressStart = 0;
    const compressEnd = chatHistory.length >= 1 ? chatHistory.length - 1 : chatHistory.length;

    while (compressStart < compressEnd && chatHistory[compressStart].role === 'system') {
        compressStart++;
    }
    if (compressStart >= compressEnd) {
        if (manual) {
            postMessageToAllViews({
                type: 'addMessage',
                role: 'system',
                content: 'Nothing to compress: only system messages and the latest exchange remain.'
            });
        }
        return false;
    }

    const msgsToCompress = chatHistory.slice(compressStart, compressEnd);
    const msgsToKeep = chatHistory.slice(compressEnd);

    const compressMessages: ChatMessage[] = [
        {
            role: 'system',
            content: 'You are a conversation summarizer. Your task is to read the conversation below and produce a concise summary. Output ONLY the summary, nothing else.'
        },
        {
            role: 'user',
            content: `Summarize the following conversation. Preserve ALL key information: file paths, code changes, commands run, errors encountered, decisions made, user preferences, and any other context needed to continue the conversation seamlessly.\n\n${msgsToCompress.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n\n')}`
        }
    ];

    try {
        const result = await provider.sendMessage(compressMessages, () => {});
        const summary = result.content.trim();
        if (!summary) {
            logToFile(`[COMPRESS] Model returned empty summary`);
            if (manual) {
                postMessageToAllViews({
                    type: 'addMessage',
                    role: 'system',
                    content: `⚠️ Compression returned empty result. Check if a model is loaded in your provider.`
                });
            }
            return false;
        }

        compressedHistories.push(JSON.stringify(msgsToCompress));

        const compressedMsg: ChatMessage = {
            role: 'system',
            content: `[Chat history compressed]: ${summary}`
        };
        chatHistory = [...chatHistory.slice(0, compressStart), compressedMsg, ...msgsToKeep];

        logToFile(`[COMPRESS] Compressed ${msgsToCompress.length} messages into summary (${summary.length} chars)`);

        postMessageToAllViews({
            type: 'clearAndShowCompressed',
            count: msgsToCompress.length
        });

        // Persist the session with compressed state
        handleSaveSession();
        return true;
    } catch (err: any) {
        console.error('[Local Copilot] Compression failed:', err.message);
        logToFile(`[COMPRESS] Failed: ${err.message}`);
        if (manual) {
            postMessageToAllViews({
                type: 'addMessage',
                role: 'system',
                content: `❌ Compression failed: ${err.message}`
            });
        }
        return false;
    }
}

function extractCmdBlocks(text: string): string[] {
    const regex = /\[CMD\]([\s\S]*?)\[\/CMD\]/g;
    const commands: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const cmd = match[1].trim();
        if (cmd) commands.push(cmd);
    }
    return commands;
}

async function handleCompressHistory() {
    logToFile(`[COMPRESS] Manual compression triggered, chatHistory length: ${chatHistory.length}, totalChars: ${chatHistory.reduce((s, m) => s + m.content.length, 0)}`);
    try {
        const provider = ensureProvider();
        logToFile(`[COMPRESS] Provider obtained, starting compression`);
        await compressChatHistory(provider, true);
    } catch (err: any) {
        logToFile(`[COMPRESS] Unhandled error: ${err.message}`);
        postMessageToAllViews({
            type: 'addMessage',
            role: 'system',
            content: `❌ Compression failed: ${err.message}`
        });
    }
    postMessageToAllViews({ type: 'compressComplete' });
    logToFile(`[COMPRESS] compressComplete sent`);
}

function buildMemoryMessages(): ChatMessage[] {
    const msgs: ChatMessage[] = [];
    for (const m of sessionMemories) {
        msgs.push({ role: 'system', content: `[Memory]: ${m}` });
    }
    for (const m of globalMemories) {
        msgs.push({ role: 'system', content: `[Global Memory]: ${m}` });
    }
    return msgs;
}

async function handleMemorize(text: string, isGlobal: boolean): Promise<void> {
    logToFile(`[MEMORIZE] Starting ${isGlobal ? 'global' : 'session'} memorize`);
    isProcessingMessage = true;
    let provider: AIProvider;
    try {
        provider = ensureProvider();
    } catch (err: any) {
        postMessageToAllViews({ type: 'error', text: err.message || 'Failed to initialize AI provider.' });
        isProcessingMessage = false;
        return;
    }

    const config = vscode.workspace.getConfiguration('local-copilot');
    const systemPrompt = config.get<string>('systemPrompt', '');

    const messages: ChatMessage[] = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push(...buildMemoryMessages());
    messages.push(...chatHistory);

    const memorizeInstruction = isGlobal
        ? 'You are a memory extraction system. Review the conversation below and extract ALL key information that should be remembered GLOBALLY across all future sessions. This includes: user identity, coding preferences, project conventions, environment setup, frequently used tools, authentication methods, and any other permanent context. Output a concise structured summary of what to remember. Output ONLY the memory content, nothing else.'
        : 'You are a memory extraction system. Review the conversation below and extract ALL key information that should be remembered for the remainder of this session. This includes: decisions made, file paths discussed, code changes, commands used, errors encountered, user preferences for this session, and any other context needed to continue seamlessly. Output a concise structured summary of what to remember. Output ONLY the memory content, nothing else.';

    messages.push({ role: 'user', content: `${memorizeInstruction}\n\nCONVERSATION:\n${chatHistory.map(m => `${m.role}: ${m.content}`).join('\n\n')}` });

    postMessageToAllViews({ type: 'startAssistantMessage' });

    try {
        let fullResponse = '';
        await provider.sendMessage(messages, (chunk: string) => {
            fullResponse += chunk;
        });
        const memory = fullResponse.trim();
        if (!memory) {
            postMessageToAllViews({ type: 'addMessage', role: 'system', content: '⚠️ Memorize returned empty result.' });
            return;
        }

        if (isGlobal) {
            globalMemories.push(memory);
            workspaceState?.update('globalMemories', globalMemories);
            logToFile(`[MEMORIZE] Global memory stored (${memory.length} chars)`);
        } else {
            sessionMemories.push(memory);
            logToFile(`[MEMORIZE] Session memory stored (${memory.length} chars)`);
            handleSaveSession();
        }

        postMessageToAllViews({
            type: 'finalizeAssistantMessage',
            content: `✅ ${isGlobal ? 'Global' : 'Session'} memory saved:\n\n${memory}`,
            stats: undefined,
            model: currentModel,
            contextSize: currentContextSize
        });
    } catch (err: any) {
        postMessageToAllViews({ type: 'error', text: `Memorize failed: ${err.message}` });
    } finally {
        isProcessingMessage = false;
    }
}

async function handleSendMessage(text: string) {
    console.log('[Local Copilot] handleSendMessage called with:', text.substring(0, 100));

    // Handle slash commands
    if (text.startsWith('/memorize_global')) {
        await handleMemorize(text, true);
        return;
    }
    if (text.startsWith('/memorize')) {
        await handleMemorize(text, false);
        return;
    }

    if (isProcessingMessage) {
        console.log('[Local Copilot] Already processing a message, ignoring');
        return;
    }
    isProcessingMessage = true;
    let provider: AIProvider;
    try {
        provider = ensureProvider();
    } catch (err: any) {
        postMessageToAllViews({
            type: 'error',
            text: err.message || 'Failed to initialize AI provider.'
        });
        return;
    }

    const config = vscode.workspace.getConfiguration('local-copilot');
    const systemPrompt = config.get<string>('systemPrompt', '');

    // Add user message to history
    chatHistory.push({ role: 'user', content: text });

    isStreaming = true;

    try {
        // Agentic loop: keep sending to model until no more [CMD] blocks
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
            if (!isStreaming) break;

            // Build messages array with system prompt and memories
            const messages: ChatMessage[] = [];
            if (systemPrompt) {
                messages.push({ role: 'system', content: systemPrompt });
            }
            messages.push(...buildMemoryMessages());
            messages.push(...chatHistory);

            let fullResponse = '';
            let responseStats: ResponseStats | undefined;

            logModelCall(messages, round);

            const result = await provider.sendMessage(messages, (chunk: string) => {
                fullResponse += chunk;
                postMessageToAllViews({
                    type: 'updateAssistantMessage',
                    content: fullResponse
                });
            });

            fullResponse = result.content;
            responseStats = result.stats;

            logModelResponse(fullResponse, responseStats);

            // Add assistant response to history
            chatHistory.push({ role: 'assistant', content: fullResponse });

            // Check for [CMD] blocks
            const commands = extractCmdBlocks(fullResponse);
            if (commands.length === 0) {
                // No commands - finalize and done
                postMessageToAllViews({
                    type: 'finalizeAssistantMessage',
                    content: fullResponse,
                    stats: responseStats,
                    model: currentModel,
                    contextSize: currentContextSize
                });
                break;
            }

            // Has commands - finalize the current response, then execute
            postMessageToAllViews({
                type: 'finalizeAssistantMessage',
                content: fullResponse,
                stats: responseStats,
                model: currentModel,
                contextSize: currentContextSize
            });

            // Execute each command and collect output
            let outputMessage = '';
            for (const command of commands) {
                if (!isStreaming) break;

                const allowed = await shouldExecuteCommand(command);
                if (!allowed) {
                    outputMessage += `Command: ${command}\nResult:\n[OUTPUT](denied by user)[/OUTPUT]\n\n`;
                    postMessageToAllViews({
                        type: 'addCommandOutput',
                        output: `$ ${command}\n(denied by user)`,
                        success: false
                    });
                    continue;
                }

                postMessageToAllViews({
                    type: 'executingCommand',
                    command: command
                });

                const { stdout, stderr, exitCode } = await executeCommandWithOutput(command);

                logToFile(`[CMD] ${command}\nexit: ${exitCode}\nstdout: ${stdout || '(empty)'}\nstderr: ${stderr || '(empty)'}`);

                let outputBlock = '';
                if (stdout) {
                    outputBlock += `[OUTPUT]${stdout}[/OUTPUT]`;
                }
                if (stderr) {
                    outputBlock += `[ERROR]${stderr}[/ERROR]`;
                }
                if (!stdout && !stderr) {
                    outputBlock = exitCode === 0 ? '[OUTPUT](no output)[/OUTPUT]' : `[ERROR]Exit code: ${exitCode}[/ERROR]`;
                }

                outputMessage += `Command: ${command}\nResult:\n${outputBlock}\n\n`;

                postMessageToAllViews({
                    type: 'addCommandOutput',
                    output: `$ ${command}\n${stdout || stderr || '(no output)'}`,
                    success: exitCode === 0
                });
            }

            if (!isStreaming) break;

            // Add tool output as a user message so the model can see it
            chatHistory.push({ role: 'user', content: outputMessage });

            // Show typing indicator for the next round
            postMessageToAllViews({ type: 'startAssistantMessage' });
        }
    } catch (error: any) {
        postMessageToAllViews({
            type: 'error',
            text: error.message || 'An error occurred while communicating with the AI provider.'
        });
    } finally {
        isStreaming = false;
        isProcessingMessage = false;
    }

    // Compress chat history if it exceeds the threshold
    await compressChatHistory(provider);
}

function handleStopGeneration() {
    // Resolve all pending approvals as denied so the agentic loop can break
    for (const [id, pending] of pendingApprovals) {
        pending.resolve(false);
    }
    pendingApprovals.clear();

    if (currentProvider) {
        currentProvider.abort();
    }
    isStreaming = false;

    postMessageToAllViews({ type: 'stopComplete' });
}

async function handleExecuteCommand(command: string) {
    try {
        postMessageToAllViews({ type: 'executingCommand', command });

        const { stdout, stderr, exitCode } = await executeCommandWithOutput(command);

        // Also show in terminal for visibility
        const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Local Copilot');
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

function handleClearChat() {
    chatHistory = [];
    compressedHistories = [];
    const id = getActiveSessionId();
    if (id) {
        handleSaveSessionHtml(''); // Clear saved HTML
    }
}

function handleChangeProvider(provider: string) {
    try {
        currentProvider = createAIProvider(provider, currentModel || undefined);
    } catch (err: any) {
        postMessageToAllViews({
            type: 'error',
            text: err.message || 'Failed to create provider.'
        });
        return;
    }
    chatHistory = [];

    // Update the setting
    const config = vscode.workspace.getConfiguration('local-copilot');
    config.update('aiProvider', provider, vscode.ConfigurationTarget.Global);

    postMessageToAllViews({
        type: 'addMessage',
        role: 'system',
        content: `Switched to ${provider} provider. Chat history cleared.`
    });
}

function handleChangeModel(model: string) {
    currentModel = model;
    fetchModelContextSize(model);
    try {
        const config = vscode.workspace.getConfiguration('local-copilot');
        const providerType = config.get<string>('aiProvider', 'ollama');
        currentProvider = createAIProvider(providerType, model || undefined);
        // Persist model per provider
        const configKey = providerType === 'lmstudio' ? 'lmstudioModel' : providerType === 'janai' ? 'janaiModel' : 'ollamaModel';
        config.update(configKey, model, vscode.ConfigurationTarget.Global);
    } catch (err: any) {
        postMessageToAllViews({
            type: 'error',
            text: err.message || 'Failed to update model.'
        });
        return;
    }

    postMessageToAllViews({
        type: 'addMessage',
        role: 'system',
        content: `Switched to model: ${model}`
    });
}

function fetchOllamaModels(): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const config = vscode.workspace.getConfiguration('local-copilot');
        const endpoint = config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434');
        const url = `${endpoint}/api/tags`;
        console.log('[Local Copilot] Fetching models from:', url);

        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                console.log('[Local Copilot] Models status:', res.statusCode, 'body:', data.substring(0, 300));
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Ollama returned ${res.statusCode}: ${data.substring(0, 200)}`));
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    const models = (parsed.models || []).map((m: any) => m.name).sort();
                    console.log('[Local Copilot] Found models:', models);
                    resolve(models);
                } catch (e) {
                    reject(new Error('Failed to parse Ollama response'));
                }
            });
        });
        req.setTimeout(10000, () => {
            req.destroy(new Error('Request timed out'));
            reject(new Error(`Cannot connect to Ollama at ${endpoint}: timed out`));
        });
        req.on('error', (err) => {
            reject(new Error(`Cannot connect to Ollama at ${endpoint}: ${err.message}`));
        });
    });
}

function fetchLMStudioModels(): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const config = vscode.workspace.getConfiguration('local-copilot');
        const endpoint = config.get<string>('lmstudioEndpoint', 'http://127.0.0.1:1234/v1');
        const url = `${endpoint}/models`;
        console.log('[Local Copilot] Fetching LM Studio models from:', url);

        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                console.log('[Local Copilot] LM Studio models status:', res.statusCode, 'body:', data.substring(0, 300));
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`LM Studio returned ${res.statusCode}: ${data.substring(0, 200)}`));
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    const models = (parsed.data || []).map((m: any) => m.id).sort();
                    console.log('[Local Copilot] LM Studio found models:', models);
                    resolve(models);
                } catch (e) {
                    reject(new Error('Failed to parse LM Studio response'));
                }
            });
        });
        req.setTimeout(10000, () => {
            req.destroy(new Error('Request timed out'));
            reject(new Error(`Cannot connect to LM Studio at ${endpoint}: timed out`));
        });
        req.on('error', (err) => {
            reject(new Error(`Cannot connect to LM Studio at ${endpoint}: ${err.message}`));
        });
    });
}

function fetchJanAIModels(): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const config = vscode.workspace.getConfiguration('local-copilot');
        const endpoint = config.get<string>('janaiEndpoint', 'http://127.0.0.1:1337/v1');
        const url = `${endpoint}/models`;
        console.log('[Local Copilot] Fetching JAN AI models from:', url);

        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                console.log('[Local Copilot] JAN AI models status:', res.statusCode, 'body:', data.substring(0, 300));
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`JAN AI returned ${res.statusCode}: ${data.substring(0, 200)}`));
                    return;
                }
                try {
                    const parsed = JSON.parse(data);
                    const models = (parsed.data || []).map((m: any) => m.id).sort();
                    console.log('[Local Copilot] JAN AI found models:', models);
                    resolve(models);
                } catch (e) {
                    reject(new Error('Failed to parse JAN AI response'));
                }
            });
        });
        req.setTimeout(10000, () => {
            req.destroy(new Error('Request timed out'));
            reject(new Error(`Cannot connect to JAN AI at ${endpoint}: timed out`));
        });
        req.on('error', (err) => {
            reject(new Error(`Cannot connect to JAN AI at ${endpoint}: ${err.message}`));
        });
    });
}

async function handleFetchModels(providerType?: string) {
    console.log('[Local Copilot] handleFetchModels called');
    const activeProvider = providerType || vscode.workspace.getConfiguration('local-copilot').get<string>('aiProvider', 'ollama');
    try {
        const models = activeProvider === 'lmstudio'
            ? await fetchLMStudioModels()
            : activeProvider === 'janai'
            ? await fetchJanAIModels()
            : await fetchOllamaModels();
        console.log('[Local Copilot] Sending model list to views:', models);
        postMessageToAllViews({
            type: 'modelList',
            models: models,
            provider: activeProvider
        });
        postMessageToAllViews({
            type: 'setModel',
            model: currentModel || ''
        });
    } catch (err: any) {
        console.error('[Local Copilot] handleFetchModels error:', err.message);
        postMessageToAllViews({
            type: 'modelList',
            models: [],
            error: err.message,
            provider: activeProvider
        });
    }
}

function fetchModelContextSize(modelName: string, providerType?: string) {
    if (!modelName || providerType === 'lmstudio' || providerType === 'janai') {
        currentContextSize = 0;
        return;
    }
    const config = vscode.workspace.getConfiguration('local-copilot');
    const endpoint = config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434');
    const url = `${endpoint}/api/show`;
    console.log('[Local Copilot] Fetching context size for:', modelName);

    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                const modelInfo = parsed.model_info || {};
                let ctxLen = 0;
                for (const key of Object.keys(modelInfo)) {
                    if (key.toLowerCase().includes('context_length')) {
                        ctxLen = Number(modelInfo[key]) || 0;
                        break;
                    }
                }
                currentContextSize = ctxLen > 0 ? ctxLen : 0;
                console.log('[Local Copilot] Context size for', modelName, ':', currentContextSize);
            } catch {
                currentContextSize = 0;
            }
        });
    });
    req.setTimeout(5000, () => { req.destroy(); currentContextSize = 0; });
    req.on('error', () => { currentContextSize = 0; });
    const body = JSON.stringify({ model: modelName });
    req.write(body);
    req.end();
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

    const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Local Copilot');
    terminal.show();
    terminal.sendText(text, true);
}

export function deactivate() {
    if (currentPanel) {
        currentPanel.dispose();
        currentPanel = undefined;
    }
    currentProvider = null;
}
