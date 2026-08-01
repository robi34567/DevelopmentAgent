import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AppConfig, ProviderConfig } from './types';

export { AppConfig, ProviderConfig } from './types';

const BUILTIN_TYPES: { [id: string]: string } = {
    ollama: 'ollama',
    lmstudio: 'openai',
    janai: 'openai',
    openai: 'openai',
    'copilot-web': 'copilot-web',
    'vscode-lm': 'vscode-lm'
};

export const DEFAULT_SYSTEM_PROMPT = "You are a local AI assistant with access to the user's terminal. You can run commands and see their output.\n\nWhen you need to run a command, wrap it in [CMD]command here[/CMD]. The command will be executed and you will receive the output automatically. You can then analyze the results and continue.\n\nRules:\n- Use [CMD]...[/CMD] to run any shell command (ls, cat, git, npm, etc.)\n- You will receive the output between [OUTPUT]...[/OUTPUT] or [ERROR]...[/ERROR] markers\n- Analyze the output and continue your work\n- You can run multiple commands in sequence\n- Be concise and helpful\n- If a command might be destructive, warn the user first\n- Never claim to be made by any specific company - you are a local model running on this machine\n- If you need to ask the user a question or clarify requirements, use [ASK]your question here[/ASK] and wait for their answer before proceeding\n- When the user asks you to offer choices or options, you MUST respond with the tag [CHOICES]option 1|option 2|option 3[/CHOICES] (pipe-separated, always include the closing [/CHOICES] tag). The user will click one and you will receive their selection. A 'Custom...' free-text option is ALWAYS added automatically so the user can type their own answer, so do NOT add a 'Custom' or 'Other' option yourself.\n- Use [READ]path/to/file[/READ] to read a file. You will receive its contents in [OUTPUT]. Supports absolute or workspace-relative paths.\n- Use [WRITE]path/to/file\ncontent here[/WRITE] to create or overwrite a file. The first line is the file path, the rest is the content.\n- Use [SEARCH]pattern[/SEARCH] to search file contents in the workspace for a regex pattern.\n- Use [FILES]**\/*.ts[/FILES] to find files matching a glob pattern (use ** for recursive).\n- If the user references an image or picture but you did not receive an image, do NOT say you cannot read images or that images are unsupported. Instead, tell the user you did not receive any image and ask them to attach it or describe it in text.\n- NEVER re-issue a tool call you have already executed. If a [WRITE] or [READ] already succeeded, do not repeat it; use the results you already received and give the final answer.";

const DEFAULT_CONFIG: AppConfig = {
    aiProvider: 'ollama',
    approvalMode: 'safe',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    providers: {
        ollama: { label: 'Ollama (Local)', type: 'ollama', endpoint: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:3b', host: '0.0.0.0' },
        lmstudio: { label: 'LM Studio (Local)', type: 'openai', endpoint: 'http://127.0.0.1:1234/v1', model: '' },
        janai: { label: 'JAN AI (Local)', type: 'openai', endpoint: 'http://127.0.0.1:1337/v1', model: '' },
        openai: { label: 'OpenAI', type: 'openai', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: '' },
        'copilot-web': { label: 'GitHub Copilot', type: 'copilot-web' },
        'vscode-lm': { label: 'VS Code LM API', type: 'vscode-lm', model: '' }
    }
};

let configDir: string = '';
let cached: AppConfig | undefined;

function getConfigDir(): string {
    if (!configDir) {
        configDir = path.join(process.env.USERPROFILE || os.homedir(), '.vscode', 'extensions', 'local-copilot');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
    }
    return configDir;
}

export function getConfigPath(): string {
    return path.join(getConfigDir(), 'config.json');
}

function deepMerge(base: any, override: any): any {
    if (typeof base !== 'object' || base === null || typeof override !== 'object' || override === null) {
        return override !== undefined ? override : base;
    }
    const result: any = { ...base };
    for (const key of Object.keys(override)) {
        result[key] = deepMerge(base[key], override[key]);
    }
    return result;
}

export function loadConfig(): AppConfig {
    if (cached) return cached;
    let fileConfig: any = {};
    try {
        const file = getConfigPath();
        if (fs.existsSync(file)) {
            fileConfig = JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
    } catch (e: any) {
        console.error('[Maggot] Failed to parse config file:', e.message);
    }
    cached = deepMerge(DEFAULT_CONFIG, fileConfig) as AppConfig;
    normalizeConfig(cached);
    return cached;
}

function normalizeConfig(cfg: AppConfig) {
    // Migrate legacy 'vscodeLm' key to 'vscode-lm'
    const prov: any = cfg.providers;
    if (prov.vscodeLm && !prov['vscode-lm']) {
        prov['vscode-lm'] = prov.vscodeLm;
        delete prov.vscodeLm;
    }
    // Ensure every provider has a type and label
    for (const id of Object.keys(prov)) {
        const p = prov[id];
        if (!p.type) p.type = BUILTIN_TYPES[id] || 'openai';
        if (!p.label) p.label = id;
    }
    // Ensure active provider exists
    if (!prov[cfg.aiProvider]) {
        cfg.aiProvider = Object.keys(prov)[0] || 'ollama';
    }
}

export function saveConfig(config: AppConfig): AppConfig {
    cached = config;
    try {
        normalizeConfig(config);
        const file = getConfigPath();
        fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
        return config;
    } catch (e: any) {
        throw new Error(`Failed to save config file: ${e.message}`);
    }
}

export function resetConfigCache() {
    cached = undefined;
}

export function getActiveProvider(fallback?: string): string {
    const cfg = loadConfig();
    return cfg.aiProvider || fallback || 'ollama';
}

export function getSystemPrompt(fallback?: string): string {
    const cfg = loadConfig();
    return cfg.systemPrompt || fallback || DEFAULT_SYSTEM_PROMPT;
}

export function getApprovalMode(): string {
    const cfg = loadConfig();
    return cfg.approvalMode || 'safe';
}

export function getProviderConfig(type: string, fallbacks?: ProviderConfig): ProviderConfig {
    const cfg = loadConfig();
    const prov = (cfg.providers as any)[type] || {};
    const out: ProviderConfig = { ...prov };
    if (fallbacks) {
        for (const key of Object.keys(fallbacks) as (keyof ProviderConfig)[]) {
            const v = fallbacks[key];
            if (v !== undefined && v !== null) {
                const cur = out[key];
                if (cur === undefined || cur === null || cur === '') {
                    (out as any)[key] = v;
                }
            }
        }
    }
    return out;
}

export function getProviderList(): { id: string; label: string }[] {
    const cfg = loadConfig();
    return Object.keys(cfg.providers).map(id => ({
        id,
        label: cfg.providers[id].label || id
    }));
}

export function getProviderType(id: string): string {
    const cfg = loadConfig();
    const prov = (cfg.providers as any)[id];
    if (prov && prov.type) return prov.type;
    return BUILTIN_TYPES[id] || 'openai';
}
