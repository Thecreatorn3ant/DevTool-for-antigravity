import * as vscode from 'vscode';
import * as path from 'path';
import { ContextFile, estimateTokens } from './ollamaClient';

export class FileContextManager {

    constructor(private readonly _context: vscode.ExtensionContext) { }

    async getActiveFile(maxChars: number): Promise<ContextFile | null> {
        let editor = vscode.window.activeTextEditor;
        if (!editor && vscode.window.visibleTextEditors.length > 0) {
            editor = vscode.window.visibleTextEditors[0];
        }
        if (!editor || editor.document.uri.scheme !== 'file') return null;

        const doc = editor.document;
        const fullText = doc.getText();
        const truncated = fullText.length > maxChars
            ? fullText.substring(0, maxChars) + '\n[... fichier tronqué ...]'
            : fullText;

        return {
            name: vscode.workspace.asRelativePath(doc.fileName),
            content: truncated,
            isActive: true
        };
    }

    async getRelatedFiles(doc: vscode.TextDocument, maxChars: number): Promise<ContextFile[]> {
        const text = doc.getText();
        const dir = path.dirname(doc.fileName);
        const related: ContextFile[] = [];

        const importRegex = /(?:import|require)\s*(?:\{[^}]*\}|[\w*]+|['"])?\s*(?:from\s*)?['"](\.[^'"]+)['"]/g;
        const found = new Set<string>();
        let match;

        while ((match = importRegex.exec(text)) !== null) {
            const importPath = match[1];
            if (!importPath.startsWith('.')) continue;

            const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
            for (const ext of extensions) {
                const full = path.resolve(dir, importPath + ext);
                const relPath = vscode.workspace.asRelativePath(full);

                if (found.has(relPath)) continue;

                try {
                    const uri = vscode.Uri.file(full);
                    const contentBytes = await vscode.workspace.fs.readFile(uri);
                    const content = contentBytes.toString();
                    if (content) {
                        found.add(relPath);
                        const truncated = content.length > maxChars
                            ? content.substring(0, maxChars) + '\n[... tronqué ...]'
                            : content;
                        related.push({ name: relPath, content: truncated, isActive: false });
                        break;
                    }
                } catch { /* file not found, try next extension */ }
            }
            if (found.size >= 5) break;
        }

        return related;
    }
    async readFile(filePath: string): Promise<{ name: string; content: string } | null> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return null;

        for (const folder of workspaceFolders) {
            try {
                const uri = vscode.Uri.joinPath(folder.uri, filePath);
                const bytes = await vscode.workspace.fs.readFile(uri);
                return {
                    name: vscode.workspace.asRelativePath(uri),
                    content: bytes.toString()
                };
            } catch { }
        }

        try {
            const files = await vscode.workspace.findFiles(`**/${filePath}`, '**/node_modules/**', 1);
            if (files[0]) {
                const bytes = await vscode.workspace.fs.readFile(files[0]);
                return {
                    name: vscode.workspace.asRelativePath(files[0]),
                    content: bytes.toString()
                };
            }
        } catch { }

        return null;
    }

    isInWorkspace(filePath: string): boolean {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return false;
        if (!path.isAbsolute(filePath)) return true;
        return folders.some(f => filePath.startsWith(f.uri.fsPath));
    }

    async handleAiFileRequest(
        filePath: string,
        filePermission: 'ask-all' | 'ask-workspace' | 'allow-all' = 'allow-all'
    ): Promise<{ name: string; content: string } | null> {
        const inWorkspace = this.isInWorkspace(filePath);
        const fp = filePath.toLowerCase();

        const isSensitive = fp.includes('.env')
            || fp.includes('secret')
            || fp.includes('password')
            || fp.includes('credential')
            || fp.includes('private_key')
            || fp.includes('id_rsa')
            || fp.endsWith('.pem')
            || fp.endsWith('.pfx')
            || fp.endsWith('.p12');

        const isSystemFile = /^(\/etc\/|\/sys\/|\/proc\/|\/dev\/|c:\\windows\\)/i.test(filePath);

        const isAppData = !inWorkspace && (
            fp.includes('appdata') ||
            fp.includes('program files') ||
            fp.includes('steamapps') ||
            fp.includes('roaming')
        );

        if (isSensitive) {
            const msg = `⚠️ Fichier sensible détecté : "${filePath}"\nCe fichier peut contenir des secrets. Autoriser l'accès à l'IA ?`;
            const r = await vscode.window.showInformationMessage(msg, { modal: true }, '✅ Autoriser', '❌ Refuser');
            if (r !== '✅ Autoriser') return null;
        } else if (isSystemFile || isAppData) {
            const label = isSystemFile ? 'fichier système' : 'fichier app/jeu';
            const msg = `⚠️ Accès à un ${label} hors workspace : "${filePath}". Autoriser ?`;
            const r = await vscode.window.showInformationMessage(msg, { modal: true }, '✅ Autoriser', '❌ Refuser');
            if (r !== '✅ Autoriser') return null;
        } else if (!inWorkspace && filePermission === 'ask-workspace') {
            const r = await vscode.window.showInformationMessage(
                `Fichier hors workspace : "${filePath}". Autoriser l'accès ?`,
                { modal: false },
                '✅ Autoriser', '❌ Refuser'
            );
            if (r !== '✅ Autoriser') return null;
        } else if (filePermission === 'ask-all' && !inWorkspace) {
            const r = await vscode.window.showInformationMessage(
                `Accès fichier : "${filePath}". Autoriser ?`,
                { modal: false },
                '✅ Autoriser', '❌ Refuser'
            );
            if (r !== '✅ Autoriser') return null;
        }

        const file = await this.readFile(filePath);
        if (!file) {
            const uris = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                openLabel: `Sélectionner "${filePath}"`,
                title: 'Fichier introuvable — sélection manuelle'
            });
            if (uris?.[0]) {
                const bytes = await vscode.workspace.fs.readFile(uris[0]);
                return { name: vscode.workspace.asRelativePath(uris[0]), content: bytes.toString() };
            }
        }
        return file;
    }

    async findFilesForError(errorText: string): Promise<ContextFile[]> {
        const found: ContextFile[] = [];

        const stackRegex = /(?:at\s+\S+\s+\()?([^\s()"']+\.[jt]sx?):(\d+)/g;
        const paths = new Set<string>();
        let m;
        while ((m = stackRegex.exec(errorText)) !== null) {
            paths.add(m[1]);
        }

        for (const p of paths) {
            const file = await this.readFile(p);
            if (file) found.push({ ...file, isActive: false });
            if (found.length >= 3) break;
        }

        if (found.length === 0) {
            const mentionRegex = /\b([\w/-]+\.(?:ts|tsx|js|jsx|py|go|rs|vue|svelte))\b/g;
            while ((m = mentionRegex.exec(errorText)) !== null) {
                paths.add(m[1]);
            }
            for (const p of paths) {
                const file = await this.readFile(p);
                if (file) found.push({ ...file, isActive: false });
                if (found.length >= 3) break;
            }
        }

        if (found.length === 0) {
            const keywords = this._extractKeywords(errorText);
            if (keywords.length > 0) {
                const files = await vscode.workspace.findFiles(
                    '**/*.{ts,tsx,js,jsx,py,go,rs}',
                    '{**/node_modules/**,**/.git/**,**/dist/**}',
                    200
                );

                for (const uri of files) {
                    try {
                        const bytes = await vscode.workspace.fs.readFile(uri);
                        const content = bytes.toString();
                        const score = keywords.filter(kw => content.includes(kw)).length;
                        if (score >= 2) {
                            found.push({
                                name: vscode.workspace.asRelativePath(uri),
                                content: content.substring(0, 8000),
                                isActive: false
                            });
                            if (found.length >= 3) break;
                        }
                    } catch { }
                }
            }
        }

        return found;
    }

    private _extractKeywords(errorText: string): string[] {
        const noiseWords = new Set([
            'error', 'cannot', 'cannot', 'undefined', 'null', 'is', 'not',
            'the', 'a', 'an', 'of', 'in', 'at', 'to', 'for', 'and', 'or',
            'type', 'object', 'function', 'class', 'module', 'property',
            'TypeError', 'ReferenceError', 'SyntaxError', 'Error'
        ]);

        const words = errorText
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !noiseWords.has(w) && isNaN(Number(w)));

        const codeWords = words.filter(w => /[a-z][A-Z]/.test(w) || /^[A-Z]/.test(w));
        const others = words.filter(w => !/[a-z][A-Z]/.test(w) && !/^[A-Z]/.test(w));

        return [...new Set([...codeWords, ...others])].slice(0, 8);
    }

    async getWorkspaceTree(): Promise<string[]> {
        const files = await vscode.workspace.findFiles(
            '**/*',
            '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**,**/.next/**}',
            300
        );
        return files.map(u => vscode.workspace.asRelativePath(u)).sort();
    }

    async getGitDiff(staged: boolean = false): Promise<string> {
        try {
            const gitExt = vscode.extensions.getExtension('vscode.git')?.exports;
            const api = gitExt?.getAPI(1);
            const repo = api?.repositories?.[0];
            if (!repo) return '';
            return staged
                ? await repo.diff(true)
                : await repo.diff(false);
        } catch { return ''; }
    }

    async getStagedDiffForCommit(): Promise<string> {
        return this.getGitDiff(true);
    }

    getProjectSummary(): string {
        return this._context.workspaceState.get<string>('projectSummary', '');
    }

    async saveProjectSummary(summary: string): Promise<void> {
        await this._context.workspaceState.update('projectSummary', summary);
    }

    getFileHistory(fileName: string): Array<{ role: string; value: string }> {
        return this._context.workspaceState.get<Array<{ role: string; value: string }>>(
            `history:${fileName}`, []
        );
    }

    async saveFileHistory(fileName: string, history: Array<{ role: string; value: string }>): Promise<void> {
        await this._context.workspaceState.update(`history:${fileName}`, history.slice(-20));
    }
}