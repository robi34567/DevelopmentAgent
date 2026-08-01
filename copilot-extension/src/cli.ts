import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { AgentEngine, EngineEvent } from './core/engine';
import { createCoreProvider, fetchOllamaModels, fetchOpenAICompatibleModels } from './core/providers';
import {
    getActiveProvider,
    getApprovalMode,
    getConfigPath,
    getDataDir,
    getProviderConfig,
    getProviderList,
    getProviderType,
    getSystemPrompt,
    getSelectedAgent,
    loadConfig,
    saveConfig
} from './core/config';
import { listAgents, createAgent, deleteAgent, getAgentsDir } from './core/agents';

const args = process.argv.slice(2);
const workspaceRoot = path.resolve(args[0] || process.cwd());

// ── Logging redirect: keep stdout clean for the REPL ─────────────────────────
const logDir = path.join(getDataDir(), 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `cli-${new Date().toISOString().split('T')[0]}.log`);
function appendLog(line: string) {
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, 'utf-8'); } catch {}
}
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);
console.log = (...a: any[]) => {
    appendLog('[LOG] ' + a.map(x => (typeof x === 'string' ? x : util.inspect(x))).join(' '));
};
console.error = (...a: any[]) => {
    const line = a.map(x => (typeof x === 'string' ? x : util.inspect(x))).join(' ');
    appendLog('[ERR] ' + line);
    origConsoleError(line);
};

// ── Colors ────────────────────────────────────────────────────────────────────
const useColor = !!(process.stdout.isTTY && !process.env.NO_COLOR);
const c = {
    dim: (s: string) => (useColor ? `\x1b[90m${s}\x1b[0m` : s),
    green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
    yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
    red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
    cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
    bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s)
};
function out(text = '') { process.stdout.write(text + '\n'); }

const TOOL_TAG_RE = /\[(CMD|READ|WRITE|SEARCH|FILES|OUTPUT|ERROR|ASK|CHOICES)\][\s\S]*?\[\/\1\]/g;
function cleanContent(text: string): string {
    let prev = '';
    while (prev !== text) {
        prev = text;
        text = text.replace(TOOL_TAG_RE, '');
    }
    const open = text.match(/\[(CMD|READ|WRITE|SEARCH|FILES|OUTPUT|ERROR|ASK|CHOICES)/);
    if (open && open.index !== undefined) return text.substring(0, open.index);
    if (text.endsWith('[')) return text.substring(0, text.length - 1);
    return text;
}

// ── REPL state ────────────────────────────────────────────────────────────────
const rl = readline.createInterface(process.stdin as any, process.stdout as any);

let busy = false;
let exiting = false;
let pendingChoices: string[] | null = null;
let pendingAskResolve: ((v: string) => void) | null = null;
let queuedInput: string[] = [];
let streamLen = 0;
let thinkLen = 0;
let thinkingActive = false;
let contentStarted = false;
let sessionListRequested = false;

function ask(prompt: string): Promise<string> {
    process.stdout.write(prompt);
    return new Promise<string>((resolve) => {
        pendingAskResolve = resolve;
    });
}

function requestApproval(command: string, dangerous: boolean): Promise<boolean> {
    const warn = dangerous ? c.red('⚠ DANGEROUS ') : '';
    return new Promise<boolean>((resolve) => {
        ask(`\n${warn}Allow this command?\n  ${c.yellow('$ ' + command)}\n${c.dim('[y/N]')} `).then(ans => {
            resolve(/^\s*(y|yes)\s*$/i.test(ans));
        });
    });
}

async function askChoice(choices: string[]): Promise<string | null> {
    out();
    choices.forEach((ch, i) => out(`  ${c.cyan((i + 1).toString())}. ${ch}`));
    out(`  ${c.cyan('0')}. ${c.dim('Custom...')}`);
    const ans = await ask(c.dim(`Select [1-${choices.length}] or type custom: `));
    const n = parseInt(ans.trim(), 10);
    if (n >= 1 && n <= choices.length) return choices[n - 1];
    if (ans.trim() === '0' || ans.trim() === '') return null;
    return ans.trim();
}

rl.on('line', (line) => {
    if (pendingAskResolve) {
        const r = pendingAskResolve;
        pendingAskResolve = null;
        r(line);
        return;
    }
    queuedInput.push(line);
    drain();
});

function prompt() {
    if (exiting || busy) return;
    process.stdout.write(c.bold(c.green('maggot')) + c.dim('> '));
}

async function drain() {
    if (busy) return;
    const line = queuedInput.shift();
    if (line === undefined) return;
    busy = true;
    try {
        await handleInput(line);
    } catch (e: any) {
        out(c.red('✖ ' + e.message));
    }
    busy = false;
    if (queuedInput.length > 0) {
        drain();
    } else {
        prompt();
    }
}

function onEvent(evt: EngineEvent) {
    switch (evt.type) {
        case 'startAssistant':
            out();
            streamLen = 0;
            thinkLen = 0;
            thinkingActive = false;
            contentStarted = false;
            break;
        case 'assistantDelta': {
            const clean = cleanContent(evt.content);
            const delta = clean.substring(streamLen);
            if (delta) {
                if (thinkingActive) {
                    process.stderr.write('\n\n');
                    thinkingActive = false;
                }
                contentStarted = true;
                process.stdout.write(delta);
            }
            streamLen = clean.length;
            break;
        }
        case 'updateThinking': {
            const delta = evt.content.substring(thinkLen);
            if (delta && !contentStarted) {
                if (thinkLen === 0) {
                    process.stderr.write('\n' + c.dim('🧠 thinking:') + '\n');
                    thinkingActive = true;
                }
                process.stderr.write(c.dim(delta));
            }
            thinkLen = evt.content.length;
            break;
        }
        case 'finalize':
            out();
            thinkingActive = false;
            contentStarted = false;
            if (evt.model || evt.stats) {
                const parts: string[] = [];
                if (evt.model) parts.push(`model: ${evt.model}`);
                if (evt.stats) {
                    if (evt.stats.durationMs) parts.push(`${evt.stats.durationMs}ms`);
                    if (evt.stats.tokenCount) parts.push(`${evt.stats.tokenCount} tok`);
                    if (evt.stats.promptEvalCount) parts.push(`${evt.stats.promptEvalCount} tok prompt`);
                }
                out(c.dim('⤷ ' + parts.join(' · ')));
            }
            break;
        case 'systemMessage':
            out();
            out(c.yellow('💬 ' + evt.content.split('\n').join('\n   ')));
            break;
        case 'choices':
            pendingChoices = evt.choices;
            break;
        case 'commandOutput':
            if (evt.output) {
                out(c.dim('┌─ ' + evt.output.split('\n').join('\n│  ') + (evt.success ? '' : c.red(' (exit != 0)'))));
                out(c.dim('└─'));
            }
            break;
        case 'executingCommand':
            break;
        case 'error':
            out();
            out(c.red('✖ ' + evt.text));
            break;
        case 'stopped':
            out(c.yellow('■ generation stopped'));
            break;
        case 'compressComplete':
            out(c.dim('✓ history compressed'));
            break;
        case 'clearAndShowCompressed':
            out(c.yellow(`⚠ history compressed (${evt.count} older messages collapsed)`));
            break;
        case 'thinkingToggled':
            out(c.dim(`🧠 thinking display: ${evt.show ? 'on' : 'off'}`));
            break;
        case 'sessionStarted':
            out(c.dim(`[session] new: ${evt.sessionId} (${evt.sessionName})`));
            break;
        case 'sessionSaved':
            out(c.dim(`[session] saved: ${evt.sessionId} (${evt.sessionName})`));
            break;
        case 'sessionLoaded':
            out(c.dim(`[session] loaded: ${evt.sessionId} (${evt.sessionName}) · ${evt.chatHistory.length} messages`));
            break;
        case 'sessionList': {
            if (!sessionListRequested) break;
            sessionListRequested = false;
            out();
            out(c.bold('sessions:'));
            for (const s of evt.sessions) {
                const mark = s.id === evt.activeId ? c.green(' *') : '';
                out(`  ${c.cyan(s.id)}  ${s.name}${mark}  ${c.dim(new Date(s.timestamp).toLocaleString())}`);
            }
            if (evt.sessions.length === 0) out('  (none)');
            break;
        }
        case 'setProvider':
            out(c.dim(`[provider] ${evt.provider}`));
            break;
        case 'setModel':
            out(c.dim(`[model] ${evt.model || '(auto)'}`));
            break;
        case 'setAgent':
            out(c.dim(`[agent] ${evt.agent || 'none'}`));
            break;
        case 'setApproval':
            out(c.dim(`[approval mode] ${evt.mode}`));
            break;
        case 'configSaved':
            out(c.dim(`[config] saved to ${evt.configPath}`));
            break;
        case 'clearThinkingContent':
            thinkLen = 0;
            break;
    }
}

const engine = new AgentEngine({
    emit: onEvent,
    requestApproval: (command, dangerous) => requestApproval(command, dangerous),
    createProvider: (type, modelOverride) => {
        if (type === 'copilot-web' || type === 'vscode-lm') {
            throw new Error(`Provider '${type}' is only available inside VS Code. Use /provider to switch to ollama, openai, lmstudio, or janai.`);
        }
        return createCoreProvider(type, modelOverride);
    },
    getSystemPrompt: () => getSystemPrompt(),
    getActiveProviderId: () => getActiveProvider(),
    getWorkspaceRoot: () => workspaceRoot,
    getConfigPath: () => getConfigPath(),
    loadConfig: () => loadConfig(),
    saveConfig: (cfg) => saveConfig(cfg),
    getProviderConfig: (type) => getProviderConfig(type),
    log: (entry) => appendLog('[ENGINE] ' + entry)
});

function selectAgent(id: string) {
    engine.setAgent(id);
    try {
        const cfg = loadConfig();
        cfg.selectedAgent = id || '';
        saveConfig(cfg);
    } catch {}
}

// ── Commands ──────────────────────────────────────────────────────────────────

function printHelp() {
    out();
    out(c.bold('Maggot CLI commands:'));
    out('  ' + c.cyan('/help') + '            show this help');
    out('  ' + c.cyan('/new') + '             start a new session');
    out('  ' + c.cyan('/sessions') + '         list saved sessions');
    out('  ' + c.cyan('/load <id>') + '       load a session');
    out('  ' + c.cyan('/delete <id>') + '     delete a session');
    out('  ' + c.cyan('/models') + '           list models for the active provider');
    out('  ' + c.cyan('/model <name>') + '    switch model');
    out('  ' + c.cyan('/providers') + '        list providers');
    out('  ' + c.cyan('/provider <id>') + '   switch provider');
    out('  ' + c.cyan('/agents') + '           list agents (.github/agents)');
    out('  ' + c.cyan('/agent') + '            show/select the active agent (none = no agent)');
    out('  ' + c.cyan('/agent new <name> [desc]') + '  create a new agent and select it');
    out('  ' + c.cyan('/agent delete <id>') + ' delete an agent');
    out('  ' + c.cyan('/approval <safe|all>') + '  set approval mode');
    out('  ' + c.cyan('/memorize') + '         save session memory');
    out('  ' + c.cyan('/memorize_global') + '  save global memory');
    out('  ' + c.cyan('/compress') + '         compress chat history now');
    out('  ' + c.cyan('/thinking') + '         toggle thinking display');
    out('  ' + c.cyan('/clear') + '            clear current chat');
    out('  ' + c.cyan('/stop') + '             stop generation');
    out('  ' + c.cyan('/config') + '           show config path');
    out('  ' + c.cyan('/quit') + '            exit (or Ctrl+D)');
    out();
    out(c.dim('Anything else is sent to the AI as a message.'));
}

async function handleCommand(line: string): Promise<boolean> {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
        case 'help':
            printHelp();
            break;
        case 'quit':
        case 'exit':
            exiting = true;
            rl.close();
            return true;
        case 'new':
            engine.newSession();
            break;
        case 'sessions':
            sessionListRequested = true;
            engine.refreshSessionList();
            break;
        case 'load':
            if (!arg) { out(c.red('usage: /load <session id>')); break; }
            engine.loadSession(arg);
            break;
        case 'delete':
            if (!arg) { out(c.red('usage: /delete <session id>')); break; }
            engine.deleteSession(arg);
            break;
        case 'models': {
            const active = getActiveProvider();
            const provType = getProviderType(active);
            try {
                out(c.dim(`fetching models for ${active}...`));
                const models = provType === 'ollama'
                    ? await fetchOllamaModels(active)
                    : await fetchOpenAICompatibleModels(active);
                out();
                out(c.bold(`models (${active}):`));
                models.forEach((m, i) => out(`  ${c.cyan((i + 1).toString())}. ${m}`));
                if (models.length === 0) out('  (none found)');
            } catch (e: any) {
                out(c.red('✖ ' + e.message));
            }
            break;
        }
        case 'model':
            if (!arg) { out(c.red('usage: /model <model name>')); break; }
            engine.changeModel(arg);
            break;
        case 'providers':
            out();
            out(c.bold('providers:'));
            for (const p of getProviderList()) {
                const mark = p.id === getActiveProvider() ? c.green(' *') : '';
                out(`  ${c.cyan(p.id)}  ${p.label}${mark}`);
            }
            break;
        case 'provider': {
            if (!arg) { out(c.red('usage: /provider <provider id>')); break; }
            const valid = getProviderList().some(p => p.id === arg);
            if (!valid) { out(c.red(`unknown provider: ${arg}`)); break; }
            const cfg = loadConfig();
            cfg.aiProvider = arg;
            saveConfig(cfg);
            engine.changeProvider(arg);
            break;
        }
        case 'approval': {
            const mode = arg.toLowerCase();
            if (mode !== 'safe' && mode !== 'all') { out(c.red('usage: /approval <safe|all>')); break; }
            engine.approvalModeValue = mode;
            out(c.dim(`approval mode: ${mode}`));
            break;
        }
        case 'agents': {
            const agents = listAgents(workspaceRoot);
            out();
            out(c.bold('agents:'));
            if (agents.length === 0) out('  (none — use /agent new <name> to create one)');
            for (const a of agents) {
                const mark = a.id === engine.selectedAgentId ? c.green(' *') : '';
                out(`  ${c.cyan(a.id)}  ${a.name}${mark}`);
                if (a.description) out(c.dim(`      ${a.description}`));
            }
            out(c.dim(`dir: ${getAgentsDir(workspaceRoot)}`));
            break;
        }
        case 'agent': {
            const parts = arg.split(/\s+/).filter(Boolean);
            if (parts.length === 0) {
                const cur = engine.selectedAgentId;
                out(cur ? c.dim(`active agent: ${cur}`) : c.dim('active agent: none'));
                break;
            }
            if (parts[0] === 'new') {
                const name = parts.slice(1).join(' ');
                if (!name) { out(c.red('usage: /agent new <name> [description]')); break; }
                try {
                    const agent = createAgent(workspaceRoot, { name });
                    selectAgent(agent.id);
                    out(c.green(`✓ agent "${agent.name}" created and selected:`));
                    out(c.dim(`  ${agent.filePath}`));
                } catch (e: any) {
                    out(c.red('✖ ' + e.message));
                }
                break;
            }
            if (parts[0] === 'delete') {
                const id = parts[1];
                if (!id) { out(c.red('usage: /agent delete <id>')); break; }
                if (deleteAgent(workspaceRoot, id)) {
                    if (engine.selectedAgentId === id) selectAgent('');
                    out(c.dim(`deleted agent: ${id}`));
                } else {
                    out(c.red(`agent not found: ${id}`));
                }
                break;
            }
            const id = parts[0];
            if (id === 'none' || id === 'off') {
                selectAgent('');
                break;
            }
            selectAgent(id);
            break;
        }
        case 'memorize':
            await engine.sendMessage('/memorize');
            break;
        case 'memorize_global':
            await engine.sendMessage('/memorize_global');
            break;
        case 'compress':
            await engine.compressHistory(true);
            break;
        case 'thinking':
            engine.toggleThinking();
            break;
        case 'clear':
            engine.clearChat();
            out(c.dim('chat cleared'));
            break;
        case 'stop':
            engine.stop();
            break;
        case 'config':
            out(c.dim('config: ' + getConfigPath()));
            out(c.dim('data:   ' + getDataDir()));
            out(c.dim('log:    ' + logFile));
            break;
        default:
            out(c.red(`unknown command: /${cmd} (try /help)`));
    }
    return false;
}

async function handleInput(raw: string) {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('/')) {
        await handleCommand(line);
        return;
    }
    streamLen = 0;
    thinkLen = 0;
    out();
    await engine.sendMessage(line);

    if (pendingChoices && pendingChoices.length > 0) {
        const choices = pendingChoices;
        pendingChoices = null;
        const answer = await askChoice(choices);
        if (answer !== null) {
            streamLen = 0;
            thinkLen = 0;
            await engine.sendMessage(`[User choice: ${answer}]`);
        }
    }
}

rl.on('SIGINT', () => {
    if (pendingAskResolve) {
        const r = pendingAskResolve;
        pendingAskResolve = null;
        r('');
        return;
    }
    if (busy) {
        out();
        engine.stop();
        return;
    }
    exiting = true;
    rl.close();
});

rl.on('close', () => {
    out();
    out('goodbye.');
    process.exit(0);
});

// ── Startup ───────────────────────────────────────────────────────────────────

function main() {
    out(c.bold(c.green('🐛 Maggot CLI')) + c.dim(' — local AI agent on the shared Maggot Agent Engine'));
    out(c.dim('workspace: ' + workspaceRoot));
    out(c.dim('config:    ' + getConfigPath()));
    const active = getActiveProvider();
    const model = getProviderConfig(active).model || '(auto)';
    const agent = getSelectedAgent();
    out(c.dim(`provider:  ${active} · model: ${model} · approval: ${getApprovalMode()}`));
    out(c.dim(`agent:     ${agent || 'none'} · dir: ${getAgentsDir(workspaceRoot)}`));
    out(c.dim('type /help for commands, or just ask something.'));
    out();

    engine.setSelectedAgent(getSelectedAgent());
    engine.newSession();
    prompt();
}

main();
