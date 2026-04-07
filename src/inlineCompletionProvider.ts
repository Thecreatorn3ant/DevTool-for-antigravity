import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';

const DEBOUNCE_MS = 600;
const MAX_CONTEXT_LINES = 60;
const MAX_SUFFIX_LINES = 20;
const COMPLETION_TIMEOUT_MS = 10_000;

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
    private _debounceTimer?: NodeJS.Timeout;
    private _abortController?: AbortController;
    private _enabled: boolean = false;
    private _lastRequestTime = 0;

    constructor(
        private readonly _ollamaClient: OllamaClient,
    ) {
        this._enabled = vscode.workspace.getConfiguration('local-ai').get<boolean>('enableInlineCompletion', false);

        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('local-ai.enableInlineCompletion')) {
                this._enabled = vscode.workspace.getConfiguration('local-ai').get<boolean>('enableInlineCompletion', false);
                console.log(`[Antigravity] Inline completion: ${this._enabled ? 'activé' : 'désactivé'}`);
            }
        });
    }

    get isEnabled(): boolean {
        return this._enabled;
    }

    toggle(): boolean {
        this._enabled = !this._enabled;
        vscode.workspace.getConfiguration('local-ai').update('enableInlineCompletion', this._enabled, true);
        return this._enabled;
    }

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[] | null> {
        if (!this._enabled) return null;

        if (document.uri.scheme !== 'file') return null;

        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
        if (this._abortController) {
            this._abortController.abort();
        }

        return new Promise<vscode.InlineCompletionItem[] | null>((resolve) => {
            this._debounceTimer = setTimeout(async () => {
                if (token.isCancellationRequested) {
                    resolve(null);
                    return;
                }

                try {
                    const result = await this._generateCompletion(document, position, token);
                    resolve(result);
                } catch (e: any) {
                    if (e.name !== 'AbortError') {
                        console.error('[Antigravity] Inline completion error:', e.message);
                    }
                    resolve(null);
                }
            }, DEBOUNCE_MS);

            token.onCancellationRequested(() => {
                if (this._debounceTimer) clearTimeout(this._debounceTimer);
                if (this._abortController) this._abortController.abort();
                resolve(null);
            });
        });
    }

    private async _generateCompletion(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): Promise<vscode.InlineCompletionItem[] | null> {
        this._abortController = new AbortController();
        const signal = this._abortController.signal;

        const timeoutId = setTimeout(() => this._abortController?.abort(), COMPLETION_TIMEOUT_MS);

        try {
            const language = document.languageId;
            const fileName = document.fileName.split(/[/\\]/).pop() || 'file';

            const prefixStart = Math.max(0, position.line - MAX_CONTEXT_LINES);
            const prefixRange = new vscode.Range(
                new vscode.Position(prefixStart, 0),
                position,
            );
            const prefix = document.getText(prefixRange);

            const suffixEnd = Math.min(document.lineCount - 1, position.line + MAX_SUFFIX_LINES);
            const suffixRange = new vscode.Range(
                position,
                new vscode.Position(suffixEnd, document.lineAt(suffixEnd).text.length),
            );
            const suffix = document.getText(suffixRange);

            const config = vscode.workspace.getConfiguration('local-ai');
            const inlineModel = config.get<string>('inlineCompletionModel', '') || config.get<string>('defaultModel', 'llama3');

            const prompt = this._buildFIMPrompt(prefix, suffix, language, fileName);

            const systemPrompt = [
                'Tu es un assistant de complétion de code. Tu dois UNIQUEMENT répondre avec le code qui complète la position du curseur.',
                'Règles strictes :',
                '- Réponds UNIQUEMENT avec le code manquant, sans explication',
                '- Ne répète PAS le code déjà présent avant le curseur',
                '- Ne mets PAS de blocs markdown (pas de ```)',
                '- Complète logiquement en respectant l\'indentation et le style du code existant',
                '- Si rien de pertinent à compléter, réponds avec une chaîne vide',
                '- Maximum 5 lignes de complétion',
            ].join('\n');

            let completionText = '';
            const slot = await this._ollamaClient.router.selectProvider('code', undefined, false, '', true);

            if (token.isCancellationRequested || signal.aborted) return null;

            const { localStream } = await import('./localProvider');
            completionText = await localStream({
                model: inlineModel,
                prompt,
                systemPrompt,
                signal,
                baseUrl: slot.url,
                apiKey: slot.apiKey || undefined,
            }, () => { });

            this._ollamaClient.router.reportSuccess(slot.url, Date.now() - this._lastRequestTime, 0, slot.apiKey);
            this._lastRequestTime = Date.now();

            completionText = this._cleanCompletion(completionText, prefix);

            if (!completionText || completionText.trim().length === 0) return null;

            const item = new vscode.InlineCompletionItem(
                completionText,
                new vscode.Range(position, position),
            );

            return [item];
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private _buildFIMPrompt(prefix: string, suffix: string, language: string, fileName: string): string {
        return [
            `Fichier: ${fileName} (${language})`,
            '',
            '--- CODE AVANT LE CURSEUR ---',
            prefix,
            '--- CURSEUR ICI (compléter) ---',
            '--- CODE APRÈS LE CURSEUR ---',
            suffix,
            '',
            'Complète le code à la position du curseur. Réponds UNIQUEMENT avec le code manquant.',
        ].join('\n');
    }

    private _cleanCompletion(text: string, prefix: string): string {
        let cleaned = text.replace(/^```[\w]*\n?/gm, '').replace(/\n?```$/gm, '').trim();

        const lastLine = prefix.split('\n').pop() || '';
        if (lastLine.trim() && cleaned.startsWith(lastLine.trim())) {
            cleaned = cleaned.slice(lastLine.trim().length);
        }

        const lines = cleaned.split('\n');
        if (lines.length > 5) {
            cleaned = lines.slice(0, 5).join('\n');
        }

        return cleaned;
    }

    dispose() {
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
        if (this._abortController) this._abortController.abort();
    }
}
