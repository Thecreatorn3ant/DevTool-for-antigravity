import * as vscode from 'vscode';

export interface DiagnosticSnapshot {
    file: string;
    line: number;
    col: number;
    severity: 'error' | 'warning' | 'info';
    message: string;
    source?: string;
    code?: string | number;
}

export interface DiagnosticsReport {
    snapshots: DiagnosticSnapshot[];
    errorCount: number;
    warningCount: number;
    affectedFiles: string[];
    summary: string;
}

export class LspDiagnosticsManager {
    private _watcher?: vscode.Disposable;
    private _debounceTimer?: NodeJS.Timeout;
    private _onDiagnosticsChanged?: (report: DiagnosticsReport) => void;
    private _autoWatch: boolean = false;
    private _lastReport: DiagnosticsReport | null = null;

    constructor(private readonly _context: vscode.ExtensionContext) {}

    getSnapshot(scope: 'active' | 'workspace' | 'errors-only' = 'active'): DiagnosticsReport {
        const snapshots: DiagnosticSnapshot[] = [];

        if (scope === 'active') {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const diags = vscode.languages.getDiagnostics(editor.document.uri);
                for (const d of diags) {
                    snapshots.push(this._toSnapshot(editor.document.uri, d));
                }
            }
        } else {
            const all = vscode.languages.getDiagnostics();
            for (const [uri, diags] of all) {
                // Skip node_modules / dist
                const p = uri.fsPath;
                if (p.includes('node_modules') || p.includes('/dist/') || p.includes('\\.next\\')) continue;
                for (const d of diags) {
                    if (scope === 'errors-only' && d.severity !== vscode.DiagnosticSeverity.Error) continue;
                    snapshots.push(this._toSnapshot(uri, d));
                }
            }
        }

        // Sort: errors first, then by file
        snapshots.sort((a, b) => {
            if (a.severity !== b.severity) {
                const order = { error: 0, warning: 1, info: 2 };
                return order[a.severity] - order[b.severity];
            }
            return a.file.localeCompare(b.file);
        });

        const errorCount = snapshots.filter(s => s.severity === 'error').length;
        const warningCount = snapshots.filter(s => s.severity === 'warning').length;
        const affectedFiles = [...new Set(snapshots.map(s => s.file))];

        const summary = errorCount === 0 && warningCount === 0
            ? 'Aucun problème détecté.'
            : `${errorCount} erreur(s), ${warningCount} avertissement(s) dans ${affectedFiles.length} fichier(s).`;

        const report = { snapshots, errorCount, warningCount, affectedFiles, summary };
        this._lastReport = report;
        return report;
    }

    /**
     * Format diagnostics as a prompt-ready string for the AI.
     */
    formatForPrompt(report: DiagnosticsReport, maxItems: number = 30): string {
        if (report.snapshots.length === 0) return 'Aucun diagnostic LSP.';

        const lines: string[] = [
            `[DIAGNOSTICS LSP] ${report.summary}`,
            ''
        ];

        const shown = report.snapshots.slice(0, maxItems);
        for (const s of shown) {
            const icon = s.severity === 'error' ? '🔴' : s.severity === 'warning' ? '🟡' : '🔵';
            const src = s.source ? `[${s.source}]` : '';
            const code = s.code ? `(${s.code})` : '';
            lines.push(`${icon} ${s.file}:${s.line}:${s.col} ${src}${code} — ${s.message}`);
        }

        if (report.snapshots.length > maxItems) {
            lines.push(`... et ${report.snapshots.length - maxItems} autres problèmes.`);
        }

        return lines.join('\n');
    }

    /**
     * Start auto-watching diagnostics changes.
     * Fires callback when errors change after a debounce.
     */
    startWatching(onChanged: (report: DiagnosticsReport) => void, debounceMs: number = 2000) {
        this._onDiagnosticsChanged = onChanged;
        this._autoWatch = true;

        this._watcher = vscode.languages.onDidChangeDiagnostics((e) => {
            if (!this._autoWatch) return;
            // Only react if affected files are in workspace (not node_modules)
            const relevant = e.uris.some(u =>
                !u.fsPath.includes('node_modules') && !u.fsPath.includes('/dist/')
            );
            if (!relevant) return;

            if (this._debounceTimer) clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => {
                const report = this.getSnapshot('errors-only');
                this._onDiagnosticsChanged?.(report);
            }, debounceMs);
        });

        this._context.subscriptions.push(this._watcher);
    }

    stopWatching() {
        this._autoWatch = false;
        if (this._debounceTimer) clearTimeout(this._debounceTimer);
    }

    toggleWatch(onChanged: (report: DiagnosticsReport) => void): boolean {
        if (this._autoWatch) {
            this.stopWatching();
            return false;
        } else {
            this.startWatching(onChanged);
            return true;
        }
    }

    isWatching(): boolean {
        return this._autoWatch;
    }

    getLastReport(): DiagnosticsReport | null {
        return this._lastReport;
    }

    private _toSnapshot(uri: vscode.Uri, d: vscode.Diagnostic): DiagnosticSnapshot {
        const sevMap: Record<number, 'error' | 'warning' | 'info'> = {
            [vscode.DiagnosticSeverity.Error]: 'error',
            [vscode.DiagnosticSeverity.Warning]: 'warning',
            [vscode.DiagnosticSeverity.Information]: 'info',
            [vscode.DiagnosticSeverity.Hint]: 'info',
        };
        return {
            file: vscode.workspace.asRelativePath(uri),
            line: d.range.start.line + 1,
            col: d.range.start.character + 1,
            severity: sevMap[d.severity] ?? 'info',
            message: d.message,
            source: d.source,
            code: typeof d.code === 'object' ? d.code.value : d.code,
        };
    }
}
