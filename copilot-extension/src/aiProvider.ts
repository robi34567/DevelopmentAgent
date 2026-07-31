import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

export interface ChatMessageImage {
    base64: string;
    mimeType: string;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    images?: ChatMessageImage[];
}

export interface ResponseStats {
    tokenCount?: number;
    durationMs?: number;
    tokensPerSec?: number;
    contextSize?: number;
    promptEvalCount?: number;
}

export interface AIProvider {
    sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }>;
    abort(): void;
}

function makeRequest(url: string, method: string, headers: any, body: string, signal?: AbortSignal): Promise<{ status: number; body: http.IncomingMessage }> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const isHttps = parsedUrl.protocol === 'https:';
        const lib = isHttps ? https : http;

        const bodyBuffer = Buffer.from(body, 'utf-8');

        const options: any = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            family: 4,
            headers: {
                ...headers,
                'Content-Length': bodyBuffer.length.toString()
            }
        };

        if (isHttps) {
            options.rejectUnauthorized = false;
        }

        const req = lib.request(options, (res: http.IncomingMessage) => {
            resolve({
                status: res.statusCode || 500,
                body: res
            });
        });

        req.setTimeout(30000, () => {
            req.destroy(new Error('Request timed out after 30s'));
        });

        req.on('error', (err: Error) => {
            reject(new Error(`Request failed: ${err.message}`));
        });

        if (signal) {
            signal.addEventListener('abort', () => {
                req.destroy(new Error('Request aborted'));
            });
        }

        req.write(bodyBuffer);
        req.end();
    });
}

function readStream(stream: http.IncomingMessage, onData: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
    return new Promise((resolve, reject) => {
        let fullContent = '';
        let fullThinking = '';
        let buffer = '';
        let settled = false;
        let evalCount: number | undefined;
        let evalDurationNs: number | undefined;
        let promptEvalCount: number | undefined;

        stream.setEncoding('utf-8');

        stream.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const parsed = JSON.parse(trimmed);
                    if (parsed.error) {
                        if (!settled) {
                            settled = true;
                            reject(new Error(parsed.error));
                        }
                        return;
                    }
                    if (parsed.message?.content) {
                        fullContent += parsed.message.content;
                        try { onData(parsed.message.content); } catch(e) {}
                    }
                    if (parsed.message?.reasoning_content) {
                        fullThinking += parsed.message.reasoning_content;
                        if (onThinking) { try { onThinking(parsed.message.reasoning_content); } catch(e) {} }
                    }
                    if (parsed.done) {
                        console.log('[Local Copilot] Stream done signal received');
                        if (parsed.eval_count !== undefined) evalCount = parsed.eval_count;
                        if (parsed.eval_duration !== undefined) evalDurationNs = parsed.eval_duration;
                        if (parsed.prompt_eval_count !== undefined) promptEvalCount = parsed.prompt_eval_count;
                    }
                } catch (e) {
                    console.log('[Local Copilot] Failed to parse line:', trimmed.substring(0, 50));
                }
            }
        });

        stream.on('end', () => {
            if (settled) return;
            if (buffer.trim()) {
                try {
                    const parsed = JSON.parse(buffer.trim());
                    if (parsed.error) {
                        settled = true;
                        reject(new Error(parsed.error));
                        return;
                    }
                    if (parsed.message?.content) {
                        fullContent += parsed.message.content;
                        try { onData(parsed.message.content); } catch(e) {}
                    }
                    if (parsed.message?.reasoning_content) {
                        fullThinking += parsed.message.reasoning_content;
                        if (onThinking) { try { onThinking(parsed.message.reasoning_content); } catch(e) {} }
                    }
                    if (parsed.done) {
                        if (parsed.eval_count !== undefined) evalCount = parsed.eval_count;
                        if (parsed.eval_duration !== undefined) evalDurationNs = parsed.eval_duration;
                        if (parsed.prompt_eval_count !== undefined) promptEvalCount = parsed.prompt_eval_count;
                    }
                } catch (e) {}
            }
            settled = true;
            const stats: ResponseStats | undefined = (evalCount !== undefined && evalDurationNs !== undefined && evalDurationNs > 0)
                ? { tokenCount: evalCount, durationMs: evalDurationNs / 1e6, tokensPerSec: Math.round(evalCount / (evalDurationNs / 1e9)), promptEvalCount }
                : (promptEvalCount !== undefined ? { promptEvalCount } : undefined);
            const thinking = fullThinking || undefined;
            resolve({ content: fullContent, stats, thinking });
        });

        stream.on('error', (err: Error) => {
            if (!settled) {
                settled = true;
                reject(new Error(`Stream error: ${err.message}`));
            }
        });

        stream.on('close', () => {
            if (!settled) {
                settled = true;
                if (fullContent.length > 0) {
                    const stats: ResponseStats | undefined = (evalCount !== undefined && evalDurationNs !== undefined && evalDurationNs > 0)
                        ? { tokenCount: evalCount, durationMs: evalDurationNs / 1e6, tokensPerSec: Math.round(evalCount / (evalDurationNs / 1e9)), promptEvalCount }
                        : (promptEvalCount !== undefined ? { promptEvalCount } : undefined);
                    const thinking = fullThinking || undefined;
                    resolve({ content: fullContent, stats, thinking });
                } else {
                    reject(new Error('Stream closed without response'));
                }
            }
        });
    });
}

function readSSEStream(stream: http.IncomingMessage, onData: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
    return new Promise((resolve, reject) => {
        let fullContent = '';
        let fullThinking = '';
        let buffer = '';
        let settled = false;
        let promptTokens = 0;
        let completionTokens = 0;

        stream.setEncoding('utf-8');

        stream.on('data', (chunk: string) => {
            buffer += chunk;
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        if (!settled) {
                            settled = true;
                            reject(new Error(parsed.error.message || parsed.error));
                        }
                        return;
                    }

                    // Capture usage if present (final chunk in some LM Studio versions)
                    if (parsed.usage) {
                        promptTokens = parsed.usage.prompt_tokens || 0;
                        completionTokens = parsed.usage.completion_tokens || 0;
                    }

                    const delta = parsed.choices?.[0]?.delta;
                    const content = delta?.content || '';
                    if (content) {
                        fullContent += content;
                        try { onData(content); } catch(e) {}
                    }
                    const reasoning = delta?.reasoning_content || '';
                    if (reasoning) {
                        fullThinking += reasoning;
                        if (onThinking) { try { onThinking(reasoning); } catch(e) {} }
                    }
                } catch (e) {
                    console.log('[Local Copilot] Failed to parse SSE line:', trimmed.substring(0, 50));
                }
            }
        });

        stream.on('end', () => {
            if (settled) return;
            settled = true;
            const stats: ResponseStats | undefined = completionTokens > 0
                ? { tokenCount: completionTokens }
                : undefined;
            const thinking = fullThinking || undefined;
            resolve({ content: fullContent, stats, thinking });
        });

        stream.on('error', (err: Error) => {
            if (!settled) {
                settled = true;
                reject(new Error(`Stream error: ${err.message}`));
            }
        });

        stream.on('close', () => {
            if (!settled) {
                settled = true;
                if (fullContent.length > 0) {
                    const stats: ResponseStats | undefined = completionTokens > 0
                        ? { tokenCount: completionTokens }
                        : undefined;
                    const thinking = fullThinking || undefined;
                    resolve({ content: fullContent, stats, thinking });
                } else {
                    reject(new Error('Stream closed without response'));
                }
            }
        });
    });
}

export class OllamaProvider implements AIProvider {
    private abortController: AbortController | null = null;
    private endpoint: string;
    private model: string;

    constructor(modelOverride?: string) {
        const config = vscode.workspace.getConfiguration('local-copilot');
        this.endpoint = config.get<string>('ollamaEndpoint', 'http://127.0.0.1:11434');
        this.model = modelOverride || config.get<string>('ollamaModel', 'qwen2.5-coder:3b');
        console.log('[Local Copilot] Created OllamaProvider with endpoint:', this.endpoint, 'model:', this.model);
    }

    private isImageError(contentOrMsg: string): boolean {
        const lower = contentOrMsg.toLowerCase();
        if (!lower.includes('image')) return false;
        if (lower.includes('does not support')) return true;
        if (lower.includes('not support')) return true;
        if (lower.includes('no support')) return true;
        if (lower.includes('unsupported')) return true;
        if (lower.includes('cannot read') || lower.includes('can not read')) return true;
        return false;
    }

    async sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        const hasImages = messages.some(m => m.images && m.images.length > 0);

        // Try with images first (buffered — don't stream to user yet so we can detect image errors)
        if (hasImages) {
            const ollamaMessagesWithImages = messages.map(msg => {
                const m: any = { role: msg.role, content: msg.content };
                if (msg.images && msg.images.length > 0) {
                    m.images = msg.images.map(i => i.base64);
                }
                return m;
            });

            const bodyWithImages = JSON.stringify({
                model: this.model,
                messages: ollamaMessagesWithImages,
                stream: true
            });

            const url = `${this.endpoint}/api/chat`;
            console.log('[Local Copilot] Ollama sending request with images to:', url, 'model:', this.model);

            try {
                const response = await makeRequest(
                    url,
                    'POST',
                    { 'Content-Type': 'application/json' },
                    bodyWithImages,
                    this.abortController.signal
                );

                if (response.status < 200 || response.status >= 300) {
                    const errorBody = await new Promise<string>((resolve) => {
                        let data = '';
                        response.body.setEncoding('utf-8');
                        response.body.on('data', (chunk: string) => { data += chunk; });
                        response.body.on('end', () => resolve(data));
                        response.body.on('close', () => resolve(data));
                    });
                    // Check if error is image-related
                    if (this.isImageError(errorBody)) {
                        console.log('[Local Copilot] Model does not support images, falling back to text');
                        // fall through to text-only retry
                    } else {
                        throw new Error(`Ollama API error ${response.status}: ${errorBody.substring(0, 200)}`);
                    }
                } else {
                    // Buffer the response — don't stream to user yet so we can check for image errors
                    const noop = () => {};
                    const result = await readStream(response.body, noop, onThinking);
                    if (this.isImageError(result.content)) {
                        console.log('[Local Copilot] Model does not support images (in content), falling back to text');
                        // fall through to text-only retry
                    } else {
                        // Good response — now stream it to the user
                        try { onChunk(result.content); } catch (e) {}
                        console.log('[Local Copilot] Stream completed, total chars:', result.content.length, 'stats:', result.stats, 'thinking:', result.thinking ? result.thinking.length + ' chars' : 'none');
                        return { content: result.content, stats: result.stats, thinking: result.thinking };
                    }
                }
            } catch (err: any) {
                if (this.isImageError(err.message || '')) {
                    console.log('[Local Copilot] Image error caught, falling back to text-only');
                    // fall through
                } else {
                    throw err;
                }
            }
        }

        // Retry without images (or initial request if no images)
        const ollamaMessages = messages.map(msg => {
            const m: any = { role: msg.role, content: msg.content };
            if (msg.images && msg.images.length > 0 && hasImages) {
                // Strip images for non-vision model
            }
            return m;
        });

        const body = JSON.stringify({
            model: this.model,
            messages: ollamaMessages,
            stream: true
        });

        const url = `${this.endpoint}/api/chat`;
        console.log('[Local Copilot] Ollama sending request to:', url, 'model:', this.model);
        console.log('[Local Copilot] Messages count:', messages.length);

        let response: { status: number; body: http.IncomingMessage };
        try {
            response = await makeRequest(
                url,
                'POST',
                { 'Content-Type': 'application/json' },
                body,
                this.abortController.signal
            );
        } catch (err: any) {
            console.error('[Local Copilot] Ollama request failed:', err.message);
            throw new Error(`Failed to connect to Ollama at ${this.endpoint}: ${err.message}`);
        }

        console.log('[Local Copilot] Response status:', response.status);

        if (response.status < 200 || response.status >= 300) {
            const errorBody = await new Promise<string>((resolve) => {
                let data = '';
                response.body.setEncoding('utf-8');
                response.body.on('data', (chunk: string) => { data += chunk; });
                response.body.on('end', () => resolve(data));
                response.body.on('close', () => resolve(data));
            });
            console.log('[Local Copilot] Error body:', errorBody.substring(0, 200));
            throw new Error(`Ollama API error ${response.status}: ${errorBody.substring(0, 200)}`);
        }

        const result = await readStream(response.body, onChunk, onThinking);
        const prefix = hasImages ? '⚠️ The model does not support image input. Only text was sent.\n\n' : '';
        console.log('[Local Copilot] Stream completed, total chars:', result.content.length, 'stats:', result.stats, 'thinking:', result.thinking ? result.thinking.length + ' chars' : 'none');
        return { content: prefix + result.content, stats: result.stats, thinking: result.thinking };
    }

    abort(): void {
        console.log('[Local Copilot] Aborting request');
        this.abortController?.abort();
        this.abortController = null;
    }
}

export class OpenAIProvider implements AIProvider {
    private abortController: AbortController | null = null;
    private apiKey: string;
    private model: string;
    private endpoint: string;

    constructor() {
        const config = vscode.workspace.getConfiguration('local-copilot');
        this.apiKey = config.get<string>('openaiApiKey', '');
        this.model = config.get<string>('openaiModel', 'gpt-4o');
        this.endpoint = config.get<string>('openaiEndpoint', 'https://api.openai.com/v1');
    }

    async sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        if (!this.apiKey) {
            throw new Error('OpenAI API key not configured. Set it in settings: local-copilot.openaiApiKey');
        }

        const body = JSON.stringify({
            model: this.model,
            messages: messages,
            stream: true
        });

        const response = await makeRequest(
            `${this.endpoint}/chat/completions`,
            'POST',
            {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body,
            this.abortController.signal
        );

        if (response.status < 200 || response.status >= 300) {
            const errorBody = await new Promise<string>((resolve) => {
                let data = '';
                response.body.setEncoding('utf-8');
                response.body.on('data', (chunk: string) => { data += chunk; });
                response.body.on('end', () => resolve(data));
                response.body.on('close', () => resolve(data));
            });
            throw new Error(`OpenAI API error ${response.status}: ${errorBody.substring(0, 200)}`);
        }

        const startTimeOai = Date.now();
        const result3 = await readSSEStream(response.body, onChunk, onThinking);
        const durationMsOai = Date.now() - startTimeOai;
        const statsOai = result3.stats || {};
        if (!statsOai.durationMs) statsOai.durationMs = durationMsOai;
        return { content: result3.content, stats: statsOai, thinking: result3.thinking };
    }

    abort(): void {
        this.abortController?.abort();
        this.abortController = null;
    }
}

export class CopilotWebProvider implements AIProvider {
    private abortController: AbortController | null = null;

    async sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        try {
            const copilotExtension = vscode.extensions.getExtension('GitHub.copilot');
            if (!copilotExtension) {
                throw new Error('GitHub Copilot extension not found. Please install it first.');
            }

            const copilotApi = copilotExtension.exports;
            if (!copilotApi?.getChatCompletions) {
                throw new Error('GitHub Copilot API not available. Make sure you are signed in.');
            }

            const result = await copilotApi.getChatCompletions({
                messages: messages,
                stream: true,
                onChunk: (chunk: string) => {
                    onChunk(chunk);
                }
            });

            return { content: result.content || '' };
        } catch (error: any) {
            throw new Error(`Copilot API error: ${error.message}`);
        }
    }

    abort(): void {
        this.abortController?.abort();
        this.abortController = null;
    }
}

export class JanAIProvider implements AIProvider {
    private abortController: AbortController | null = null;
    private endpoint: string;
    private model: string;

    constructor(modelOverride?: string) {
        const config = vscode.workspace.getConfiguration('local-copilot');
        this.endpoint = config.get<string>('janaiEndpoint', 'http://127.0.0.1:1337/v1');
        this.model = modelOverride || config.get<string>('janaiModel', '');
        console.log('[Local Copilot] Created JanAIProvider with endpoint:', this.endpoint, 'model:', this.model);
    }

    async sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        const bodyObj: any = {
            messages: messages,
            stream: true
        };
        if (this.model) {
            bodyObj.model = this.model;
        }
        const body = JSON.stringify(bodyObj);

        const url = `${this.endpoint}/chat/completions`;
        console.log('[Local Copilot] JAN AI sending request to:', url, 'model:', this.model || '(auto)');

        let response: { status: number; body: http.IncomingMessage };
        try {
            response = await makeRequest(
                url,
                'POST',
                { 'Content-Type': 'application/json' },
                body,
                this.abortController.signal
            );
        } catch (err: any) {
            console.error('[Local Copilot] JAN AI request failed:', err.message);
            throw new Error(`Failed to connect to JAN AI at ${this.endpoint}: ${err.message}`);
        }

        console.log('[Local Copilot] JAN AI response status:', response.status);

        if (response.status < 200 || response.status >= 300) {
            const errorBody = await new Promise<string>((resolve) => {
                let data = '';
                response.body.setEncoding('utf-8');
                response.body.on('data', (chunk: string) => { data += chunk; });
                response.body.on('end', () => resolve(data));
                response.body.on('close', () => resolve(data));
            });
            console.log('[Local Copilot] JAN AI error body:', errorBody.substring(0, 200));
            throw new Error(`JAN AI API error ${response.status}: ${errorBody.substring(0, 200)}`);
        }

        const startTime = Date.now();
        const result = await readSSEStream(response.body, onChunk, onThinking);
        const durationMs = Date.now() - startTime;
        const stats = result.stats || {};
        if (!stats.durationMs) stats.durationMs = durationMs;
        return { content: result.content, stats, thinking: result.thinking };
    }

    abort(): void {
        this.abortController?.abort();
        this.abortController = null;
    }
}

export class VSCodeLMProvider implements AIProvider {
    private abortController: AbortController | null = null;
    private model: string;

    constructor(modelOverride?: string) {
        this.model = modelOverride || '';
    }

    private buildLMmsg(messages: ChatMessage[], stripImages: boolean): vscode.LanguageModelChatMessage[] {
        const lmMessages: vscode.LanguageModelChatMessage[] = [];
        for (const msg of messages) {
            if (!stripImages && msg.images && msg.images.length > 0) {
                const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [];
                if (msg.content) {
                    parts.push(new vscode.LanguageModelTextPart(msg.content));
                }
                for (const img of msg.images) {
                    parts.push(vscode.LanguageModelDataPart.image(Buffer.from(img.base64, 'base64'), img.mimeType));
                }
                lmMessages.push(vscode.LanguageModelChatMessage.User(parts));
            } else if (msg.role === 'assistant') {
                lmMessages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
            } else {
                lmMessages.push(vscode.LanguageModelChatMessage.User(msg.content));
            }
        }
        return lmMessages;
    }

    private async doStream(model: vscode.LanguageModelChat, lmMessages: vscode.LanguageModelChatMessage[], onChunk: (chunk: string) => void, skipOutput: boolean = false): Promise<string> {
        const tokenSource = new vscode.CancellationTokenSource();
        this.abortController?.signal.addEventListener('abort', () => tokenSource.cancel(), { once: true });

        let fullContent = '';
        const response = await model.sendRequest(lmMessages, {}, tokenSource.token);
        for await (const part of response.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
                fullContent += part.value;
                if (!skipOutput) { try { onChunk(part.value); } catch (e) {} }
            } else if (part instanceof vscode.LanguageModelDataPart) {
                const dataUrl = dataPartToDataUrl(part);
                if (dataUrl) {
                    const imgMd = `![image](${dataUrl})`;
                    fullContent += imgMd;
                    if (!skipOutput) { try { onChunk(imgMd); } catch (e) {} }
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                const toolText = `\`[Tool: ${part.name}(${JSON.stringify(part.input)})]\``;
                fullContent += toolText;
                if (!skipOutput) { try { onChunk(toolText); } catch (e) {} }
            }
        }
        return fullContent;
    }

    private isImageError(content: string): boolean {
        const lower = content.toLowerCase();
        if (!lower.includes('image')) return false;
        if (lower.includes('does not support')) return true;
        if (lower.includes('not support')) return true;
        if (lower.includes('no support')) return true;
        if (lower.includes('unsupported')) return true;
        if (lower.includes('cannot read') || lower.includes('can not read')) return true;
        return false;
    }

    async sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        const models = await vscode.lm.selectChatModels();
        console.log('[Local Copilot] VSCodeLM available models:', models.map(m => ({ id: m.id, name: m.name, family: m.family, vendor: m.vendor })));
        if (models.length === 0) {
            throw new Error('No language models available via VS Code LM API. Install a model provider extension (e.g., GitHub Copilot) and sign in.');
        }

        let selectedModel = models[0];
        if (this.model) {
            const found = models.find(m => m.id === this.model || m.name === this.model || m.family === this.model);
            if (found) selectedModel = found;
        }
        console.log('[Local Copilot] VSCodeLM selected model:', selectedModel.id, selectedModel.name, selectedModel.family, selectedModel.vendor);

        const hasImages = messages.some(m => m.images && m.images.length > 0);

        // Try with images first (buffered — don't stream yet so we can detect image errors)
        if (hasImages) {
            const lmWithImages = this.buildLMmsg(messages, false);
            try {
                const content = await this.doStream(selectedModel, lmWithImages, onChunk, true);
                if (this.isImageError(content)) {
                    // Model responded with image error — fall through to retry
                } else {
                    // Good response — now stream it to the user
                    try { onChunk(content); } catch (e) {}
                    return { content };
                }
            } catch (err: any) {
                if (err instanceof vscode.LanguageModelError) {
                    // VS Code LM API rejected images (any LanguageModelError during image send)
                    console.log('[Local Copilot] VS Code LM API rejected images, falling back to text-only, code:', err.code, 'message:', err.message);
                } else if (!err.message?.toLowerCase().includes('image')) {
                    throw err;
                }
                // API rejected images — fall through to retry
            }
        }

        // Retry without images
        const lmTextOnly = this.buildLMmsg(messages, true);
        try {
            const content = await this.doStream(selectedModel, lmTextOnly, onChunk);
            const prefix = hasImages ? '⚠️ The model does not support image input. Only text was sent.\n\n' : '';
            return { content: prefix + content };
        } catch (err: any) {
            if (err.message?.includes('cancel')) throw err;
            throw new Error(`VS Code LM API error: ${err.message}`);
        }
    }

    abort(): void {
        this.abortController?.abort();
        this.abortController = null;
    }
}

function dataPartToDataUrl(part: vscode.LanguageModelDataPart): string | undefined {
    if (part.mimeType.startsWith('image/')) {
        const base64 = Buffer.from(part.data).toString('base64');
        return `data:${part.mimeType};base64,${base64}`;
    }
    if (part.mimeType === 'text/plain' || part.mimeType === 'text/markdown') {
        const text = Buffer.from(part.data).toString('utf-8');
        return `data:${part.mimeType};charset=utf-8,${encodeURIComponent(text)}`;
    }
    return undefined;
}

export function createAIProvider(type: string, modelOverride?: string): AIProvider {
    console.log('[Local Copilot] Creating AI provider of type:', type, 'model override:', modelOverride);
    switch (type) {
        case 'ollama':
            return new OllamaProvider(modelOverride);
        case 'lmstudio':
            return new LMStudioProvider(modelOverride);
        case 'janai':
            return new JanAIProvider(modelOverride);
        case 'openai':
            return new OpenAIProvider();
        case 'copilot-web':
            return new CopilotWebProvider();
        case 'vscode-lm':
            return new VSCodeLMProvider(modelOverride);
        default:
            return new OllamaProvider(modelOverride);
    }
}

export class LMStudioProvider implements AIProvider {
    private abortController: AbortController | null = null;
    private endpoint: string;
    private model: string;

    constructor(modelOverride?: string) {
        const config = vscode.workspace.getConfiguration('local-copilot');
        this.endpoint = config.get<string>('lmstudioEndpoint', 'http://127.0.0.1:1234/v1');
        this.model = modelOverride || config.get<string>('lmstudioModel', '');
        console.log('[Local Copilot] Created LMStudioProvider with endpoint:', this.endpoint, 'model:', this.model);
    }

    async sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        const bodyObj: any = {
            messages: messages,
            stream: true
        };
        if (this.model) {
            bodyObj.model = this.model;
        }
        const body = JSON.stringify(bodyObj);

        const url = `${this.endpoint}/chat/completions`;
        console.log('[Local Copilot] LM Studio sending request to:', url, 'model:', this.model || '(auto)');

        let response: { status: number; body: http.IncomingMessage };
        try {
            response = await makeRequest(
                url,
                'POST',
                { 'Content-Type': 'application/json' },
                body,
                this.abortController.signal
            );
        } catch (err: any) {
            console.error('[Local Copilot] LM Studio request failed:', err.message);
            throw new Error(`Failed to connect to LM Studio at ${this.endpoint}: ${err.message}`);
        }

        console.log('[Local Copilot] LM Studio response status:', response.status);

        if (response.status < 200 || response.status >= 300) {
            const errorBody = await new Promise<string>((resolve) => {
                let data = '';
                response.body.setEncoding('utf-8');
                response.body.on('data', (chunk: string) => { data += chunk; });
                response.body.on('end', () => resolve(data));
                response.body.on('close', () => resolve(data));
            });
            console.log('[Local Copilot] LM Studio error body:', errorBody.substring(0, 200));
            throw new Error(`LM Studio API error ${response.status}: ${errorBody.substring(0, 200)}`);
        }

        const startTimeLm = Date.now();
        const result = await readSSEStream(response.body, onChunk, onThinking);
        const durationMsLm = Date.now() - startTimeLm;
        const stats = result.stats || {};
        if (!stats.durationMs) stats.durationMs = durationMsLm;
        return { content: result.content, stats, thinking: result.thinking };
    }

    abort(): void {
        this.abortController?.abort();
        this.abortController = null;
    }
}