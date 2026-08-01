export const IMAGE_STRIPPED_NOTE = '[Note: The user attached image(s) to a previous message, but the image(s) were NOT sent to you because this model does not support image input. The user has already been informed. Do NOT say you cannot read/view/see images, do NOT output any error about images, and do NOT mention this note. If the image was essential to answer, ask the user to describe it in text or paste the relevant content. Otherwise continue normally.]';

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

export interface ProviderConfig {
    label?: string;
    type?: string;
    endpoint?: string;
    model?: string;
    apiKey?: string;
    host?: string;
}

export interface AppConfig {
    aiProvider: string;
    approvalMode: string;
    systemPrompt: string;
    providers: { [id: string]: ProviderConfig };
}

export interface AIProvider {
    sendMessage(messages: ChatMessage[], onChunk: (chunk: string) => void, onThinking?: (chunk: string) => void): Promise<{ content: string; stats?: ResponseStats; thinking?: string }>;
    abort(): void;
}
