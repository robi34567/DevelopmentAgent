import * as vscode from 'vscode';
import { getProviderType } from './config';
import { AIProvider, ChatMessage, ResponseStats } from './core/types';
import { IMAGE_STRIPPED_NOTE } from './core/types';
import { createCoreProvider, OllamaProvider, OpenAIProvider, JanAIProvider, LMStudioProvider } from './core/providers';

export { AIProvider, ChatMessage, ChatMessageImage, ResponseStats, IMAGE_STRIPPED_NOTE } from './core/types';
export { OllamaProvider, OpenAIProvider, JanAIProvider, LMStudioProvider } from './core/providers';

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
        if (hasImages) {
            lmTextOnly.push(vscode.LanguageModelChatMessage.User(IMAGE_STRIPPED_NOTE));
        }
        try {
            const content = await this.doStream(selectedModel, lmTextOnly, onChunk);
            const prefix = hasImages ? '⚠️ The model does not support image input. Only text was sent.\n\n' : '';
            let finalContent = content;
            if (hasImages && this.isImageError(finalContent)) {
                finalContent = '';
            }
            return { content: prefix + finalContent };
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
    const connType = getProviderType(type);
    switch (connType) {
        case 'ollama':
            return new OllamaProvider(type, modelOverride);
        case 'openai':
            return createCoreProvider(type, modelOverride);
        case 'copilot-web':
            return new CopilotWebProvider();
        case 'vscode-lm':
            return new VSCodeLMProvider(modelOverride);
        default:
            return createCoreProvider(type, modelOverride);
    }
}
