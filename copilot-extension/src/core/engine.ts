import { AIProvider, AppConfig, ChatMessage, ProviderConfig, ResponseStats } from './types';
import * as tools from './tools';
import { SessionStore, Session } from './session';
import { getProviderType } from './config';
import { fetchOllamaContextSize } from './providers';

export const MAX_TOOL_ROUNDS = 10;
export const COMPRESSION_THRESHOLD_CHARS = 30000;

export type EngineEvent =
    | { type: 'assistantDelta'; content: string }
    | { type: 'updateThinking'; content: string }
    | { type: 'finalize'; content: string; stats?: ResponseStats; thinking?: string; model: string; contextSize: number }
    | { type: 'systemMessage'; content: string }
    | { type: 'choices'; id: string; choices: string[] }
    | { type: 'commandOutput'; output: string; success: boolean }
    | { type: 'executingCommand'; command: string }
    | { type: 'startAssistant' }
    | { type: 'error'; text: string }
    | { type: 'clearAndShowCompressed'; count: number }
    | { type: 'stopped' }
    | { type: 'compressComplete' }
    | { type: 'thinkingToggled'; show: boolean }
    | { type: 'clearThinkingContent' }
    | { type: 'sessionStarted'; sessionId: string; sessionName: string }
    | { type: 'sessionSaved'; sessionId: string; sessionName: string }
    | { type: 'sessionLoaded'; sessionId: string; sessionName: string; chatHtml: string; chatHistory: ChatMessage[] }
    | { type: 'setProvider'; provider: string }
    | { type: 'setModel'; model: string }
    | { type: 'setApproval'; mode: string }
    | { type: 'sessionList'; sessions: { id: string; name: string; timestamp: string }[]; activeId: string }
    | { type: 'configSaved'; config: AppConfig; configPath: string };

export interface EngineHooks {
    emit(event: EngineEvent): void;
    requestApproval(command: string, dangerous: boolean): Promise<boolean>;
    createProvider(type: string, modelOverride?: string): AIProvider;
    getSystemPrompt(): string;
    getActiveProviderId(): string;
    getWorkspaceRoot(): string;
    getConfigPath(): string;
    loadConfig(): AppConfig;
    saveConfig(config: AppConfig): AppConfig;
    getProviderConfig?(type: string): ProviderConfig;
    onActiveSessionChange?(id: string): void;
    onGlobalMemoriesChange?(memories: string[]): void;
    onShowThinkingChange?(show: boolean): void;
    onStopRequested?(): void;
    log?(entry: string): void;
}

export class AgentEngine {
    private provider: AIProvider | null = null;
    private chatHistory: ChatMessage[] = [];
    private compressedHistories: string[] = [];
    private sessionMemories: string[] = [];
    private globalMemories: string[] = [];
    private approvalMode: string = 'safe';
    private model: string = '';
    private contextSize: number = 0;
    private isStreaming: boolean = false;
    private isProcessing: boolean = false;
    private showThinking: boolean = true;
    private currentThinking: string = '';
    private activeSessionId: string = '';
    private choiceIdCounter = 0;
    private sessionStore: SessionStore;

    constructor(private hooks: EngineHooks) {
        this.sessionStore = new SessionStore();
    }

    // ── Logging ──────────────────────────────────────────────────────────────

    private log(entry: string) {
        try { this.hooks.log?.(entry); } catch {}
    }

    private emit(event: EngineEvent) {
        try { this.hooks.emit(event); } catch (e: any) { console.error('[Local Copilot] emit failed:', e.message); }
    }

    private logModelCall(messages: ChatMessage[], round: number) {
        this.log(`=== MODEL CALL (round ${round}) ===`);
        for (const msg of messages) {
            const label = msg.role === 'system' ? 'SYSTEM' : msg.role === 'user' ? 'USER' : 'ASSISTANT';
            const preview = msg.content.length > 500 ? msg.content.substring(0, 500) + '... [truncated]' : msg.content;
            this.log(`[${label}]\n${preview}`);
        }
        this.log(`=== END CALL ===`);
    }

    private logModelResponse(content: string, stats?: ResponseStats) {
        this.log(`=== MODEL RESPONSE ===`);
        this.log(content);
        if (stats) this.log(`[STATS] ${JSON.stringify(stats)}`);
        this.log(`=== END RESPONSE ===`);
    }

    // ── State accessors ──────────────────────────────────────────────────────

    get isProcessingMessage(): boolean { return this.isProcessing; }
    get isStreamingValue(): boolean { return this.isStreaming; }
    get currentModel(): string { return this.model; }
    set currentModel(m: string) { this.model = m; }
    get currentContextSize(): number { return this.contextSize; }
    set currentContextSize(c: number) { this.contextSize = c; }
    get approvalModeValue(): string { return this.approvalMode; }
    set approvalModeValue(m: string) { this.approvalMode = m; }
    get showThinkingValue(): boolean { return this.showThinking; }
    get activeSession(): string { return this.activeSessionId; }
    getChatHistory(): ChatMessage[] { return this.chatHistory; }
    getCompressedHistories(): string[] { return this.compressedHistories; }
    getSessionMemories(): string[] { return this.sessionMemories; }
    getGlobalMemories(): string[] { return this.globalMemories; }
    getProvider(): AIProvider | null { return this.provider; }
    getSessionStore(): SessionStore { return this.sessionStore; }

    setShowThinking(v: boolean) { this.showThinking = v; }
    setProcessing(v: boolean) { this.isProcessing = v; }
    setStreaming(v: boolean) { this.isStreaming = v; }
    setProvider(p: AIProvider | null) { this.provider = p; }

    clearChat() {
        this.chatHistory = [];
        this.compressedHistories = [];
        this.saveSessionHtml('');
    }

    setState(state: Partial<{ chatHistory: ChatMessage[]; compressedHistories: string[]; sessionMemories: string[]; globalMemories: string[]; model: string; contextSize: number; approvalMode: string; activeSessionId: string; provider: AIProvider | null }>) {
        if (state.chatHistory !== undefined) this.chatHistory = [...state.chatHistory];
        if (state.compressedHistories !== undefined) this.compressedHistories = [...state.compressedHistories];
        if (state.sessionMemories !== undefined) this.sessionMemories = [...state.sessionMemories];
        if (state.globalMemories !== undefined) this.globalMemories = [...state.globalMemories];
        if (state.model !== undefined) this.model = state.model;
        if (state.contextSize !== undefined) this.contextSize = state.contextSize;
        if (state.approvalMode !== undefined) this.approvalMode = state.approvalMode;
        if (state.activeSessionId !== undefined) this.activeSessionId = state.activeSessionId;
        if (state.provider !== undefined) this.provider = state.provider;
    }

    // ── Provider ─────────────────────────────────────────────────────────────

    ensureProvider(): AIProvider {
        if (!this.provider) {
            const provType = this.hooks.getActiveProviderId();
            const provCfg = this.hooks.getProviderConfig ? this.hooks.getProviderConfig(provType) : ((this.hooks.loadConfig().providers as any)[provType] || {});
            this.model = provCfg.model || '';
            this.provider = this.hooks.createProvider(provType, this.model || undefined);
        }
        return this.provider;
    }

    refreshContextSize(modelName?: string, providerType?: string) {
        const provType = providerType || this.hooks.getActiveProviderId();
        if (!modelName || getProviderType(provType) !== 'ollama') {
            this.contextSize = 0;
            return;
        }
        fetchOllamaContextSize(provType, modelName).then(size => { this.contextSize = size; });
    }

    // ── Approval ─────────────────────────────────────────────────────────────

    private async shouldExecuteCommand(command: string): Promise<boolean> {
        if (this.approvalMode === 'all') {
            this.log(`[APPROVAL] Auto-approved (mode: all): ${command}`);
            return true;
        }
        if (this.approvalMode === 'safe') {
            if (tools.isSafeCommand(command)) {
                this.log(`[APPROVAL] Auto-approved (mode: safe, isSafe): ${command}`);
                return true;
            }
        }
        this.log(`[APPROVAL] Requesting approval: ${command}`);
        const allowed = await this.hooks.requestApproval(command, tools.isDangerousCommand(command));
        this.log(`[APPROVAL] User chose: ${allowed ? 'EXECUTE' : 'DENY'}`);
        return allowed;
    }

    // ── Memory ───────────────────────────────────────────────────────────────

    private buildMemoryMessages(): ChatMessage[] {
        const msgs: ChatMessage[] = [];
        for (const m of this.sessionMemories) {
            msgs.push({ role: 'system', content: `[Memory]: ${m}` });
        }
        for (const m of this.globalMemories) {
            msgs.push({ role: 'system', content: `[Global Memory]: ${m}` });
        }
        return msgs;
    }

    async memorize(text: string, isGlobal: boolean): Promise<void> {
        this.log(`[MEMORIZE] Starting ${isGlobal ? 'global' : 'session'} memorize`);
        this.isProcessing = true;
        let provider: AIProvider;
        try {
            provider = this.ensureProvider();
        } catch (err: any) {
            this.emit({ type: 'error', text: err.message || 'Failed to initialize AI provider.' });
            this.isProcessing = false;
            return;
        }

        const systemPrompt = this.hooks.getSystemPrompt();

        const messages: ChatMessage[] = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }
        messages.push(...this.buildMemoryMessages());
        messages.push(...this.chatHistory);

        const memorizeInstruction = isGlobal
            ? 'You are a memory extraction system. Review the conversation below and extract ALL key information that should be remembered GLOBALLY across all future sessions. This includes: user identity, coding preferences, project conventions, environment setup, frequently used tools, authentication methods, and any other permanent context. Output a concise structured summary of what to remember. Output ONLY the memory content, nothing else.'
            : 'You are a memory extraction system. Review the conversation below and extract ALL key information that should be remembered for the remainder of this session. This includes: decisions made, file paths discussed, code changes, commands used, errors encountered, user preferences for this session, and any other context needed to continue seamlessly. Output a concise structured summary of what to remember. Output ONLY the memory content, nothing else.';

        messages.push({ role: 'user', content: `${memorizeInstruction}\n\nCONVERSATION:\n${this.chatHistory.map(m => `${m.role}: ${m.content}`).join('\n\n')}` });

        this.emit({ type: 'startAssistant' });

        try {
            let fullResponse = '';
            await provider.sendMessage(messages, (chunk: string) => {
                fullResponse += chunk;
            });
            const memory = fullResponse.trim();
            if (!memory) {
                this.emit({ type: 'systemMessage', content: '⚠️ Memorize returned empty result.' });
                return;
            }

            if (isGlobal) {
                this.globalMemories.push(memory);
                this.hooks.onGlobalMemoriesChange?.(this.globalMemories);
                this.log(`[MEMORIZE] Global memory stored (${memory.length} chars)`);
            } else {
                this.sessionMemories.push(memory);
                this.log(`[MEMORIZE] Session memory stored (${memory.length} chars)`);
                this.saveSession();
            }

            this.emit({
                type: 'finalize',
                content: `✅ ${isGlobal ? 'Global' : 'Session'} memory saved:\n\n${memory}`,
                stats: undefined,
                model: this.model,
                contextSize: this.contextSize
            });
        } catch (err: any) {
            this.emit({ type: 'error', text: `Memorize failed: ${err.message}` });
        } finally {
            this.isProcessing = false;
        }
    }

    // ── Compression ──────────────────────────────────────────────────────────

    private async compressWithProvider(provider: AIProvider, manual: boolean): Promise<boolean> {
        const totalChars = this.chatHistory.reduce((sum, m) => sum + m.content.length, 0);
        this.log(`[COMPRESS] compressChatHistory called, manual=${manual}, totalChars=${totalChars}, historyLen=${this.chatHistory.length}`);
        if (!manual && totalChars < COMPRESSION_THRESHOLD_CHARS) return false;
        if (this.chatHistory.length < 3) {
            if (manual) {
                this.emit({ type: 'systemMessage', content: 'Not enough chat history to compress (need at least 3 messages).' });
            }
            return false;
        }

        let compressStart = 0;
        const compressEnd = this.chatHistory.length >= 1 ? this.chatHistory.length - 1 : this.chatHistory.length;

        while (compressStart < compressEnd && this.chatHistory[compressStart].role === 'system') {
            compressStart++;
        }
        if (compressStart >= compressEnd) {
            if (manual) {
                this.emit({ type: 'systemMessage', content: 'Nothing to compress: only system messages and the latest exchange remain.' });
            }
            return false;
        }

        const msgsToCompress = this.chatHistory.slice(compressStart, compressEnd);
        const msgsToKeep = this.chatHistory.slice(compressEnd);

        const compressMessages: ChatMessage[] = [
            {
                role: 'system',
                content: 'You are a conversation summarizer. Your task is to read the conversation below and produce a concise summary. Output ONLY the summary, nothing else.'
            },
            {
                role: 'user',
                content: `Summarize the following conversation. Preserve ALL key information: file paths, code changes, commands run, errors encountered, decisions made, user preferences, and any other context needed to continue the conversation seamlessly.\n\n${msgsToCompress.map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}${m.images && m.images.length > 0 ? ' [attached ' + m.images.length + ' image(s)]' : ''}`).join('\n\n')}`
            }
        ];

        try {
            const result = await provider.sendMessage(compressMessages, () => {});
            const summary = result.content.trim();
            if (!summary) {
                this.log(`[COMPRESS] Model returned empty summary`);
                if (manual) {
                    this.emit({ type: 'systemMessage', content: `⚠️ Compression returned empty result. Check if a model is loaded in your provider.` });
                }
                return false;
            }

            this.compressedHistories.push(JSON.stringify(msgsToCompress));

            const compressedMsg: ChatMessage = {
                role: 'system',
                content: `[Chat history compressed]: ${summary}`
            };
            this.chatHistory = [...this.chatHistory.slice(0, compressStart), compressedMsg, ...msgsToKeep];

            this.log(`[COMPRESS] Compressed ${msgsToCompress.length} messages into summary (${summary.length} chars)`);

            this.emit({ type: 'clearAndShowCompressed', count: msgsToCompress.length });

            this.saveSession();
            return true;
        } catch (err: any) {
            console.error('[Local Copilot] Compression failed:', err.message);
            this.log(`[COMPRESS] Failed: ${err.message}`);
            if (manual) {
                this.emit({ type: 'systemMessage', content: `❌ Compression failed: ${err.message}` });
            }
            return false;
        }
    }

    async compressHistory(manual: boolean): Promise<boolean> {
        let provider: AIProvider;
        try {
            provider = this.ensureProvider();
        } catch (err: any) {
            if (manual) {
                this.emit({ type: 'systemMessage', content: `❌ Compression failed: ${err.message}` });
                this.emit({ type: 'compressComplete' });
            }
            return false;
        }
        const ok = await this.compressWithProvider(provider, manual);
        if (manual) this.emit({ type: 'compressComplete' });
        return ok;
    }

    // ── Sessions ─────────────────────────────────────────────────────────────

    private setActiveSessionId(id: string) {
        this.activeSessionId = id;
        try { this.hooks.onActiveSessionChange?.(id); } catch {}
    }

    private emitSessionList() {
        const sessions = this.sessionStore.list();
        this.emit({
            type: 'sessionList',
            sessions: sessions.map(s => ({ id: s.id, name: s.name, timestamp: s.timestamp })),
            activeId: this.activeSessionId
        });
    }

    refreshSessionList() {
        this.emitSessionList();
    }

    private newSessionRecord(): Session {
        return {
            id: this.sessionStore.generateSessionId(),
            name: this.sessionStore.generateSessionName(),
            timestamp: new Date().toISOString(),
            chatHistory: [],
            chatHtml: '',
            model: this.model,
            provider: this.hooks.getActiveProviderId(),
            approvalMode: this.approvalMode,
            compressedHistories: [],
            memories: []
        };
    }

    newSession() {
        const currentId = this.activeSessionId;
        if (currentId && this.chatHistory.length > 0) {
            const existing = this.sessionStore.load(currentId);
            if (existing) {
                existing.chatHistory = [...this.chatHistory];
                this.sessionStore.save(existing);
            }
        }

        const session = this.newSessionRecord();
        this.sessionStore.save(session);
        this.setActiveSessionId(session.id);

        this.chatHistory = [];
        this.compressedHistories = [];
        this.sessionMemories = [];
        this.saveSessionHtml('');
        this.emit({ type: 'sessionStarted', sessionId: session.id, sessionName: session.name });
        this.emitSessionList();
        this.log(`[SESSION] New session: ${session.id} (${session.name})`);
    }

    saveSession(name?: string) {
        const id = this.activeSessionId || this.sessionStore.generateSessionId();
        const existing = this.sessionStore.load(id);
        const session: Session = {
            id,
            name: name || (existing ? existing.name : this.sessionStore.generateSessionName()),
            timestamp: new Date().toISOString(),
            chatHistory: [...this.chatHistory],
            chatHtml: '',
            model: this.model,
            provider: this.hooks.getActiveProviderId(),
            approvalMode: this.approvalMode,
            compressedHistories: [...this.compressedHistories],
            memories: [...this.sessionMemories]
        };

        if (existing?.chatHtml) {
            session.chatHtml = existing.chatHtml;
        }

        this.sessionStore.save(session);
        this.setActiveSessionId(id);
        this.emit({ type: 'sessionSaved', sessionId: id, sessionName: session.name });
        this.emitSessionList();
        this.log(`[SESSION] Saved session: ${id} (${session.name})`);
    }

    saveSessionHtml(html: string) {
        const id = this.activeSessionId;
        if (!id) return;
        const existing = this.sessionStore.load(id);
        if (existing) {
            existing.chatHtml = html;
            this.sessionStore.save(existing);
        }
    }

    loadSession(id: string) {
        const session = this.sessionStore.load(id);
        if (!session) {
            this.emit({ type: 'error', text: `Session not found: ${id}` });
            return;
        }

        const currentId = this.activeSessionId;
        if (currentId && currentId !== id && this.chatHistory.length > 0) {
            const current = this.sessionStore.load(currentId);
            if (current) {
                current.chatHistory = [...this.chatHistory];
                this.sessionStore.save(current);
            }
        }

        this.chatHistory = [...session.chatHistory];
        this.compressedHistories = session.compressedHistories ? [...session.compressedHistories] : [];
        this.sessionMemories = session.memories ? [...session.memories] : [];
        this.model = session.model;
        this.refreshContextSize(session.model, session.provider);
        this.setActiveSessionId(id);

        try {
            this.provider = this.hooks.createProvider(session.provider, session.model || undefined);
        } catch {}

        this.emit({ type: 'sessionLoaded', sessionId: id, sessionName: session.name, chatHtml: session.chatHtml, chatHistory: session.chatHistory });
        this.emit({ type: 'setProvider', provider: session.provider });
        this.emit({ type: 'setModel', model: this.model || '' });
        this.emit({ type: 'setApproval', mode: session.approvalMode });

        this.emitSessionList();
        this.log(`[SESSION] Loaded session: ${id} (${session.name}), ${this.chatHistory.length} messages`);
    }

    deleteSession(id: string) {
        const wasActive = this.activeSessionId === id;
        this.sessionStore.delete(id);
        this.log(`[SESSION] Deleted: ${id}`);

        if (wasActive) {
            const session = this.newSessionRecord();
            this.sessionStore.save(session);
            this.setActiveSessionId(session.id);
            this.chatHistory = [];
            this.compressedHistories = [];
            this.sessionMemories = [];
            this.saveSessionHtml('');
            this.emit({ type: 'sessionStarted', sessionId: session.id, sessionName: session.name });
        }

        this.emitSessionList();
        this.log(`[SESSION] Deleted session: ${id}`);
    }

    // ── Thinking toggle ──────────────────────────────────────────────────────

    toggleThinking() {
        this.showThinking = !this.showThinking;
        this.hooks.onShowThinkingChange?.(this.showThinking);
        this.emit({ type: 'thinkingToggled', show: this.showThinking });
        if (!this.showThinking) {
            this.emit({ type: 'clearThinkingContent' });
        }
    }

    // ── Provider switch ──────────────────────────────────────────────────────

    changeProvider(provider: string) {
        try {
            this.provider = this.hooks.createProvider(provider, this.model || undefined);
        } catch (err: any) {
            this.emit({ type: 'error', text: err.message || 'Failed to create provider.' });
            return;
        }
        this.chatHistory = [];
        this.emit({ type: 'systemMessage', content: `Switched to ${provider} provider. Chat history cleared.` });
    }

    changeModel(model: string) {
        this.model = model;
        this.refreshContextSize(model);
        try {
            const providerType = this.hooks.getActiveProviderId();
            this.provider = this.hooks.createProvider(providerType, model || undefined);
            this.emit({ type: 'systemMessage', content: `Switched to model: ${model}` });
        } catch (err: any) {
            this.emit({ type: 'error', text: err.message || 'Failed to update model.' });
        }
    }

    // ── Stop ─────────────────────────────────────────────────────────────────

    stop() {
        try { this.hooks.onStopRequested?.(); } catch {}
        this.isStreaming = false;
        if (this.provider) {
            this.provider.abort();
        }
        this.emit({ type: 'stopped' });
    }

    // ── Auto rename ──────────────────────────────────────────────────────────

    private async autoRenameSession(provider: AIProvider) {
        const id = this.activeSessionId;
        if (!id) return;
        const session = this.sessionStore.load(id);
        if (!session) return;
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(session.name)) return;
        const firstUserMsg = this.chatHistory.find(m => m.role === 'user' && m.content && !m.content.startsWith('Command:'));
        if (!firstUserMsg) return;
        try {
            const titleMsgs: ChatMessage[] = [
                { role: 'system', content: 'You are a chat session titler. Read the user message below and respond with ONLY a very short title (2-6 words) that summarizes the topic. No punctuation, no explanation. Reply with the title only.' },
                { role: 'user', content: firstUserMsg.content }
            ];
            const result = await provider.sendMessage(titleMsgs, () => {});
            const title = result.content.trim().replace(/^["']|["']$/g, '').substring(0, 60);
            if (title && title.length > 0) {
                session.name = title;
                this.sessionStore.save(session);
                this.emit({ type: 'sessionSaved', sessionId: id, sessionName: title });
                this.emitSessionList();
                this.log(`[SESSION] Auto-renamed: ${id} -> "${title}"`);
            }
        } catch (e: any) {
            this.log(`[SESSION] Auto-rename failed: ${e.message}`);
        }
    }

    // ── Main agentic loop ────────────────────────────────────────────────────

    async sendMessage(text: string, images?: { base64: string; mimeType: string }[]) {
        console.log('[Local Copilot] handleSendMessage called with:', text.substring(0, 100), images ? `(${images.length} images)` : '');

        if (text.startsWith('/memorize_global')) {
            await this.memorize(text, true);
            return;
        }
        if (text.startsWith('/memorize')) {
            await this.memorize(text, false);
            return;
        }

        if (this.isProcessing) {
            console.log('[Local Copilot] Already processing a message, ignoring');
            return;
        }
        this.isProcessing = true;
        let provider: AIProvider;
        try {
            provider = this.ensureProvider();
        } catch (err: any) {
            this.emit({ type: 'error', text: err.message || 'Failed to initialize AI provider.' });
            return;
        }

        const systemPrompt = this.hooks.getSystemPrompt();

        const userMsg: ChatMessage = { role: 'user', content: text };
        const curProvider = this.hooks.getActiveProviderId();
        this.log(`[SEND] curProvider=${curProvider} images=${images?.length || 0}`);
        if (images && images.length > 0) {
            userMsg.images = images;
            this.log(`[SEND] attached ${images.length} images to user message`);
        }
        this.chatHistory.push(userMsg);

        this.isStreaming = true;

        try {
            for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
                if (!this.isStreaming) break;

                const messages: ChatMessage[] = [];
                if (systemPrompt) {
                    messages.push({ role: 'system', content: systemPrompt });
                }
                messages.push(...this.buildMemoryMessages());
                messages.push(...this.chatHistory);

                let fullResponse = '';
                let responseStats: ResponseStats | undefined;
                this.currentThinking = '';

                this.logModelCall(messages, round);
                this.log(`[SEND] messages[last] images=${messages[messages.length - 1]?.images?.length || 0} content=${messages[messages.length - 1]?.content?.substring(0, 50)}`);

                const result = await provider.sendMessage(messages, (chunk: string) => {
                    fullResponse += chunk;
                    this.emit({ type: 'assistantDelta', content: fullResponse });
                }, (thinkingChunk: string) => {
                    this.currentThinking += thinkingChunk;
                    if (this.showThinking) {
                        this.emit({ type: 'updateThinking', content: this.currentThinking });
                    }
                });

                fullResponse = result.content;
                responseStats = result.stats;
                const finalThinking = result.thinking;

                // The model sometimes replies with its own "cannot read image" error (e.g. it invents a
                // filename like image.png) even when no image was attached. Show one clean message instead
                // of the raw, possibly-redundant error text.
                if (tools.isImageUnsupportedText(fullResponse)) {
                    fullResponse = '⚠️ The model could not process the image you referenced — it does not support image input. Please describe the image in text, or switch to a vision-capable model.';
                }

                this.logModelResponse(fullResponse, responseStats);

                this.chatHistory.push({ role: 'assistant', content: fullResponse });

                // Check for [ASK] and [CHOICES] blocks — model wants to ask a question and/or offer options.
                // These often appear together (e.g. "[ASK]...[/ASK]\n[CHOICES]a|b|c[/CHOICES]"), so process
                // BOTH: show the question AND send the choiceRequest so the client renders clickable buttons.
                const questions = tools.extractAskBlocks(fullResponse);
                const choices = tools.extractChoicesBlock(fullResponse);
                if (questions.length > 0 || (choices && choices.length > 0)) {
                    this.emit({ type: 'finalize', content: fullResponse, stats: responseStats, model: this.model, contextSize: this.contextSize, thinking: finalThinking });
                    if (questions.length > 0) {
                        this.emit({ type: 'systemMessage', content: `✋ The model is asking:\n\n${questions.join('\n\n')}\n\nType your answer and press Send to continue.` });
                    }
                    if (choices && choices.length > 0) {
                        this.emit({ type: 'choices', id: 'choice-' + (++this.choiceIdCounter), choices });
                    }
                    break;
                }

                const commands = tools.extractCmdBlocks(fullResponse);
                const reads = tools.extractReadBlocks(fullResponse);
                const writes = tools.extractWriteBlocks(fullResponse);
                const searches = tools.extractSearchBlocks(fullResponse);
                const files = tools.extractFilesBlocks(fullResponse);
                const hasBlocks = commands.length > 0 || reads.length > 0 || writes.length > 0 || searches.length > 0 || files.length > 0;

                if (!hasBlocks) {
                    this.emit({ type: 'finalize', content: fullResponse, stats: responseStats, model: this.model, contextSize: this.contextSize, thinking: finalThinking });
                    break;
                }

                this.emit({ type: 'finalize', content: fullResponse, stats: responseStats, model: this.model, contextSize: this.contextSize, thinking: finalThinking });

                let outputMessage = '';
                const workspaceRoot = this.hooks.getWorkspaceRoot();

                for (const command of commands) {
                    if (!this.isStreaming) break;
                    const allowed = await this.shouldExecuteCommand(command);
                    if (!allowed) {
                        outputMessage += `Command: ${command}\nResult:\n[OUTPUT](denied by user)[/OUTPUT]\n\n`;
                        this.emit({ type: 'commandOutput', output: `$ ${command}\n(denied by user)`, success: false });
                        continue;
                    }
                    this.emit({ type: 'executingCommand', command });
                    const { stdout, stderr, exitCode } = await tools.executeCommand(command, { cwd: workspaceRoot || undefined });
                    this.log(`[CMD] ${command}\nexit: ${exitCode}\nstdout: ${stdout || '(empty)'}\nstderr: ${stderr || '(empty)'}`);
                    let outputBlock = '';
                    if (stdout) outputBlock += `[OUTPUT]${stdout}[/OUTPUT]`;
                    if (stderr) outputBlock += `[ERROR]${stderr}[/ERROR]`;
                    outputBlock ||= exitCode === 0 ? '[OUTPUT](no output)[/OUTPUT]' : `[ERROR]Exit code: ${exitCode}[/ERROR]`;
                    outputMessage += `Command: ${command}\nResult:\n${outputBlock}\n\n`;
                    this.emit({ type: 'commandOutput', output: `$ ${command}\n${stdout || stderr || '(no output)'}`, success: exitCode === 0 });
                }

                // Execute writes BEFORE reads: the model often writes a file then reads it back to
                // verify. Reading first would return stale/absent content, which makes the model
                // distrust the result and repeat the same tool calls over and over.
                for (const w of writes) {
                    if (!this.isStreaming) break;
                    this.emit({ type: 'systemMessage', content: `📝 Writing: ${w.path}` });
                    const result = await tools.writeFileTool(w.path, w.content, workspaceRoot);
                    outputMessage += `Write: ${w.path}\nResult:\n${result}\n\n`;
                }

                for (const filePath of reads) {
                    if (!this.isStreaming) break;
                    this.emit({ type: 'systemMessage', content: `📖 Reading: ${filePath}` });
                    const result = await tools.readFileTool(filePath, workspaceRoot);
                    outputMessage += `Read: ${filePath}\nResult:\n${result}\n\n`;
                }

                for (const pattern of searches) {
                    if (!this.isStreaming) break;
                    this.emit({ type: 'systemMessage', content: `🔍 Searching: ${pattern}` });
                    const result = await tools.searchFilesTool(pattern, workspaceRoot);
                    outputMessage += `Search: ${pattern}\nResult:\n${result}\n\n`;
                }

                for (const globPattern of files) {
                    if (!this.isStreaming) break;
                    this.emit({ type: 'systemMessage', content: `📁 Files: ${globPattern}` });
                    const result = await tools.globFilesTool(globPattern, workspaceRoot);
                    outputMessage += `Files: ${globPattern}\nResult:\n${result}\n\n`;
                }

                if (!this.isStreaming) break;

                this.chatHistory.push({ role: 'user', content: outputMessage });

                this.emit({ type: 'startAssistant' });
            }
        } catch (error: any) {
            this.emit({ type: 'error', text: error.message || 'An error occurred while communicating with the AI provider.' });
        } finally {
            this.isStreaming = false;
            this.isProcessing = false;
        }

        await this.autoRenameSession(provider);
        await this.compressWithProvider(provider, false);
    }
}
