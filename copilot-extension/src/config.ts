import * as vscode from 'vscode';
import {
    AppConfig,
    ProviderConfig,
    getActiveProvider as coreGetActiveProvider,
    getApprovalMode as coreGetApprovalMode,
    getConfigPath as coreGetConfigPath,
    getProviderConfig as coreGetProviderConfig,
    getProviderList as coreGetProviderList,
    getProviderType as coreGetProviderType,
    getSystemPrompt as coreGetSystemPrompt,
    loadConfig as coreLoadConfig,
    saveConfig as coreSaveConfig,
    resetConfigCache as coreResetConfigCache
} from './core/config';

export { ProviderConfig, AppConfig, DEFAULT_SYSTEM_PROMPT } from './core/config';

export function getConfigPath(): string {
    return coreGetConfigPath();
}

export function loadConfig(): AppConfig {
    return coreLoadConfig();
}

export function saveConfig(config: AppConfig): AppConfig {
    return coreSaveConfig(config);
}

export function resetConfigCache() {
    coreResetConfigCache();
}

export function getActiveProvider(): string {
    const vsc = vscode.workspace.getConfiguration('local-copilot');
    return coreGetActiveProvider(vsc.get<string>('aiProvider'));
}

export function getSystemPrompt(): string {
    const vsc = vscode.workspace.getConfiguration('local-copilot');
    return coreGetSystemPrompt(vsc.get<string>('systemPrompt'));
}

export function getApprovalMode(): string {
    return coreGetApprovalMode();
}

export function getProviderConfig(type: string): ProviderConfig {
    const vsc = vscode.workspace.getConfiguration('local-copilot');
    const fallbacks: ProviderConfig = {};
    switch (type) {
        case 'ollama':
            fallbacks.endpoint = vsc.get<string>('ollamaEndpoint');
            fallbacks.model = vsc.get<string>('ollamaModel');
            fallbacks.host = vsc.get<string>('ollamaHost');
            break;
        case 'lmstudio':
            fallbacks.endpoint = vsc.get<string>('lmstudioEndpoint');
            fallbacks.model = vsc.get<string>('lmstudioModel');
            break;
        case 'janai':
            fallbacks.endpoint = vsc.get<string>('janaiEndpoint');
            fallbacks.model = vsc.get<string>('janaiModel');
            break;
        case 'openai':
            fallbacks.endpoint = vsc.get<string>('openaiEndpoint');
            fallbacks.model = vsc.get<string>('openaiModel');
            fallbacks.apiKey = vsc.get<string>('openaiApiKey');
            break;
        case 'vscode-lm':
            fallbacks.model = vsc.get<string>('vscodeLmModel');
            break;
    }
    return coreGetProviderConfig(type, fallbacks);
}

export function getProviderList(): { id: string; label: string }[] {
    return coreGetProviderList();
}

export function getProviderType(id: string): string {
    return coreGetProviderType(id);
}
