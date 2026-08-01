import * as fs from 'fs';
import * as path from 'path';
import { ChatMessage } from './types';
import { getDataDir } from './config';

export interface Session {
    id: string;
    name: string;
    timestamp: string;
    chatHistory: ChatMessage[];
    chatHtml: string;
    model: string;
    provider: string;
    approvalMode: string;
    compressedHistories: string[];
    memories: string[];
}

export class SessionStore {
    private sessionsDir: string = '';

    constructor() {
        this.sessionsDir = path.join(getDataDir(), 'sessions');
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
    }

    getSessionsDir(): string {
        return this.sessionsDir;
    }

    generateSessionId(): string {
        return Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
    }

    generateSessionName(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        const h = pad(now.getHours()), m = pad(now.getMinutes()), s = pad(now.getSeconds());
        const base = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${h}:${m}:${s}`;
        const existing = this.list().filter(s => s.name.startsWith(base));
        return existing.length === 0 ? base : `${base} (${existing.length + 1})`;
    }

    save(session: Session): void {
        try {
            const filePath = path.join(this.sessionsDir, `${session.id}.json`);
            fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
        } catch (e: any) {
            console.error('[Local Copilot] Failed to save session:', e);
        }
    }

    load(id: string): Session | null {
        try {
            const filePath = path.join(this.sessionsDir, `${id}.json`);
            if (!fs.existsSync(filePath)) return null;
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data) as Session;
        } catch (e: any) {
            console.error('[Local Copilot] Failed to load session:', e);
            return null;
        }
    }

    delete(id: string): boolean {
        try {
            const filePath = path.join(this.sessionsDir, `${id}.json`);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                return true;
            }
            return false;
        } catch (e: any) {
            console.error('[Local Copilot] Failed to delete session:', e);
            return false;
        }
    }

    list(): Session[] {
        try {
            if (!fs.existsSync(this.sessionsDir)) return [];
            const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
            const sessions: Session[] = [];
            for (const file of files) {
                try {
                    const data = fs.readFileSync(path.join(this.sessionsDir, file), 'utf-8');
                    const session = JSON.parse(data) as Session;
                    if (session.id && session.chatHistory) {
                        sessions.push(session);
                    }
                } catch {
                    // skip corrupt files
                }
            }
            sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            return sessions;
        } catch {
            return [];
        }
    }
}
