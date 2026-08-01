import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

// ── Command classification ─────────────────────────────────────────────────────

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

export function isSafeCommand(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    for (const safe of SAFE_COMMANDS) {
        if (trimmed === safe || trimmed.startsWith(safe + ' ') || trimmed.startsWith(safe + '\t')) {
            return true;
        }
    }
    return false;
}

export function isDangerousCommand(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    for (const pattern of DANGEROUS_PATTERNS) {
        if (pattern.test(trimmed)) return true;
    }
    return false;
}

// ── Block extraction ───────────────────────────────────────────────────────────

export function extractAskBlocks(text: string): string[] {
    const regex = /\[ASK\]([\s\S]*?)\[\/ASK\]/g;
    const questions: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const q = match[1].trim();
        if (q) questions.push(q);
    }
    return questions;
}

export function extractChoicesBlock(text: string): string[] | null {
    const regex = /\[CHOICES\]([\s\S]*?)(?:\[\/CHOICES\]|$)/g;
    const match = regex.exec(text);
    if (!match) return null;
    const raw = match[1].trim();
    if (raw.includes('|')) {
        return raw.split('|').map(s => s.trim()).filter(s => s.length > 0);
    }
    return raw.split('\n').map(s => s.trim()).filter(s => s.length > 0);
}

export function extractCmdBlocks(text: string): string[] {
    const regex = /\[CMD\]([\s\S]*?)\[\/CMD\]/g;
    const commands: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const cmd = match[1].trim();
        if (cmd) commands.push(cmd);
    }
    return commands;
}

export function extractReadBlocks(text: string): string[] {
    const regex = /\[READ\]([\s\S]*?)\[\/READ\]/g;
    const paths: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const p = match[1].trim();
        if (p) paths.push(p);
    }
    return paths;
}

export function extractWriteBlocks(text: string): { path: string; content: string }[] {
    const regex = /\[WRITE\]([\s\S]*?)\[\/WRITE\]/g;
    const writes: { path: string; content: string }[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const raw = match[1];
        const firstNewline = raw.indexOf('\n');
        if (firstNewline === -1) {
            writes.push({ path: raw.trim(), content: '' });
        } else {
            writes.push({ path: raw.substring(0, firstNewline).trim(), content: raw.substring(firstNewline + 1) });
        }
    }
    return writes;
}

export function extractSearchBlocks(text: string): string[] {
    const regex = /\[SEARCH\]([\s\S]*?)\[\/SEARCH\]/g;
    const patterns: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const p = match[1].trim();
        if (p) patterns.push(p);
    }
    return patterns;
}

export function extractFilesBlocks(text: string): string[] {
    const regex = /\[FILES\]([\s\S]*?)\[\/FILES\]/g;
    const globs: string[] = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
        const g = match[1].trim();
        if (g) globs.push(g);
    }
    return globs;
}

export function isImageUnsupportedText(content: string): boolean {
    const lower = content.toLowerCase();
    if (!lower.includes('image')) return false;
    if (lower.includes('does not support') || lower.includes('not support') || lower.includes('no support')) return true;
    if (lower.includes('unsupported')) return true;
    if (lower.includes('cannot read') || lower.includes("can't read") || lower.includes('can not read')) return true;
    return false;
}

// ── File tools (workspaceRoot passed in) ───────────────────────────────────────

const MAX_READ_CHARS = 128000;
const MAX_SEARCH_RESULTS = 200;
const MAX_GLOB_RESULTS = 500;
const BINARY_EXTS = ['.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.png', '.jpg', '.gif', '.ico', '.pdf', '.zip', '.gz', '.tar'];

export function resolvePath(filePath: string, workspaceRoot: string): string {
    return path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot || '', filePath);
}

export function readFileTool(filePath: string, workspaceRoot: string): Promise<string> {
    const resolved = resolvePath(filePath, workspaceRoot);
    if (!fs.existsSync(resolved)) {
        return Promise.resolve(`[ERROR]File not found: ${filePath} (resolved: ${resolved})[/ERROR]`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
        const entries = fs.readdirSync(resolved);
        return Promise.resolve(`[OUTPUT]Contents of ${filePath}:\n${entries.join('\n')}[/OUTPUT]`);
    }
    const ext = path.extname(resolved).toLowerCase();
    if (BINARY_EXTS.includes(ext)) {
        return Promise.resolve(`[ERROR]Cannot read binary file: ${filePath}[/ERROR]`);
    }
    try {
        const content = fs.readFileSync(resolved, 'utf-8');
        const truncated = content.length > MAX_READ_CHARS;
        const display = truncated ? content.substring(0, MAX_READ_CHARS) : content;
        return Promise.resolve(`[OUTPUT]${filePath}${truncated ? ' [truncated at ' + MAX_READ_CHARS + ' chars]' : ''}\n${display}[/OUTPUT]`);
    } catch (e: any) {
        return Promise.resolve(`[ERROR]Failed to read ${filePath}: ${e.message}[/ERROR]`);
    }
}

export function writeFileTool(filePath: string, content: string, workspaceRoot: string): Promise<string> {
    const resolved = resolvePath(filePath, workspaceRoot);
    try {
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, content, 'utf-8');
        return Promise.resolve(`[OUTPUT]File written: ${filePath} (${content.length} chars)[/OUTPUT]`);
    } catch (e: any) {
        return Promise.resolve(`[ERROR]Failed to write ${filePath}: ${e.message}[/ERROR]`);
    }
}

export function searchFilesTool(pattern: string, workspaceRoot: string): Promise<string> {
    if (!workspaceRoot) return Promise.resolve(`[ERROR]No workspace folder open[/ERROR]`);
    const results: string[] = [];
    try {
        const files = walkDir(workspaceRoot);
        const re = new RegExp(pattern, 'i');
        for (const file of files) {
            if (results.length >= MAX_SEARCH_RESULTS) break;
            const relPath = path.relative(workspaceRoot, file);
            try {
                const lines = fs.readFileSync(file, 'utf-8').split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (results.length >= MAX_SEARCH_RESULTS) break;
                    if (re.test(lines[i])) {
                        results.push(`${relPath}:${i + 1}: ${lines[i].trim().substring(0, 200)}`);
                    }
                }
            } catch {}
        }
    } catch (e: any) {
        return Promise.resolve(`[ERROR]Search failed: ${e.message}[/ERROR]`);
    }
    if (results.length === 0) return Promise.resolve(`[OUTPUT]No matches found for: ${pattern}[/OUTPUT]`);
    return Promise.resolve(`[OUTPUT]Search results for "${pattern}" (${results.length} matches${results.length >= MAX_SEARCH_RESULTS ? ', truncated' : ''}):\n${results.join('\n')}[/OUTPUT]`);
}

export function globFilesTool(globPattern: string, workspaceRoot: string): Promise<string> {
    if (!workspaceRoot) return Promise.resolve(`[ERROR]No workspace folder open[/ERROR]`);
    try {
        const files = walkDir(workspaceRoot, globPattern);
        const relPaths = files.map(f => path.relative(workspaceRoot, f)).filter(f => !f.startsWith('node_modules') && !f.startsWith('.git'));
        if (relPaths.length === 0) return Promise.resolve(`[OUTPUT]No files matching: ${globPattern}[/OUTPUT]`);
        const display = relPaths.slice(0, MAX_GLOB_RESULTS);
        const truncated = relPaths.length > MAX_GLOB_RESULTS;
        return Promise.resolve(`[OUTPUT]Files matching "${globPattern}" (${relPaths.length} total${truncated ? ', showing first ' + MAX_GLOB_RESULTS : ''}):\n${display.join('\n')}[/OUTPUT]`);
    } catch (e: any) {
        return Promise.resolve(`[ERROR]Glob failed: ${e.message}[/ERROR]`);
    }
}

function walkDir(dir: string, pattern?: string): string[] {
    const results: string[] = [];
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            if (entry.isDirectory()) {
                results.push(...walkDir(fullPath, pattern));
            } else if (entry.isFile()) {
                if (!pattern || matchGlob(entry.name, pattern) || fullPath.includes(pattern.replace(/\*/g, ''))) {
                    results.push(fullPath);
                }
            }
        }
    } catch {}
    return results;
}

function matchGlob(filename: string, pattern: string): boolean {
    const reStr = '^' + pattern.replace(/\./g, '\\.').replace(/\*\*/g, '___DOUBLESTAR___').replace(/\*/g, '[^/\\\\]*').replace(/___DOUBLESTAR___/g, '.*') + '$';
    try {
        return new RegExp(reStr, 'i').test(filename);
    } catch {
        return false;
    }
}

// ── Command execution ──────────────────────────────────────────────────────────

export function executeCommand(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
        const cwd = opts?.cwd || process.env.USERPROFILE || process.cwd();
        const timeoutMs = opts?.timeoutMs || 30000;
        console.log('[Maggot] Executing command:', command, 'in', cwd);
        exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            const exitCode = error ? Number(error.code) || 1 : 0;
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode });
        });
    });
}
