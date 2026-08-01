import * as https from 'https';
import * as http from 'http';
import { getProviderConfig, getProviderType } from './config';
import { AIProvider, ChatMessage, ResponseStats } from './types';
import { IMAGE_STRIPPED_NOTE } from './types';

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
                        try { onData(parsed.message.content); } catch (e) {}
                    }
                    if (parsed.message?.reasoning_content) {
                        fullThinking += parsed.message.reasoning_content;
                        if (onThinking) { try { onThinking(parsed.message.reasoning_content); } catch (e) {} }
                    }
                    if (parsed.done) {
                        console.log('[Maggot] Stream done signal received');
                        if (parsed.eval_count !== undefined) evalCount = parsed.eval_count;
                        if (parsed.eval_duration !== undefined) evalDurationNs = parsed.eval_duration;
                        if (parsed.prompt_eval_count !== undefined) promptEvalCount = parsed.prompt_eval_count;
                    }
                } catch (e) {
                    console.log('[Maggot] Failed to parse line:', trimmed.substring(0, 50));
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
                        try { onData(parsed.message.content); } catch (e) {}
                    }
                    if (parsed.message?.reasoning_content) {
                        fullThinking += parsed.message.reasoning_content;
                        if (onThinking) { try { onThinking(parsed.message.reasoning_content); } catch (e) {} }
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
                        try { onData(content); } catch (e) {}
                    }
                    const reasoning = delta?.reasoning_content || '';
                    if (reasoning) {
                        fullThinking += reasoning;
                        if (onThinking) { try { onThinking(reasoning); } catch (e) {} }
                    }
                } catch (e) {
                    console.log('[Maggot] Failed to parse SSE line:', trimmed.substring(0, 50));
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

    constructor(providerId: string = 'ollama', modelOverride?: string) {
        const cfg = getProviderConfig(providerId);
        this.endpoint = cfg.endpoint || 'http://127.0.0.1:11434';
        this.model = modelOverride || cfg.model || 'qwen2.5-coder:3b';
        console.log('[Maggot] Created OllamaProvider with endpoint:', this.endpoint, 'model:', this.model);
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
            console.log('[Maggot] Ollama sending request with images to:', url, 'model:', this.model);

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
                        console.log('[Maggot] Model does not support images, falling back to text');
                        // fall through to text-only retry
                    } else {
                        throw new Error(`Ollama API error ${response.status}: ${errorBody.substring(0, 200)}`);
                    }
                } else {
                    // Buffer the response — don't stream to user yet so we can check for image errors
                    const noop = () => {};
                    const result = await readStream(response.body, noop, onThinking);
                    if (this.isImageError(result.content)) {
                        console.log('[Maggot] Model does not support images (in content), falling back to text');
                        // fall through to text-only retry
                    } else {
                        // Good response — now stream it to the user
                        try { onChunk(result.content); } catch (e) {}
                        console.log('[Maggot] Stream completed, total chars:', result.content.length, 'stats:', result.stats, 'thinking:', result.thinking ? result.thinking.length + ' chars' : 'none');
                        return { content: result.content, stats: result.stats, thinking: result.thinking };
                    }
                }
            } catch (err: any) {
                if (this.isImageError(err.message || '')) {
                    console.log('[Maggot] Image error caught, falling back to text-only');
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
                m.content = (msg.content ? msg.content + '\n\n' : '') + IMAGE_STRIPPED_NOTE;
            }
            return m;
        });

        const body = JSON.stringify({
            model: this.model,
            messages: ollamaMessages,
            stream: true
        });

        const url = `${this.endpoint}/api/chat`;
        console.log('[Maggot] Ollama sending request to:', url, 'model:', this.model);
        console.log('[Maggot] Messages count:', messages.length);

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
            console.error('[Maggot] Ollama request failed:', err.message);
            throw new Error(`Failed to connect to Ollama at ${this.endpoint}: ${err.message}`);
        }

        console.log('[Maggot] Response status:', response.status);

        if (response.status < 200 || response.status >= 300) {
            const errorBody = await new Promise<string>((resolve) => {
                let data = '';
                response.body.setEncoding('utf-8');
                response.body.on('data', (chunk: string) => { data += chunk; });
                response.body.on('end', () => resolve(data));
                response.body.on('close', () => resolve(data));
            });
            console.log('[Maggot] Error body:', errorBody.substring(0, 200));
            throw new Error(`Ollama API error ${response.status}: ${errorBody.substring(0, 200)}`);
        }

        const result = await readStream(response.body, onChunk, onThinking);
        const prefix = hasImages ? '⚠️ The model does not support image input. Only text was sent.\n\n' : '';
        // If the model still replies with an image-unsupported error, drop it — the prefix already says this once
        let finalContent = result.content;
        if (hasImages && this.isImageError(finalContent)) {
            finalContent = '';
        }
        console.log('[Maggot] Stream completed, total chars:', result.content.length, 'stats:', result.stats, 'thinking:', result.thinking ? result.thinking.length + ' chars' : 'none');
        return { content: prefix + finalContent, stats: result.stats, thinking: result.thinking };
    }

    abort(): void {
        console.log('[Maggot] Aborting request');
        this.abortController?.abort();
        this.abortController = null;
    }
}

export class OpenAIProvider implements AIProvider {
    private abortController: AbortController | null = null;
    private apiKey: string;
    private model: string;
    private endpoint: string;
    private providerId: string;

    constructor(providerId: string = 'openai') {
        const cfg = getProviderConfig(providerId);
        this.providerId = providerId;
        this.apiKey = cfg.apiKey || '';
        this.model = cfg.model || 'gpt-4o';
        this.endpoint = cfg.endpoint || 'https://api.openai.com/v1';
    }

    async sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }> {
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();

        if (!this.apiKey && this.providerId === 'openai') {
            throw new Error('OpenAI API key not configured. Set it in the Settings (⚙) button.');
        }

        const bodyObj: any = {
            messages: messages,
            stream: true
        };
        if (this.model) {
            bodyObj.model = this.model;
        }
        const body = JSON.stringify(bodyObj);

        const headers: any = { 'Content-Type': 'application/json' };
        if (this.apiKey) {
            headers['Authorization'] = `Bearer ${this.apiKey}`;
        }

        const response = await makeRequest(
            `${this.endpoint}/chat/completions`,
            'POST',
            headers,
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

export class JanAIProvider implements AIProvider {
    private abortController: AbortController | null = null;
    private endpoint: string;
    private model: string;

    constructor(providerId: string = 'janai', modelOverride?: string) {
        const cfg = getProviderConfig(providerId);
        this.endpoint = cfg.endpoint || 'http://127.0.0.1:1337/v1';
        this.model = modelOverride || cfg.model || '';
        console.log('[Maggot] Created JanAIProvider with endpoint:', this.endpoint, 'model:', this.model);
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
        console.log('[Maggot] JAN AI sending request to:', url, 'model:', this.model || '(auto)');

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
            console.error('[Maggot] JAN AI request failed:', err.message);
            throw new Error(`Failed to connect to JAN AI at ${this.endpoint}: ${err.message}`);
        }

        console.log('[Maggot] JAN AI response status:', response.status);

        if (response.status < 200 || response.status >= 300) {
            const errorBody = await new Promise<string>((resolve) => {
                let data = '';
                response.body.setEncoding('utf-8');
                response.body.on('data', (chunk: string) => { data += chunk; });
                response.body.on('end', () => resolve(data));
                response.body.on('close', () => resolve(data));
            });
            console.log('[Maggot] JAN AI error body:', errorBody.substring(0, 200));
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

export class LMStudioProvider implements AIProvider {
    private abortController: AbortController | null = null;
    private endpoint: string;
    private model: string;

    constructor(providerId: string = 'lmstudio', modelOverride?: string) {
        const cfg = getProviderConfig(providerId);
        this.endpoint = cfg.endpoint || 'http://127.0.0.1:1234/v1';
        this.model = modelOverride || cfg.model || '';
        console.log('[Maggot] Created LMStudioProvider with endpoint:', this.endpoint, 'model:', this.model);
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
        console.log('[Maggot] LM Studio sending request to:', url, 'model:', this.model || '(auto)');

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
            console.error('[Maggot] LM Studio request failed:', err.message);
            throw new Error(`Failed to connect to LM Studio at ${this.endpoint}: ${err.message}`);
        }

        console.log('[Maggot] LM Studio response status:', response.status);

        if (response.status < 200 || response.status >= 300) {
            const errorBody = await new Promise<string>((resolve) => {
                let data = '';
                response.body.setEncoding('utf-8');
                response.body.on('data', (chunk: string) => { data += chunk; });
                response.body.on('end', () => resolve(data));
                response.body.on('close', () => resolve(data));
            });
            console.log('[Maggot] LM Studio error body:', errorBody.substring(0, 200));
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

export function createCoreProvider(type: string, modelOverride?: string): AIProvider {
    const connType = getProviderType(type);
    switch (connType) {
        case 'ollama':
            return new OllamaProvider(type, modelOverride);
        case 'openai':
            if (type === 'lmstudio') return new LMStudioProvider(type, modelOverride);
            if (type === 'janai') return new JanAIProvider(type, modelOverride);
            return new OpenAIProvider(type);
        default:
            return new OpenAIProvider(type);
    }
}

function httpGetJson(url: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`Provider returned ${res.statusCode}: ${data.substring(0, 200)}`));
                    return;
                }
                resolve(data);
            });
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error('Request timed out'));
            reject(new Error('Request timed out'));
        });
        req.on('error', (err) => {
            reject(new Error(err.message));
        });
    });
}

export async function fetchOllamaModels(providerId: string = 'ollama'): Promise<string[]> {
    const cfg = getProviderConfig(providerId);
    const endpoint = cfg.endpoint || 'http://127.0.0.1:11434';
    const url = `${endpoint}/api/tags`;
    console.log('[Maggot] Fetching models from:', url);
    try {
        const data = await httpGetJson(url, 10000);
        const parsed = JSON.parse(data);
        const models = (parsed.models || []).map((m: any) => m.name).sort();
        console.log('[Maggot] Found models:', models);
        return models;
    } catch (err: any) {
        throw new Error(`Cannot connect to Ollama at ${endpoint}: ${err.message}`);
    }
}

export async function fetchOpenAICompatibleModels(providerId: string): Promise<string[]> {
    const cfg = getProviderConfig(providerId);
    const endpoint = cfg.endpoint || 'http://127.0.0.1:1234/v1';
    const url = `${endpoint}/models`;
    console.log('[Maggot] Fetching OpenAI-compatible models from:', url);
    try {
        const data = await httpGetJson(url, 10000);
        const parsed = JSON.parse(data);
        const models = (parsed.data || []).map((m: any) => m.id).sort();
        console.log('[Maggot] Found models:', models);
        return models;
    } catch (err: any) {
        throw new Error(`Cannot connect to provider at ${endpoint}: ${err.message}`);
    }
}

export async function fetchOllamaContextSize(providerId: string, modelName: string): Promise<number> {
    const cfg = getProviderConfig(providerId);
    const endpoint = cfg.endpoint || 'http://127.0.0.1:11434';
    const url = `${endpoint}/api/show`;
    console.log('[Maggot] Fetching context size for:', modelName);
    try {
        const data = await new Promise<string>((resolve, reject) => {
            const lib = url.startsWith('https:') ? https : http;
            const req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
                let d = '';
                res.on('data', (chunk: Buffer) => { d += chunk.toString(); });
                res.on('end', () => resolve(d));
            });
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('timed out')); });
            req.on('error', (err) => reject(err));
            req.write(JSON.stringify({ model: modelName }));
            req.end();
        });
        const parsed = JSON.parse(data);
        const modelInfo = parsed.model_info || {};
        let ctxLen = 0;
        for (const key of Object.keys(modelInfo)) {
            if (key.toLowerCase().includes('context_length')) {
                ctxLen = Number(modelInfo[key]) || 0;
                break;
            }
        }
        const size = ctxLen > 0 ? ctxLen : 0;
        console.log('[Maggot] Context size for', modelName, ':', size);
        return size;
    } catch {
        return 0;
    }
}
