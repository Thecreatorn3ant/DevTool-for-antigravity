import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';
import { FileContextManager } from './fileContextManager';

export interface ParsedDiff {
    files: ModifiedFile[];
    rawDiff: string;
    totalAdditions: number;
    totalDeletions: number;
}

export interface ModifiedFile {
    path: string;
    language: string;
    additions: number;
    deletions: number;
    isNew: boolean;
    isDeleted: boolean;
    isRenamed: boolean;
    patch: string;
}

export interface CommitSuggestion {
    message: string;
    type: ConventionalCommitType;
    scope: string | null;
    description: string;
    body: string | null;
    breaking: boolean;
}

export type ConventionalCommitType =
    | 'feat'
    | 'fix'
    | 'refactor'
    | 'chore'
    | 'docs'
    | 'test'
    | 'perf'
    | 'ci'
    | 'style'
    | 'revert'
    | 'build';

const COMMIT_TYPE_ICONS: Record<ConventionalCommitType, string> = {
    feat: '✨',
    fix: '🐛',
    refactor: '♻️',
    chore: '🔧',
    docs: '📝',
    test: '🧪',
    perf: '⚡',
    ci: '🔄',
    style: '💄',
    revert: '⏪',
    build: '📦',
};

const COMMIT_TYPE_DESCRIPTIONS: Record<ConventionalCommitType, string> = {
    feat: 'New feature',
    fix: 'Bug fix',
    refactor: 'Code refactoring',
    chore: 'Build / tooling / deps',
    docs: 'Documentation only',
    test: 'Adding or fixing tests',
    perf: 'Performance improvement',
    ci: 'CI/CD changes',
    style: 'Formatting, no logic change',
    revert: 'Revert a previous commit',
    build: 'Build system changes',
};

function getLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
        ts: 'TypeScript', tsx: 'TypeScript/React', js: 'JavaScript',
        jsx: 'JavaScript/React', py: 'Python', go: 'Go', rs: 'Rust',
        java: 'Java', cs: 'C#', cpp: 'C++', c: 'C', rb: 'Ruby',
        php: 'PHP', swift: 'Swift', kt: 'Kotlin', vue: 'Vue',
        svelte: 'Svelte', css: 'CSS', scss: 'SCSS', html: 'HTML',
        json: 'JSON', yaml: 'YAML', yml: 'YAML', md: 'Markdown',
        toml: 'TOML', sh: 'Shell', bash: 'Shell', dockerfile: 'Docker',
    };
    return map[ext] ?? ext.toUpperCase();
}

export function parseDiff(rawDiff: string): ParsedDiff {
    const files: ModifiedFile[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

    for (const section of fileSections) {
        const lines = section.split('\n');

        const headerMatch = lines[0]?.match(/^a\/(.+?) b\/(.+)$/);
        if (!headerMatch) continue;

        const filePath = headerMatch[2];
        const isNew = section.includes('\nnew file mode');
        const isDeleted = section.includes('\ndeleted file mode');
        const isRenamed = section.includes('\nrename from ');

        let additions = 0;
        let deletions = 0;
        const patchLines: string[] = [];
        let inHunk = false;

        for (const line of lines) {
            if (line.startsWith('@@')) { inHunk = true; patchLines.push(line); continue; }
            if (!inHunk) continue;
            if (line.startsWith('+') && !line.startsWith('+++')) { additions++; patchLines.push(line); }
            else if (line.startsWith('-') && !line.startsWith('---')) { deletions++; patchLines.push(line); }
            else { patchLines.push(line); }
        }

        totalAdditions += additions;
        totalDeletions += deletions;

        const patch = patchLines.slice(0, 120).join('\n');

        files.push({
            path: filePath,
            language: getLanguage(filePath),
            additions,
            deletions,
            isNew,
            isDeleted,
            isRenamed,
            patch,
        });
    }

    return { files, rawDiff, totalAdditions, totalDeletions };
}

function guessCommitType(diff: ParsedDiff): ConventionalCommitType {
    const paths = diff.files.map(f => f.path.toLowerCase());

    const allDocs = paths.every(p => p.endsWith('.md') || p.endsWith('.rst') || p.endsWith('.txt') || p.includes('/docs/'));
    if (allDocs) return 'docs';

    const allTests = paths.every(p =>
        p.includes('.test.') || p.includes('.spec.') || p.includes('/__tests__/') || p.includes('/test/')
    );
    if (allTests) return 'test';

    const allConfig = paths.every(p =>
        p.endsWith('.json') || p.endsWith('.yaml') || p.endsWith('.yml') ||
        p.endsWith('.toml') || p.includes('.github/') || p.includes('.eslint') ||
        p.includes('tsconfig') || p.includes('package.json') || p.includes('.prettierrc')
    );
    if (allConfig) return 'chore';

    const allCss = paths.every(p => p.endsWith('.css') || p.endsWith('.scss') || p.endsWith('.less'));
    if (allCss) return 'style';

    const hasCi = paths.some(p => p.includes('.github/workflows') || p.includes('.gitlab-ci') || p.includes('Jenkinsfile'));
    if (hasCi) return 'ci';

    return 'feat';
}

function guessScope(diff: ParsedDiff): string | null {
    if (diff.files.length === 0) return null;

    const dirs = diff.files.map(f => {
        const parts = f.path.split('/');
        return parts.length > 1 ? parts[parts.length - 2] : null;
    }).filter(Boolean) as string[];

    if (dirs.length > 0) {
        const unique = [...new Set(dirs)];
        if (unique.length === 1) return unique[0];
    }

    if (diff.files.length === 1) {
        const name = diff.files[0].path.split('/').pop()?.replace(/\.(ts|js|tsx|jsx|py)$/, '') ?? null;
        return name && name.length <= 20 ? name : null;
    }

    return null;
}

function buildCommitPrompt(
    diff: ParsedDiff,
    recentCommits: string,
    branchName: string,
    hintType: ConventionalCommitType,
    hintScope: string | null
): string {
    const filesSummary = diff.files.map(f => {
        const flags = [
            f.isNew ? 'NEW' : '',
            f.isDeleted ? 'DELETED' : '',
            f.isRenamed ? 'RENAMED' : '',
        ].filter(Boolean).join(', ');

        return `  - ${f.path} (${f.language}) +${f.additions}/-${f.deletions}${flags ? ` [${flags}]` : ''}`;
    }).join('\n');

    const topFiles = [...diff.files]
        .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
        .slice(0, 3);

    const patchContext = topFiles.map(f =>
        `### ${f.path}\n\`\`\`diff\n${f.patch.substring(0, 600)}\n\`\`\``
    ).join('\n\n');

    return `You are an expert developer writing a Git commit message following the Conventional Commits specification.

## Context
- Branch: ${branchName || 'unknown'}
- Files changed: ${diff.files.length}
- Total: +${diff.totalAdditions} / -${diff.totalDeletions} lines
- Heuristic type hint: ${hintType}${hintScope ? ` (scope hint: ${hintScope})` : ''}

## Files modified
${filesSummary}

## Code diff (most changed files)
${patchContext}

## Recent commits (for style reference)
${recentCommits || 'No recent commits available.'}

## Rules
1. Output ONLY valid JSON — no markdown fences, no extra text.
2. Follow Conventional Commits: type(scope): description
3. Use ONLY these types: feat | fix | refactor | chore | docs | test | perf | ci | style | revert | build
4. Description: imperative mood, lowercase, max 72 chars, no trailing period
5. Scope: optional, short (camelCase or kebab-case), inferred from files
6. Body: optional, only if the change needs explanation (max 3 lines)
7. breaking: true only if the change breaks a public API

## Required JSON format
{
  "type": "feat",
  "scope": "auth",
  "description": "add OAuth2 login flow",
  "body": null,
  "breaking": false
}`;
}

function parseCommitResponse(raw: string): CommitSuggestion | null {
    try {
        const clean = raw.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '').trim();

        const jsonMatch = clean.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[0]);

        const type = (parsed.type || 'chore') as ConventionalCommitType;
        const scope = parsed.scope || null;
        const description = (parsed.description || '').toLowerCase().replace(/\.$/, '').trim();
        const body = parsed.body || null;
        const breaking = !!parsed.breaking;

        if (!description) return null;

        const header = scope
            ? `${type}(${scope}): ${description}`
            : `${type}: ${description}`;

        const breakingFooter = breaking ? '\n\nBREAKING CHANGE: ' + description : '';
        const message = body
            ? `${header}\n\n${body}${breakingFooter}`
            : `${header}${breakingFooter}`;

        return { message, type, scope, description, body, breaking };
    } catch {
        return null;
    }
}

async function getRecentCommits(n: number = 5): Promise<string> {
    try {
        const gitExt = vscode.extensions.getExtension('vscode.git')?.exports;
        const api = gitExt?.getAPI(1);
        const repo = api?.repositories?.[0];
        if (!repo) return '';

        const log = await repo.log({ maxEntries: n });
        if (!log?.length) return '';

        return log.map((c: any) => `  ${c.hash?.substring(0, 7) || '???????'} ${c.message?.split('\n')[0] || ''}`).join('\n');
    } catch { return ''; }
}

async function getBranchName(): Promise<string> {
    try {
        const gitExt = vscode.extensions.getExtension('vscode.git')?.exports;
        const api = gitExt?.getAPI(1);
        const repo = api?.repositories?.[0];
        return repo?.state?.HEAD?.name || '';
    } catch { return ''; }
}

async function execGitCommit(message: string): Promise<{ success: boolean; error?: string }> {
    try {
        const gitExt = vscode.extensions.getExtension('vscode.git')?.exports;
        const api = gitExt?.getAPI(1);
        const repo = api?.repositories?.[0];
        if (!repo) return { success: false, error: 'Git repository not found.' };

        await repo.commit(message);
        return { success: true };
    } catch (e: any) {
        return { success: false, error: e.message || String(e) };
    }
}

async function copyToClipboard(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
}

export class CommitManager {

    constructor(
        private readonly _ollamaClient: OllamaClient,
        private readonly _fileCtxManager: FileContextManager,
    ) { }

    async generateAndShowCommitUI(): Promise<void> {
        const rawDiff = await this._fileCtxManager.getStagedDiffForCommit();

        if (!rawDiff || rawDiff.trim().length === 0) {
            const choice = await vscode.window.showWarningMessage(
                '⚠️ No staged files found.',
                'Run git add -A and retry',
                'Cancel'
            );
            if (choice === 'Run git add -A and retry') {
                const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Antigravity');
                terminal.show();
                terminal.sendText('git add -A');
                await new Promise(r => setTimeout(r, 1500));
                return this.generateAndShowCommitUI();
            }
            return;
        }

        const parsedDiff = parseDiff(rawDiff);

        if (parsedDiff.files.length === 0) {
            vscode.window.showWarningMessage('⚠️ Could not parse the staged diff.');
            return;
        }

        const [recentCommits, branchName] = await Promise.all([
            getRecentCommits(5),
            getBranchName(),
        ]);
        const hintType = guessCommitType(parsedDiff);
        const hintScope = guessScope(parsedDiff);

        let suggestion: CommitSuggestion | null = null;

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: '✨ Antigravity — Generating commit message...',
                cancellable: false,
            },
            async () => {
                const prompt = buildCommitPrompt(parsedDiff, recentCommits, branchName, hintType, hintScope);

                const raw = await this._rawGenerateWithCommitPrompt(prompt);
                suggestion = parseCommitResponse(raw);

                if (!suggestion) {
                    const scope = hintScope ? `(${hintScope})` : '';
                    suggestion = {
                        type: hintType,
                        scope: hintScope,
                        description: `update ${parsedDiff.files.map(f => f.path.split('/').pop()).slice(0, 2).join(', ')}`,
                        body: null,
                        breaking: false,
                        message: `${hintType}${scope}: update ${parsedDiff.files.map(f => f.path.split('/').pop()).slice(0, 2).join(', ')}`,
                    };
                }
            }
        );

        if (!suggestion) return;

        await this._showCommitPanel(suggestion, parsedDiff, recentCommits, branchName, hintType, hintScope);
    }

    private async _rawGenerateWithCommitPrompt(prompt: string): Promise<string> {
        const slot = await this._ollamaClient.router.selectProvider('commit');

        const { localStream } = await import('./localProvider');
        const { cloudStream, isCloudUrl } = await import('./cloudProvider');
        const { isLocalUrl } = await import('./localProvider');

        const systemPrompt = [
            'You are a Git commit message generator.',
            'You MUST respond ONLY with a valid JSON object.',
            'No markdown, no explanation, no extra text.',
            'Follow Conventional Commits specification strictly.',
        ].join(' ');

        const t0 = Date.now();
        let result = '';

        if (isLocalUrl(slot.url)) {
            result = await localStream(
                { model: this._getModel(), prompt, systemPrompt, baseUrl: slot.url, apiKey: slot.apiKey || undefined },
                () => { }
            );
        } else {
            result = await cloudStream(
                { model: this._getModel(), prompt, systemPrompt, baseUrl: slot.url, apiKey: slot.apiKey },
                () => { }
            );
        }

        this._ollamaClient.router.reportSuccess(slot.url, Date.now() - t0, 0, slot.apiKey);
        return result;
    }

    private _getModel(): string {
        const config = vscode.workspace.getConfiguration('local-ai');
        return config.get<string>('defaultModel') || 'llama3';
    }

    private async _showCommitPanel(
        suggestion: CommitSuggestion,
        diff: ParsedDiff,
        recentCommits: string,
        branchName: string,
        hintType: ConventionalCommitType,
        hintScope: string | null
    ): Promise<void> {
        const icon = COMMIT_TYPE_ICONS[suggestion.type] ?? '📝';
        const filesSummary = diff.files.slice(0, 5).map(f =>
            `$(file) ${f.path}  +${f.additions}/-${f.deletions}`
        ).join('\n');

        while (true) {
            const items: vscode.QuickPickItem[] = [
                {
                    label: `${icon} ${suggestion.message.split('\n')[0]}`,
                    description: `Branch: ${branchName || 'unknown'}`,
                    detail: suggestion.body ? `↳ ${suggestion.body}` : undefined,
                    kind: vscode.QuickPickItemKind.Default,
                    alwaysShow: true,
                },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                {
                    label: '$(check) Commit now',
                    description: 'Execute git commit with this message',
                    alwaysShow: true,
                },
                {
                    label: '$(edit) Edit message',
                    description: 'Modify before committing',
                    alwaysShow: true,
                },
                {
                    label: '$(clippy) Copy to clipboard',
                    description: 'Copy message without committing',
                    alwaysShow: true,
                },
                {
                    label: '$(refresh) Regenerate',
                    description: 'Ask the AI for a different message',
                    alwaysShow: true,
                },
                { label: '', kind: vscode.QuickPickItemKind.Separator },
                {
                    label: `$(diff) ${diff.files.length} file(s) staged  (+${diff.totalAdditions} / -${diff.totalDeletions})`,
                    detail: diff.files.slice(0, 4).map(f => `  ${f.path}`).join('\n'),
                    kind: vscode.QuickPickItemKind.Default,
                    alwaysShow: true,
                },
            ];

            const pick = await vscode.window.showQuickPick(items, {
                title: `✨ Antigravity — Commit Message  •  ${COMMIT_TYPE_DESCRIPTIONS[suggestion.type]}`,
                placeHolder: 'Choose an action…',
                ignoreFocusOut: true,
                matchOnDescription: false,
                matchOnDetail: false,
            });

            if (!pick) return;

            const action = pick.label;

            if (action.includes('Commit now')) {
                const { success, error } = await execGitCommit(suggestion.message);
                if (success) {
                    vscode.window.showInformationMessage(`✅ Committed: ${suggestion.message.split('\n')[0]}`);
                } else {
                    vscode.window.showErrorMessage(`❌ Commit failed: ${error}`);
                }
                return;
            }

            if (action.includes('Edit message')) {
                const edited = await vscode.window.showInputBox({
                    title: 'Edit commit message',
                    value: suggestion.message,
                    prompt: 'Conventional Commits format: type(scope): description',
                    ignoreFocusOut: true,
                    validateInput: (v) => {
                        if (!v.trim()) return 'Commit message cannot be empty.';
                        if (v.length > 200) return 'Message too long (max 200 chars).';
                        return null;
                    },
                });

                if (!edited) continue;

                const next = await vscode.window.showQuickPick(
                    [
                        { label: '$(check) Commit with edited message' },
                        { label: '$(clippy) Copy edited message' },
                        { label: '$(close) Cancel' },
                    ],
                    { title: 'What to do with the edited message?', ignoreFocusOut: true }
                );

                if (!next || next.label.includes('Cancel')) continue;

                if (next.label.includes('Commit')) {
                    const { success, error } = await execGitCommit(edited);
                    if (success) {
                        vscode.window.showInformationMessage(`✅ Committed: ${edited.split('\n')[0]}`);
                    } else {
                        vscode.window.showErrorMessage(`❌ Commit failed: ${error}`);
                    }
                    return;
                }

                if (next.label.includes('Copy')) {
                    await copyToClipboard(edited);
                    vscode.window.showInformationMessage('📋 Commit message copied to clipboard!');
                    return;
                }

                continue;
            }

            if (action.includes('Copy')) {
                await copyToClipboard(suggestion.message);
                vscode.window.showInformationMessage('📋 Commit message copied to clipboard!');
                return;
            }

            if (action.includes('Regenerate')) {
                let newSuggestion: CommitSuggestion | null = null;

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: '🔄 Regenerating commit message...',
                        cancellable: false,
                    },
                    async () => {
                        const prompt = buildCommitPrompt(diff, recentCommits, branchName, hintType, hintScope)
                            + '\n\n(Note: Generate a different message than your previous suggestion.)';
                        const raw = await this._rawGenerateWithCommitPrompt(prompt);
                        newSuggestion = parseCommitResponse(raw);
                    }
                );

                if (newSuggestion) {
                    suggestion = newSuggestion;
                } else {
                    vscode.window.showWarningMessage('⚠️ Regeneration failed, keeping previous suggestion.');
                }

                continue;
            }
        }
    }
}
