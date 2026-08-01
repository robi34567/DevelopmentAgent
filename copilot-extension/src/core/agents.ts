import * as fs from 'fs';
import * as path from 'path';

// Agent definition files, following the GitHub Copilot convention:
//   <workspace>/.github/agents/<agent-id>.md
// Each file is a Markdown file with an optional YAML-style frontmatter block
// (name, description) and the agent instructions as the body.

export interface AgentDef {
    id: string;
    name: string;
    description: string;
    content: string;
    filePath: string;
}

export interface AgentInput {
    name: string;
    description?: string;
    content?: string;
}

export function getAgentsDir(workspaceRoot: string): string {
    return path.join(workspaceRoot || '', '.github', 'agents');
}

export function sanitizeAgentId(name: string): string {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return id || 'agent';
}

export function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
    let name: string | undefined;
    let description: string | undefined;
    let body = raw;
    const m = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (m) {
        body = m[2];
        for (const line of m[1].split(/\r?\n/)) {
            const kv = line.match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
            if (kv) {
                const key = kv[1].toLowerCase();
                const val = kv[2].replace(/^["']|["']$/g, '');
                if (key === 'name') name = val;
                else if (key === 'description') description = val;
            }
        }
    }
    return { name, description, body: body.trim() };
}

export function listAgents(workspaceRoot: string): AgentDef[] {
    const dir = getAgentsDir(workspaceRoot);
    if (!workspaceRoot || !fs.existsSync(dir)) return [];
    const out: AgentDef[] = [];
    let files: string[] = [];
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch {
        return [];
    }
    for (const f of files) {
        const filePath = path.join(dir, f);
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const parsed = parseFrontmatter(raw);
            const id = f.slice(0, -3);
            out.push({
                id,
                name: parsed.name || id,
                description: parsed.description || '',
                content: parsed.body,
                filePath
            });
        } catch {
            // skip unreadable files
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
}

export function readAgent(workspaceRoot: string, id: string): AgentDef | null {
    if (!id || !workspaceRoot) return null;
    const filePath = path.join(getAgentsDir(workspaceRoot), id + '.md');
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseFrontmatter(raw);
        return { id, name: parsed.name || id, description: parsed.description || '', content: parsed.body, filePath };
    } catch {
        return null;
    }
}

export function buildAgentFile(input: AgentInput, id?: string): string {
    const name = input.name.trim() || (id ? id : 'New Agent');
    const description = (input.description || '').trim();
    const content = (input.content || '').trim();
    const body = content || `You are the agent "${name}". Write your instructions here.`;
    return `---\nname: ${name.replace(/\r?\n/g, ' ')}\ndescription: ${description.replace(/\r?\n/g, ' ')}\n---\n\n${body}\n`;
}

export function createAgent(workspaceRoot: string, input: AgentInput): AgentDef {
    if (!workspaceRoot) throw new Error('Open a workspace folder first to create an agent.');
    const id = sanitizeAgentId(input.name);
    const dir = getAgentsDir(workspaceRoot);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, id + '.md');
    const raw = buildAgentFile(input, id);
    fs.writeFileSync(filePath, raw, 'utf-8');
    return { id, name: input.name.trim() || id, description: (input.description || '').trim(), content: (input.content || '').trim(), filePath };
}

// Update an existing agent, keeping its id (filename).
export function updateAgent(workspaceRoot: string, id: string, input: AgentInput): AgentDef {
    if (!workspaceRoot) throw new Error('Open a workspace folder first to edit an agent.');
    const filePath = path.join(getAgentsDir(workspaceRoot), id + '.md');
    const raw = buildAgentFile(input, id);
    fs.writeFileSync(filePath, raw, 'utf-8');
    return { id, name: input.name.trim() || id, description: (input.description || '').trim(), content: (input.content || '').trim(), filePath };
}

export function deleteAgent(workspaceRoot: string, id: string): boolean {
    if (!id || !workspaceRoot) return false;
    const filePath = path.join(getAgentsDir(workspaceRoot), id + '.md');
    if (!fs.existsSync(filePath)) return false;
    try {
        fs.unlinkSync(filePath);
        return true;
    } catch {
        return false;
    }
}

// The text injected into the system prompt when an agent is active.
export function buildAgentPrompt(agent: AgentDef): string {
    const parts: string[] = [];
    parts.push(`You are now operating as the agent "${agent.name}".`);
    if (agent.description) parts.push(agent.description);
    if (agent.content) parts.push(agent.content);
    return parts.join('\n\n');
}
