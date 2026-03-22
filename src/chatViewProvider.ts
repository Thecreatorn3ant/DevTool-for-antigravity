import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { OllamaClient, ContextFile, ApiKeyStatus, estimateTokens, AttachedImage } from './ollamaClient';
import { FileContextManager } from './fileContextManager';
import { LspDiagnosticsManager } from './lspDiagnosticsManager';
import { AgentRunner, AgentSession } from './agentRunner';
import { ChatSessionManager, PromptTemplate } from './chatSessionManager';

interface ChatMessage {
    role: 'user' | 'ai';
    value: string;
}

class AiPreviewProvider implements vscode.TextDocumentContentProvider {
    static readonly scheme = 'ai-preview';
    private _content = new Map<string, string>();
    private _emitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._emitter.event;

    set(uri: vscode.Uri, text: string) {
        this._content.set(uri.toString(), text);
        this._emitter.fire(uri);
    }
    delete(uri: vscode.Uri) { this._content.delete(uri.toString()); }
    provideTextDocumentContent(uri: vscode.Uri): string {
        const uriStr = uri.toString();
        if (this._content.has(uriStr)) return this._content.get(uriStr)!;
        const lowerUri = uriStr.toLowerCase();
        for (const [key, value] of this._content.entries()) {
            if (key.toLowerCase() === lowerUri) return value;
        }
        return '';
    }
}

function applySearchReplace(
    documentText: string,
    patchContent: string
): { result: string; patchCount: number; errors: string[] } {
    const errors: string[] = [];
    let patchCount = 0;
    const norm = (s: string) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const isCrLf = documentText.includes('\r\n');
    const docNorm = norm(documentText);
    const patchNorm = norm(patchContent);

    const lines = patchNorm.split('\n');
    const patches: Array<{ search: string; replace: string }> = [];
    let state: 'idle' | 'search' | 'replace' = 'idle';
    let searchLines: string[] = [];
    let replaceLines: string[] = [];

    const isSearchMarker = (l: string) => /^\s*<{2,}\s*SEARCH/i.test(l);
    const isSeparator = (l: string) => /^\s*={4,}/i.test(l);
    const isCloseMarker = (l: string) => /^\s*>{2,}/.test(l);

    for (const line of lines) {
        if (state === 'idle') {
            if (isSearchMarker(line)) { state = 'search'; searchLines = []; replaceLines = []; }
        } else if (state === 'search') {
            if (isSeparator(line)) { state = 'replace'; }
            else { searchLines.push(line); }
        } else if (state === 'replace') {
            if (isCloseMarker(line)) {
                patches.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
                state = 'idle';
            } else { replaceLines.push(line); }
        }
    }
    if (state === 'replace' && searchLines.length > 0) {
        patches.push({ search: searchLines.join('\n'), replace: replaceLines.join('\n') });
    }

    if (patches.length === 0) return { result: docNorm, patchCount: 0, errors: [] };

    let workingText = docNorm;

    for (const patch of patches) {
        const { search, replace } = patch;
        if (workingText.includes(search)) {
            workingText = workingText.replace(search, replace);
            patchCount++; continue;
        }

        const trimEnd = (s: string) => s.split('\n').map(l => l.trimEnd()).join('\n');
        const searchTrimmed = trimEnd(search);
        const workingTrimmed = trimEnd(workingText);
        if (workingTrimmed.includes(searchTrimmed)) {
            const tempDoc = workingText.split('\n').map(l => l.trimEnd()).join('\n');
            workingText = tempDoc.replace(searchTrimmed, replace);
            patchCount++; continue;
        }

        const fuzzyLines = search.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const workingLines = workingText.split('\n');
        let fuzzyMatched = false;

        if (fuzzyLines.length > 0) {
            for (let i = 0; i < workingLines.length; i++) {
                let si = 0, di = i;
                while (si < fuzzyLines.length && di < workingLines.length) {
                    const dl = workingLines[di].trim();
                    if (dl === '') { di++; continue; }
                    if (dl !== fuzzyLines[si]) break;
                    si++; di++;
                }
                if (si === fuzzyLines.length) {
                    const textToReplace = workingLines.slice(i, di).join('\n');
                    if (workingText.split(textToReplace).length - 1 === 1) {
                        workingText = workingText.replace(textToReplace, replace);
                        patchCount++; fuzzyMatched = true;
                    }
                    break;
                }
            }
        }
        if (!fuzzyMatched) errors.push(`Bloc SEARCH introuvable : "${search.substring(0, 60)}..."`);
    }

    return { result: workingText, patchCount, errors };
}

function parseAiResponse(response: string): {
    needFiles: string[];
    willModify: string[];
    plan: string | null;
    createFiles: Array<{ name: string; content: string }>;
    deleteFiles: string[];
    projectSummary: string | null;
    commands: Array<{ cmd: string; isImportant: boolean; badge: string; label: string }>;
} {
    const needFiles: string[] = [];
    const willModify: string[] = [];
    const createFiles: Array<{ name: string; content: string }> = [];
    const deleteFiles: string[] = [];
    let plan: string | null = null;
    let projectSummary: string | null = null;

    const needFileRegex = /\[NEED_FILE:\s*([^\]]+)\]/g;
    let m;
    while ((m = needFileRegex.exec(response)) !== null) {
        needFiles.push(m[1].trim());
    }

    const willModifyMatch = /\[WILL_MODIFY:\s*([^\]]+)\]/.exec(response);
    if (willModifyMatch) {
        willModify.push(...willModifyMatch[1].split(',').map(s => s.trim()).filter(Boolean));
    }

    const planMatch = /\[PLAN\]([\s\S]*?)\[\/PLAN\]/.exec(response);
    if (planMatch) plan = planMatch[1].trim();

    const createFileRegex = /\[CREATE_FILE:\s*([^\]]+)\]\s*```(?:\w+)?\n([\s\S]*?)```/g;
    while ((m = createFileRegex.exec(response)) !== null) {
        createFiles.push({ name: m[1].trim(), content: m[2] });
    }

    const deleteFileRegex = /\[DELETE_FILE:\s*([^\]]+)\]/g;
    while ((m = deleteFileRegex.exec(response)) !== null) {
        deleteFiles.push(m[1].trim());
    }

    const summaryMatch = /\[PROJECT_SUMMARY\]([\s\S]*?)\[\/PROJECT_SUMMARY\]/.exec(response);
    if (summaryMatch) projectSummary = summaryMatch[1].trim();

    const commands: Array<{ cmd: string; isImportant: boolean; badge: string; label: string }> = [];
    const cmdRegex = /\[CMD(?:_(IMPORTANT))?:\s*([^\]]+)\]/g;
    while ((m = cmdRegex.exec(response)) !== null) {
        const isImportant = !!m[1];
        commands.push({
            isImportant,
            cmd: m[2].trim(),
            badge: isImportant ? 'important' : 'normal',
            label: isImportant ? 'CRITIQUE' : 'CMD'
        });
    }

    return { needFiles, willModify, plan, createFiles, deleteFiles, projectSummary, commands };
}

function extractMultiFilePatches(response: string): Map<string, string> {
    const patches = new Map<string, string>();

    const fileBlockRegex = /\[FILE:\s*([^\]]+)\]([\s\S]*?)(?=\[FILE:|$)/g;
    let m;
    while ((m = fileBlockRegex.exec(response)) !== null) {
        const fileName = m[1].trim();
        const content = m[2].trim();
        if (content) patches.set(fileName, content);
    }

    return patches;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'local-ai.chatView';
    private _view?: vscode.WebviewView;
    private _history: ChatMessage[] = [];
    private _contextFiles: ContextFile[] = [];
    private _currentAbortController?: AbortController;
    private _thinkMode: boolean = false;
    private _currentModel: string = 'llama3';
    private _currentUrl: string = '';
    private _terminalPermission: 'ask-all' | 'ask-important' | 'allow-all' = 'ask-important';
    private static readonly _previewProvider = new AiPreviewProvider();
    private static _providerRegistered = false;
    private _lspManager: LspDiagnosticsManager;
    private _agentRunner: AgentRunner;
    private _agentSession: AgentSession | null = null;
    private _lspWatchActive: boolean = false;
    private _sessionManager: ChatSessionManager;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _ollamaClient: OllamaClient,
        private readonly _fileCtxManager: FileContextManager,
        sessionManager: ChatSessionManager,
    ) {
        this._sessionManager = sessionManager;
        this._history = this._context.workspaceState.get<ChatMessage[]>('chatHistory', []);
        this._terminalPermission = this._context.workspaceState.get<'ask-all' | 'ask-important' | 'allow-all'>('terminalPermission', 'ask-important');
        this._lspManager = new LspDiagnosticsManager(this._context);
        this._agentRunner = new AgentRunner(this._ollamaClient, this._fileCtxManager, this._lspManager, this._context);
        if (!ChatViewProvider._providerRegistered) {
            this._context.subscriptions.push(
                vscode.workspace.registerTextDocumentContentProvider(
                    AiPreviewProvider.scheme,
                    ChatViewProvider._previewProvider
                )
            );
            ChatViewProvider._providerRegistered = true;
        }

        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && this._view) {
                const name = vscode.workspace.asRelativePath(editor.document.fileName);
                const history = this._fileCtxManager.getFileHistory(name);
                this._view.webview.postMessage({ type: 'fileHistoryChanged', fileName: name, history });
            }
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };
        const onboardingComplete = this._context.globalState.get('antigravity.onboardingComplete', false);
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, !onboardingComplete);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleSendMessage(
                        data.value,
                        data.model,
                        data.url,
                        data.contextFiles,
                        data.thinkMode,
                        data.images
                    );
                    break;
                case 'openCloudConnect': await this._handleCloudConnection(); break;
                case 'getModels': await this._updateModelsList(); break;
                case 'saveModel':
                    await this._context.workspaceState.update('lastSelectedModel', data.model);
                    if (data.model?.includes('||')) {
                        const parts = data.model.split('||');
                        this._currentUrl = parts[0];
                        this._currentModel = parts[1];
                    } else {
                        this._currentModel = data.model || 'llama3';
                        this._currentUrl = '';
                    }
                    break;
                case 'restoreHistory':
                    webviewView.webview.postMessage({ type: 'restoreHistory', history: this._history });
                    break;
                case 'createFile':
                    if (data.value && data.target) await this._handleFileCreation(data.target, data.value);
                    break;
                case 'applyToActiveFile':
                    if (data.value) await this._handleApplyEdit(data.value, data.targetFile);
                    break;
                case 'applyMultiFile':
                    if (data.patches) await this._handleMultiFileApply(data.patches);
                    break;
                case 'requestFileAccess':
                    if (data.target) await this._handleFileAccessRequest(data.target);
                    break;
                case 'clearHistory':
                    this._history = [];
                    this._updateHistory();
                    break;
                case 'openFile':
                    if (data.value) await this._handleOpenFile(data.value);
                    break;
                case 'addRelatedFiles':
                    await this._handleAddRelatedFiles();
                    break;
                case 'finishOnboarding':
                    await this._context.globalState.update('antigravity.onboardingComplete', true);
                    break;
                case 'setupGeminiKey':
                    if (data.key) {
                        await this._ollamaClient.addApiKey({
                            name: 'Google Gemini (Onboarding)',
                            url: 'https://generativelanguage.googleapis.com/v1beta',
                            key: data.key
                        });
                        vscode.window.showInformationMessage('✅ Clé Gemini configurée avec succès !');
                        await this._updateModelsList();
                    }
                    break;
                case 'toggleThinkMode':
                    this._thinkMode = !this._thinkMode;
                    webviewView.webview.postMessage({ type: 'thinkModeChanged', active: this._thinkMode });
                    break;
                case 'analyzeError':
                    if (data.value) await this.analyzeError(data.value);
                    break;
                case 'generateCommitMessage':
                    await this._handleGenerateCommitMessage();
                    break;
                case 'reviewDiff':
                    await this._handleReviewDiff();
                    break;
                case 'generateTests':
                    await this._handleGenerateTests();
                    break;
                case 'updateProjectSummary':
                    await this._handleUpdateProjectSummary();
                    break;
                case 'removeContextFile':
                    this._contextFiles = this._contextFiles.filter(f => f.name !== data.name);
                    break;
                case 'stopGeneration':
                    this._handleStopGeneration();
                    break;
                case 'revertTo':
                    if (data.index !== undefined) this._handleRevertTo(data.index);
                    break;
                case 'getTokenBudget':
                    this._sendTokenBudget();
                    break;
                case 'patchNotification':
                    vscode.window.showInformationMessage(`✅ ${data.summary}`);
                    break;
                case 'setTerminalPermission':
                    this._terminalPermission = data.value || 'ask-all';
                    this._context.workspaceState.update('terminalPermission', this._terminalPermission);
                    break;
                case 'getTerminalPermission':
                    webviewView.webview.postMessage({ type: 'setTerminalPermission', value: this._terminalPermission });
                    break;
                case 'runCommand':
                    if (data.value) await this._handleRunCommand(data.value, data.isImportant === true);
                    break;
                case 'getLspDiagnostics':
                    this._handleGetLspDiagnostics(data.scope || 'active');
                    break;
                case 'toggleLspWatch':
                    this._handleToggleLspWatch();
                    break;
                case 'runAgent':
                    if (data.goal) await this._handleRunAgent(data.goal);
                    break;
                case 'stopAgent':
                    this._agentRunner.stop();
                    this._view?.webview.postMessage({ type: 'agentStopped' });
                    break;
                case 'resetChat': {
                    const result = await this._sessionManager.promptForReset();
                    if (result.reset) {
                        await this.resetChat(result.template);
                    }
                    break;
                }
                case 'showModelInfo':
                    vscode.commands.executeCommand('local-ai.showModelInfo');
                    break;
            }
        });
    }

    public sendMessageFromEditor(message: string) {
        this._view?.webview.postMessage({ type: 'injectMessage', value: message });
    }

    public activateThinkMode() {
        this._thinkMode = true;
        this._view?.webview.postMessage({ type: 'thinkModeChanged', active: true });
    }

    public addFilesToContext(files: ContextFile[]) {
        for (const f of files) {
            if (!this._contextFiles.find(x => x.name === f.name)) {
                this._contextFiles.push(f);
            }
        }
        this._view?.webview.postMessage({
            type: 'updateContextFiles',
            files: this._contextFiles.map(f => ({ name: f.name, tokens: estimateTokens(f.content) }))
        });
        this._sendTokenBudget();
    }

    public triggerLspAnalysis(scope: 'active' | 'workspace' | 'errors-only' = 'workspace') {
        this._handleGetLspDiagnostics(scope);
    }

    public async runAgentFromCommand(goal: string) {
        await this._handleRunAgent(goal);
    }

    public async resetChat(template?: PromptTemplate): Promise<void> {
        const config = vscode.workspace.getConfiguration('local-ai');
        const model = config.get<string>('defaultModel', 'llama3');

        const session = await this._sessionManager.createNewSession(
            model,
            template?.systemPrompt
        );

        this._history = [];
        this._updateHistory();

        this._view?.webview.postMessage({
            type: 'reset',
            sessionTitle: session.title,
            templateName: template?.name
        });

        if (template?.initialMessage) {
            setTimeout(() => {
                this.sendMessageFromEditor(template.initialMessage!);
            }, 300);
        }

        vscode.window.showInformationMessage(
            template
                ? `🔄 Chat réinitialisé avec template "${template.name}"`
                : '🔄 Nouveau chat créé'
        );
    }

    public async analyzeError(errorText: string) {
        if (!this._view) return;

        this._view.webview.postMessage({ type: 'statusMessage', value: '🔍 Analyse de l\'erreur en cours...' });

        const relatedFiles = await this._fileCtxManager.findFilesForError(errorText);

        if (relatedFiles.length > 0) {
            this.addFilesToContext(relatedFiles);
            this._view.webview.postMessage({
                type: 'statusMessage',
                value: `📁 ${relatedFiles.length} fichier(s) détecté(s) automatiquement : ${relatedFiles.map(f => f.name).join(', ')}`
            });
        }

        setTimeout(() => {
            this.sendMessageFromEditor(
                `Analyse cette erreur et propose un correctif :\n\`\`\`\n${errorText}\n\`\`\``
            );
        }, 500);
    }

    private async _handleSendMessage(
        userMsg: string,
        model?: string,
        targetUrl?: string,
        webviewContextFiles?: Array<{ name: string; content: string }>,
        thinkMode?: boolean,
        images?: AttachedImage[]
    ) {
        if (!userMsg || !this._view) return;

        let resolvedModel = model || this._currentModel || 'llama3';
        let resolvedUrl = targetUrl || this._currentUrl || '';
        if (resolvedModel.includes('||')) {
            const parts = resolvedModel.split('||');
            resolvedUrl = parts[0];
            resolvedModel = parts[1];
        }

        const isCloud = this._ollamaClient.isCloud(resolvedUrl || undefined);
        const budget = await this._ollamaClient.getTokenBudgetAsync(resolvedModel, resolvedUrl || undefined);

        const allContextFiles: ContextFile[] = [...this._contextFiles];
        if (webviewContextFiles) {
            for (const f of webviewContextFiles) {
                if (!allContextFiles.find(x => x.name === f.name)) {
                    allContextFiles.push({ name: f.name, content: f.content, isActive: false });
                }
            }
        }

        const maxPerFile = isCloud ? 40000 : 8000;
        const activeFile = await this._fileCtxManager.getActiveFile(maxPerFile);
        if (activeFile && !allContextFiles.find(f => f.name === activeFile.name)) {
            allContextFiles.unshift(activeFile);
        }

        if (activeFile && (isCloud || allContextFiles.length < 3)) {
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const related = await this._fileCtxManager.getRelatedFiles(editor.document, maxPerFile);
                for (const r of related) {
                    if (!allContextFiles.find(f => f.name === r.name)) {
                        allContextFiles.push(r);
                    }
                }
            }
        }

        const maxFiles = isCloud ? 10 : 3;
        const limitedFiles = allContextFiles.slice(0, maxFiles);

        const formattedHistory = this._getFormattedHistory();
        const { context, budget: usedBudget } = await this._ollamaClient.buildContextAsync(
            limitedFiles,
            formattedHistory,
            resolvedModel,
            resolvedUrl || undefined
        );

        const projectSummary = this._fileCtxManager.getProjectSummary();
        const workspaceTree = await this._fileCtxManager.getWorkspaceTree();
        const treeStr = workspaceTree.slice(0, 100).join('\n');

        const thinkPrefix = (thinkMode || this._thinkMode)
            ? 'MODE RÉFLEXION ACTIVÉ : Commence par un bloc [PLAN] listant TOUTES les modifications que tu prévois de faire (fichiers, fonctions, raisons), puis [/PLAN]. Ensuite seulement, fournis le code.\n\n'
            : '';

        const fullContext = [
            projectSummary ? `[MÉMOIRE PROJET]\n${projectSummary}` : '',
            '[STRUCTURE]',
            treeStr,
            '',
            '[HISTORIQUE RÉCENT]',
            formattedHistory,
            '',
            '[FICHIERS EN CONTEXTE]',
            context
        ].filter(Boolean).join('\n');

        const finalPrompt = thinkPrefix + userMsg;

        this._history.push({ role: 'user', value: userMsg });
        this._updateHistory();
        if (!this._sessionManager.getCurrentSession()) {
            await this._sessionManager.createNewSession(resolvedModel);
        }
        this._sessionManager.addMessage('user', userMsg);

        if (this._currentAbortController) {
            this._currentAbortController.abort();
        }
        this._currentAbortController = new AbortController();

        this._view.webview.postMessage({ type: 'startResponse' });
        this._view.webview.postMessage({
            type: 'tokenBudget',
            used: estimateTokens(fullContext + finalPrompt),
            max: Math.floor(budget.max / 4),
            isCloud
        });

        try {
            let fullRes = '';
            await this._ollamaClient.generateStreamingResponse(
                finalPrompt,
                fullContext,
                (chunk) => {
                    fullRes += chunk;
                    this._view?.webview.postMessage({ type: 'partialResponse', value: chunk });
                },
                resolvedModel,
                resolvedUrl || undefined,
                images,
                'chat',
                '',
                this._currentAbortController.signal
            );

            this._history.push({ role: 'ai', value: fullRes });
            this._updateHistory();
            if (this._sessionManager.getCurrentSession()) {
                this._sessionManager.addMessage('assistant', fullRes);
            }
            this._view.webview.postMessage({ type: 'endResponse', value: fullRes });
            this._sendTokenBudget();

            if (activeFile) {
                const fileHist = this._fileCtxManager.getFileHistory(activeFile.name);
                fileHist.push({ role: 'user', value: userMsg });
                fileHist.push({ role: 'ai', value: fullRes });
                await this._fileCtxManager.saveFileHistory(activeFile.name, fileHist);
            }

            await this._processAiResponse(fullRes);

        } catch (e: any) {
            if (e.name === 'AbortError') {
                this._history.push({
                    role: 'ai',
                    value: '⚠️ Génération arrêtée par l\'utilisateur.'
                });
                this._updateHistory();
                this._view.webview.postMessage({
                    type: 'endResponse',
                    value: '⚠️ Génération arrêtée par l\'utilisateur.'
                });
            } else {
                const msg = e?.message ?? String(e);
                const is403 = msg.includes('403') || msg.includes('PERMISSION_DENIED');
                const is404 = msg.includes('404') || msg.includes('not found');
                const isRateLimit = msg.includes('429') || msg.includes('rate limit');

                let errorMessage = '';

                if (is403) {
                    errorMessage = `❌ **Erreur 403 - Accès refusé**\n\nLa requête a été refusée par le serveur.\n\n**Solutions :**\n1. Vérifiez votre clé API dans les paramètres (☁️ Cloud)\n2. Essayez un autre modèle\n\n_Détails : ${msg}_`;
                } else if (is404) {
                    errorMessage = `❌ **Erreur 404 - Modèle introuvable**\n\nLe modèle demandé n'existe pas ou n'est plus disponible.\n\n_Détails : ${msg}_`;
                } else if (isRateLimit) {
                    errorMessage = `⚠️ **Erreur 429 - Limite de requêtes atteinte**\n\nVous avez atteint la limite de requêtes autorisées.\n\n_Détails : ${msg}_`;
                } else {
                    errorMessage = `❌ **Erreur lors de la génération**\n\n\`\`\`\n${msg}\n\`\`\``;
                }

                this._history.push({ role: 'ai', value: errorMessage });
                this._updateHistory();
                this._view.webview.postMessage({ type: 'endResponse', value: errorMessage });
            }
            this._sendTokenBudget();
        } finally {
            this._currentAbortController = undefined;
        }
    }

    private _handleStopGeneration() {
        if (this._currentAbortController) {
            this._currentAbortController.abort();
            this._currentAbortController = undefined;
        }
    }

    private _handleRevertTo(index: number) {
        if (index < 0 || index >= this._history.length) return;
        const msg = this._history[index];
        if (msg.role !== 'user') return;
        const textToRestore = msg.value;
        this._history = this._history.slice(0, index);
        this._updateHistory();
        this._view?.webview.postMessage({ type: 'restoreHistory', history: this._history });
        this._view?.webview.postMessage({ type: 'injectMessage', value: textToRestore });
    }

    private async _processAiResponse(response: string) {
        const parsed = parseAiResponse(response);

        for (const filePath of parsed.needFiles) {
            const alreadyAvailable = this._contextFiles.some(f =>
                f.name === filePath || f.name.endsWith(filePath) || filePath.endsWith(f.name)
            );
            if (alreadyAvailable) continue;
            const file = await this._fileCtxManager.handleAiFileRequest(filePath, 'ask-workspace');
            if (file) {
                this.addFilesToContext([{ ...file, isActive: false }]);
                this._view?.webview.postMessage({
                    type: 'statusMessage',
                    value: `📁 Fichier "${file.name}" ajouté au contexte IA.`
                });
            }
        }

        for (const cf of parsed.createFiles) {
            if (this._fileCtxManager.isInWorkspace(cf.name)) {
                await this._handleFileCreation(cf.name, cf.content);
            } else {
                const answer = await vscode.window.showInformationMessage(
                    `L'IA veut créer : "${cf.name}" (hors workspace). Confirmer ?`,
                    '✅ Créer', '❌ Ignorer'
                );
                if (answer === '✅ Créer') {
                    await this._handleFileCreation(cf.name, cf.content);
                }
            }
        }

        for (const filePath of parsed.deleteFiles) {
            if (this._fileCtxManager.isInWorkspace(filePath)) {
                await this._handleFileDeletion(filePath);
            } else {
                const answer = await vscode.window.showInformationMessage(
                    `⚠️ L'IA veut SUPPRIMER : "${filePath}" (hors workspace). Confirmer ?`,
                    { modal: true },
                    '🗑 Supprimer', '❌ Annuler'
                );
                if (answer === '🗑 Supprimer') {
                    await this._handleFileDeletion(filePath);
                }
            }
        }

        if (parsed.projectSummary) {
            await this._fileCtxManager.saveProjectSummary(parsed.projectSummary);
            this._showNotification('✅ Mémoire du projet mise à jour', 'success');
        }

        if (parsed.plan) {
            this._view?.webview.postMessage({ type: 'showPlan', plan: parsed.plan });
        }

        for (const { cmd, isImportant } of parsed.commands) {
            await this._handleRunCommand(cmd, isImportant);
        }
        const multiPatches = extractMultiFilePatches(response);
        if (multiPatches.size > 0) {
            const allInWorkspace = Array.from(multiPatches.keys()).every(f => this._fileCtxManager.isInWorkspace(f));
            if (allInWorkspace) {
                await this._handleMultiFileApply(
                    Array.from(multiPatches.entries()).map(([name, patch]) => ({ name, patch })),
                    true
                );
            } else {
                const fileList = Array.from(multiPatches.keys()).join(', ');
                const answer = await vscode.window.showInformationMessage(
                    `L'IA propose des modifications sur ${multiPatches.size} fichier(s) : ${fileList}`,
                    '📋 Appliquer', '👁 Voir fichier par fichier', '❌ Ignorer'
                );
                if (answer === '📋 Appliquer') {
                    await this._handleMultiFileApply(
                        Array.from(multiPatches.entries()).map(([name, patch]) => ({ name, patch }))
                    );
                } else if (answer === '👁 Voir fichier par fichier') {
                    for (const [fileName, patch] of multiPatches) {
                        await this._handleApplyEdit(patch, fileName);
                    }
                }
            }
        }
    }

    private async _handleMultiFileApply(patches: Array<{ name: string; patch: string }>, autoAccept: boolean = false) {
        let applied = 0;
        for (const { name, patch } of patches) {
            try {
                await this._handleApplyEdit(patch, name, autoAccept);
                applied++;
            } catch (e: any) {
                vscode.window.showErrorMessage(`Erreur sur ${name}: ${e.message}`);
            }
        }
        if (applied > 0) {
            this._showNotification(`✅ ${applied} fichier(s) modifié(s)`, 'success');
        }
    }

    private async _handleAddRelatedFiles() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('Aucun fichier actif.');
            return;
        }
        const isCloud = this._ollamaClient.isCloud(this._currentUrl || undefined);
        const maxChars = isCloud ? 40000 : 8000;
        const related = await this._fileCtxManager.getRelatedFiles(editor.document, maxChars);

        if (related.length === 0) {
            this._showNotification('Aucun import local détecté', 'info');
            return;
        }

        this.addFilesToContext(related);
        this._view?.webview.postMessage({
            type: 'statusMessage',
            value: `🔗 ${related.length} fichier(s) lié(s) ajouté(s) : ${related.map(f => f.name).join(', ')}`
        });
    }

    private async _handleCloudConnection() {
        await this._showKeyManagerMenu();
    }

    private async _showKeyManagerMenu() {
        interface KeyMenuItem extends vscode.QuickPickItem {
            action: 'select' | 'add' | 'manage';
            keyIdx?: number;
        }

        const statuses = await this._ollamaClient.getApiKeyStatusesAsync();

        const keyItems: KeyMenuItem[] = statuses.map((s, i) => ({
            label: `${s.statusIcon} ${s.entry.name}`,
            description: s.entry.url,
            detail: `${s.statusLabel}  ·  Ajouté ${s.entry.addedAt ? new Date(s.entry.addedAt).toLocaleDateString('fr-FR') : 'N/A'}`,
            action: 'select',
            keyIdx: i,
        }));

        const items: KeyMenuItem[] = [
            ...keyItems,
            { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
            { label: '$(add)  Ajouter une clé API', description: 'Configurer un nouveau provider cloud', action: 'add' },
            { label: '$(gear)  Gérer les clés existantes', description: 'Modifier / Supprimer / Réinitialiser le cooldown', action: 'manage' },
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: '☁️ Gestion des clés API Cloud',
            placeHolder: statuses.length === 0 ? 'Aucune clé configurée — ajoutez-en une' : 'Sélectionner un compte ou gérer les clés',
            matchOnDescription: true,
            matchOnDetail: false,
        });
        if (!picked) return;

        if (picked.action === 'add') {
            await this._handleAddKey();
        } else if (picked.action === 'manage') {
            await this._handleManageKeys();
        } else if (picked.action === 'select' && picked.keyIdx !== undefined) {
            const entry = statuses[picked.keyIdx].entry;
            const status = statuses[picked.keyIdx];
            if (status.status === 'cooldown') {
                const choice = await vscode.window.showWarningMessage(
                    `⚠️ "${entry.name}" est en cooldown encore ${status.cooldownSecsLeft}s. Utiliser quand même ?`,
                    'Utiliser quand même', 'Réinitialiser le cooldown', 'Annuler'
                );
                if (!choice || choice === 'Annuler') return;
                if (choice === 'Réinitialiser le cooldown') {
                    await this._ollamaClient.resetKeyCooldown(entry.key, entry.url);
                    vscode.window.showInformationMessage(`✅ Cooldown réinitialisé pour "${entry.name}".`);
                }
            }
            await this._updateModelsList(entry.url, entry.key);
        }
    }

    private async _handleAddKey() {
        const name = await vscode.window.showInputBox({
            title: 'Ajouter un provider — 1/3',
            prompt: 'Nom du provider',
            placeHolder: 'ex: OpenAI perso, Ollama VPS, OpenRouter #2…',
            ignoreFocusOut: true,
        });
        if (!name) return;

        interface UrlPreset extends vscode.QuickPickItem {
            description: string;
            needsKey: boolean;
        }
        const PRESET_URLS: UrlPreset[] = [
            { label: '☁️ Ollama Cloud (ollama.com)', description: 'https://api.ollama.com', needsKey: true, detail: 'Clé API sur ollama.com/settings' },
            { label: '⚡ Ollama auto-hébergé (sans clé)', description: '', needsKey: false, detail: 'Serveur Ollama local ou VPS' },
            { label: 'Anthropic Claude', description: 'https://api.anthropic.com/v1', needsKey: true },
            { label: 'DeepSeek', description: 'https://api.deepseek.com/v1', needsKey: true },
            { label: 'Google Gemini', description: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true },
            { label: 'OpenAI', description: 'https://api.openai.com/v1', needsKey: true },
            { label: 'OpenRouter', description: 'https://openrouter.ai/api/v1', needsKey: true },
            { label: 'Together AI', description: 'https://api.together.xyz/v1', needsKey: true },
            { label: 'Mistral', description: 'https://api.mistral.ai/v1', needsKey: true },
            { label: 'Groq', description: 'https://api.groq.com/openai/v1', needsKey: true },
            { label: 'Cohere', description: 'https://api.cohere.com/v1', needsKey: true },
            { label: 'Perplexity', description: 'https://api.perplexity.ai', needsKey: true },
            { label: 'xAI (Grok)', description: 'https://api.x.ai/v1', needsKey: true },
            { label: 'Fireworks AI', description: 'https://api.fireworks.ai/inference/v1', needsKey: true },
            { label: 'Autre / Personnalisé…', description: '', needsKey: true, detail: 'Entrer une URL manuellement' },
        ];

        const urlPick = await vscode.window.showQuickPick(PRESET_URLS, {
            title: 'Ajouter un provider — 2/3',
            placeHolder: 'Choisir le type de provider',
            matchOnDetail: true,
        });
        if (!urlPick) return;

        let url = urlPick.description;
        if (!url) {
            const isOllama = urlPick.label.startsWith('⚡');
            const custom = await vscode.window.showInputBox({
                title: "URL de base de l'API",
                prompt: isOllama ? 'URL de votre serveur Ollama' : "URL de base de l'API",
                placeHolder: isOllama ? 'http://mon-serveur:11434' : 'https://mon-serveur.com/v1',
                ignoreFocusOut: true,
            });
            if (!custom) return;
            url = custom;
        }

        const keyRequired = urlPick.needsKey;
        const key = await vscode.window.showInputBox({
            title: 'Ajouter un provider — 3/3',
            prompt: keyRequired ? `Clé API pour "${name}"` : `Clé API pour "${name}" (optionnelle)`,
            placeHolder: keyRequired ? 'sk-…' : '(optionnel)',
            password: true,
            ignoreFocusOut: true,
        });
        if (key === undefined) return;

        const result = await this._ollamaClient.addApiKey({ name, url, key: key || '' });
        if (!result.success) {
            vscode.window.showWarningMessage(`⚠️ ${result.reason}`);
            return;
        }

        vscode.window.showInformationMessage(`✅ Provider "${name}" ajouté.`);
        await this._updateModelsList(url, key || undefined);
    }

    private async _handleManageKeys() {
        const statuses = await this._ollamaClient.getApiKeyStatusesAsync();
        if (statuses.length === 0) {
            const addNow = await vscode.window.showInformationMessage('Aucune clé configurée. Ajouter une clé ?', 'Ajouter', 'Annuler');
            if (addNow === 'Ajouter') await this._handleAddKey();
            return;
        }

        interface ManageItem extends vscode.QuickPickItem { statusIdx: number; }
        const items: ManageItem[] = statuses.map((s, i) => ({
            label: `${s.statusIcon} ${s.entry.name}`,
            description: s.entry.url,
            detail: s.statusLabel + (s.entry.key ? `  ·  Clé: ${s.entry.key.substring(0, 8)}········` : ''),
            statusIdx: i,
        }));

        const picked = await vscode.window.showQuickPick(items, {
            title: '🔑 Gérer les clés — Sélectionner une clé',
            placeHolder: 'Choisir la clé à modifier',
        });
        if (!picked) return;

        const target = statuses[picked.statusIdx];
        await this._handleKeyActions(target);
    }

    private async _handleKeyActions(target: ApiKeyStatus) {
        const entry = target.entry;
        const actions: vscode.QuickPickItem[] = [
            { label: '✏️  Renommer', description: `Nom actuel : "${entry.name}"` },
            { label: '🔑  Changer la clé API', description: `Clé actuelle : ${entry.key.substring(0, 8)}·····` },
            ...(target.status === 'cooldown' ? [{ label: '🔄  Réinitialiser le cooldown', description: `Restant : ${target.cooldownSecsLeft}s` }] : []),
            { label: '🗑️  Supprimer cette clé', description: `"${entry.name}" — ${entry.url}` },
            { label: '↩️  Retour' },
        ];

        const action = await vscode.window.showQuickPick(actions, { title: `⚙️ Actions — ${entry.name}` });
        if (!action || action.label === '↩️  Retour') { await this._handleManageKeys(); return; }

        if (action.label.startsWith('✏️')) {
            const newName = await vscode.window.showInputBox({ prompt: 'Nouveau nom', value: entry.name, ignoreFocusOut: true });
            if (!newName || newName === entry.name) return;
            await this._ollamaClient.updateApiKey(entry.key, entry.url, { name: newName });
            this._showNotification(`✅ Renommé en "${newName}"`, 'success');
        } else if (action.label.startsWith('🔑')) {
            const newKey = await vscode.window.showInputBox({ prompt: `Nouvelle clé API pour "${entry.name}"`, placeHolder: 'sk-…', password: true, ignoreFocusOut: true });
            if (!newKey) return;
            await this._ollamaClient.deleteApiKey(entry.key, entry.url);
            await this._ollamaClient.addApiKey({ name: entry.name, url: entry.url, key: newKey, platform: entry.platform });
            this._showNotification(`✅ Clé mise à jour pour "${entry.name}"`, 'success');
            await this._updateModelsList(entry.url, newKey);
        } else if (action.label.startsWith('🔄')) {
            await this._ollamaClient.resetKeyCooldown(entry.key, entry.url);
            this._showNotification(`✅ Cooldown réinitialisé — "${entry.name}" disponible`, 'success');
        } else if (action.label.startsWith('🗑️')) {
            const confirm = await vscode.window.showWarningMessage(
                `Supprimer la clé "${entry.name}" ? Cette action est irréversible.`,
                { modal: true }, '🗑️ Supprimer', 'Annuler'
            );
            if (confirm !== '🗑️ Supprimer') return;
            await this._ollamaClient.deleteApiKey(entry.key, entry.url);
            this._showNotification(`🗑️ Clé "${entry.name}" supprimée`, 'info');
            await this._updateModelsList();
        }
    }

    private async _updateModelsList(cloudUrl?: string, cloudKey?: string) {
        if (!this._view) return;

        try {
            const savedKeys = await this._ollamaClient.getApiKeysAsync();
            const tmpKey = cloudUrl && cloudKey && !savedKeys.find(k => k.url === cloudUrl && k.key === cloudKey)
                ? { name: 'Cloud', url: cloudUrl, key: cloudKey }
                : undefined;

            const allModels = await this._ollamaClient.listAllModels();
            const PROVIDER_ICONS: Record<string, string> = {
                local: '⚡', lmstudio: '💻', gemini: '✦', openai: '◈', openrouter: '◎',
                together: '◉', mistral: '◆', groq: '▸', anthropic: '◈',
                deepseek: '◉', cohere: '◈', perplexity: '◎', xai: '◈',
                fireworks: '⚡', 'ollama-cloud': '☁️'
            };
            const formattedModels: Array<{ label: string; value: string; name: string; url: string; isLocal: boolean; provider: string }> = allModels.map(m => ({
                label: `${PROVIDER_ICONS[m.provider] || '☁️'} ${m.name}`,
                value: m.isLocal ? m.name : `${m.url}||${m.name}`,
                name: m.name, url: m.url, isLocal: m.isLocal, provider: m.provider
            }));

            if (tmpKey) {
                try {
                    const isOpenAI = tmpKey.url.includes('together') || tmpKey.url.includes('openrouter') || tmpKey.url.endsWith('/v1');
                    const endpoint = isOpenAI ? `${tmpKey.url}/models` : `${tmpKey.url}/api/tags`;
                    const tmpHeaders: Record<string, string> = {};
                    if (tmpKey.key) tmpHeaders['Authorization'] = `Bearer ${tmpKey.key}`;
                    const res = await fetch(endpoint, { headers: tmpHeaders, signal: AbortSignal.timeout(4000) });
                    if (res.ok) {
                        const data: any = await res.json();
                        const cloudList: string[] = isOpenAI
                            ? (data?.data || []).map((m: any) => m.id as string).filter(Boolean)
                            : (data?.models || []).map((m: any) => (m.name ?? m.id) as string).filter(Boolean);
                        cloudList.forEach(m => {
                            const val = `${tmpKey.url}||${m}`;
                            if (!formattedModels.find(x => x.value === val)) {
                                formattedModels.push({ label: `☁️  ${m}`, value: val, name: m, url: tmpKey.url, isLocal: false, provider: 'ollama-cloud' });
                            }
                        });
                    }
                } catch { }
            }

            const lastSelected = this._context.workspaceState.get<string>('lastSelectedModel');
            let selected = formattedModels.length > 0 ? formattedModels[0].value : '';
            if (lastSelected && formattedModels.find(m => m.value === lastSelected)) selected = lastSelected;

            this._view.webview.postMessage({ type: 'setModels', models: formattedModels, selected });
        } catch {
            this._view.webview.postMessage({ type: 'setModels', models: [], selected: '' });
        }
    }

    private _sendTokenBudget() {
        if (!this._view) return;
        const isCloud = this._ollamaClient.isCloud(this._currentUrl || undefined);
        const budget = this._ollamaClient.getTokenBudget(this._currentModel || 'llama3', this._currentUrl || undefined);
        const usedChars = this._contextFiles.reduce((sum, f) => sum + f.content.length, 0);
        this._view.webview.postMessage({
            type: 'tokenBudget',
            used: Math.ceil(usedChars / 4),
            max: Math.floor(budget.max / 4),
            isCloud
        });
    }

    private _showNotification(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
        this._view?.webview.postMessage({ type: 'notification', message, notificationType: type });
    }

    private _updateHistory() {
        this._context.workspaceState.update('chatHistory', this._history);
    }

    private _getFormattedHistory(): string {
        return this._history.slice(-10).map(m => `${m.role}: ${m.value.substring(0, 300)}`).join('\n');
    }

    private async _handleFileCreation(fileName: string, content: string) {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = vscode.Uri.file(path.join(folder, fileName));
        try {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
            await vscode.window.showTextDocument(uri);
            this._showNotification(`✅ Fichier créé : ${fileName}`, 'success');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Erreur création : ${e.message}`);
        }
    }

    private async _handleFileDeletion(fileName: string) {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = vscode.Uri.file(path.join(folder, fileName));
        try {
            await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
            this._showNotification(`🗑 Fichier supprimé : ${fileName}`, 'info');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Erreur suppression : ${e.message}`);
        }
    }

    private async _handleFileAccessRequest(target: string) {
        if (target === 'env' || target === '.env') {
            const file = await this._fileCtxManager.handleAiFileRequest('.env');
            if (file) {
                this._view?.webview.postMessage({ type: 'fileContent', name: file.name, content: file.content });
            }
        } else {
            const uris = await vscode.window.showOpenDialog({ canSelectFiles: true, openLabel: 'Ajouter au contexte' });
            if (uris?.[0]) {
                const content = await vscode.workspace.fs.readFile(uris[0]);
                const name = vscode.workspace.asRelativePath(uris[0]);
                const cf: ContextFile = { name, content: content.toString(), isActive: false };
                this._contextFiles.push(cf);
                this._view?.webview.postMessage({ type: 'fileContent', name, content: content.toString() });
                this._sendTokenBudget();
            }
        }
    }

    private async _handleApplyEdit(code: string, targetFile?: string, autoAccept: boolean = false) {
        let uri: vscode.Uri | undefined;

        if (!targetFile) {
            const fileMatch = /\[FILE:\s*([^\]\n]+)\]/.exec(code);
            if (fileMatch) {
                targetFile = fileMatch[1].trim().split(/[\s(]/)[0];
            }
        }

        if (targetFile) {
            const clean = targetFile.replace(/\[FILE:|\]/g, '').trim().split(/[\s(]/)[0];
            const files = await vscode.workspace.findFiles(`**/${clean}`, '**/node_modules/**', 5);
            if (files.length > 0) {
                uri = files.find(f => f.fsPath.replace(/\\/g, '/').toLowerCase().endsWith(clean.replace(/\\/g, '/').toLowerCase())) || files[0];
            }
            if (!uri) {
                const openDoc = vscode.workspace.textDocuments.find(d =>
                    d.uri.fsPath.replace(/\\/g, '/').toLowerCase().endsWith(clean.replace(/\\/g, '/').toLowerCase())
                );
                if (openDoc) uri = openDoc.uri;
            }
        }

        if (!uri && !targetFile) {
            uri = vscode.window.activeTextEditor?.document.uri;
        }

        if (!uri) {
            const msg = targetFile ? `Fichier "${targetFile}" introuvable ou non ouvert.` : 'Aucun fichier actif pour appliquer le patch.';
            vscode.window.showWarningMessage(msg);
            return;
        }

        const doc = await vscode.workspace.openTextDocument(uri);
        const oldText = doc.getText();
        const hasMarkers = /SEARCH/i.test(code);
        let previewText = code;
        let patchCount = 0;

        if (hasMarkers) {
            const res = applySearchReplace(oldText, code);
            const cleanResult = res.result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            previewText = cleanResult.split('\n').join(eol);
            patchCount = res.patchCount;
            res.errors.forEach(e => vscode.window.showWarningMessage(e));
        }

        const previewUri = vscode.Uri.parse(
            `${AiPreviewProvider.scheme}://patch/${encodeURIComponent(uri.fsPath.replace(/\\/g, '/'))}`
        );
        ChatViewProvider._previewProvider.set(previewUri, previewText);

        if (!autoAccept) {
            const diffTitle = `Review: ${path.basename(uri.fsPath)} (${patchCount > 0 ? `${patchCount} modification(s)` : 'Proposition'})`;
            await vscode.commands.executeCommand('vscode.diff', uri, previewUri, diffTitle);
        }

        if (hasMarkers && patchCount === 0) {
            await vscode.window.showErrorMessage(
                `Le bloc SEARCH/REPLACE n'a pas pu être appliqué à "${path.basename(uri.fsPath)}".`,
                'Fermer'
            );
            ChatViewProvider._previewProvider.delete(previewUri);
            return;
        }

        let result = '✅ Accepter';
        if (!autoAccept) {
            result = await vscode.window.showInformationMessage(
                patchCount > 0
                    ? `Appliquer ${patchCount} modification(s) à "${path.basename(uri.fsPath)}" ?`
                    : `Aucune modification SEARCH/REPLACE trouvée. Remplacer tout le fichier ?`,
                { modal: false },
                '✅ Accepter', '❌ Rejeter'
            ) || '❌ Rejeter';
        }

        ChatViewProvider._previewProvider.delete(previewUri);

        if (result === '✅ Accepter') {
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                doc.lineAt(0).range.start,
                doc.lineAt(doc.lineCount - 1).range.end
            );
            edit.replace(doc.uri, fullRange, previewText);
            await vscode.workspace.applyEdit(edit);
            await doc.save();
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false, preserveFocus: false, viewColumn: vscode.ViewColumn.Active
            });

            const changedRanges = this._highlightChangedLines(editor, oldText, previewText);
            const firstChangedLine = changedRanges.length > 0 ? changedRanges[0].start.line + 1 : 1;

            if (changedRanges.length > 0) {
                editor.selection = new vscode.Selection(changedRanges[0].start, changedRanges[0].start);
                editor.revealRange(changedRanges[0], vscode.TextEditorRevealType.InCenter);
            }

            const fileName = path.basename(uri.fsPath);
            const detail = patchCount > 0 ? `${patchCount} patch(s) • Ligne ${firstChangedLine}` : 'Fichier remplacé';
            this._showNotification(`✅ ${fileName}: ${detail}`, 'success');

            setTimeout(async () => {
                const report = this._lspManager.getSnapshot('active');
                if (report.errorCount > 0) {
                    const ans = await vscode.window.showErrorMessage(
                        `⚠️ Des erreurs ont été détectées après l'application du code à "${fileName}". Voulez-vous que l'IA tente de les corriger ?`,
                        '🤖 Corriger avec l\'IA', '❌ Ignorer'
                    );
                    if (ans === '🤖 Corriger avec l\'IA') {
                        const formatted = this._lspManager.formatForPrompt(report, 5);
                        this.sendMessageFromEditor(`Des erreurs LSP sont apparues dans "${fileName}" après l'application de tes modifications. Voici les erreurs :\n${formatted}\n\nPropose un correctif.`);
                    }
                }
            }, 1000);
        }
    }

    private _highlightChangedLines(editor: vscode.TextEditor, oldText: string, newText: string): vscode.Range[] {
        const oldLines = oldText.split('\n');
        const newLines = newText.split('\n');
        const changedRanges: vscode.Range[] = [];

        for (let i = 0; i < newLines.length; i++) {
            if (newLines[i] !== oldLines[i] && i < editor.document.lineCount) {
                changedRanges.push(editor.document.lineAt(i).range);
            }
        }
        if (changedRanges.length === 0) return changedRanges;

        const dec = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 120, 0.12)',
            isWholeLine: true,
            borderWidth: '0 0 0 3px',
            borderStyle: 'solid',
            borderColor: 'rgba(0, 255, 120, 0.5)'
        });
        editor.setDecorations(dec, changedRanges);
        setTimeout(() => dec.dispose(), 4000);
        return changedRanges;
    }

    private async _handleOpenFile(fp: string) {
        const files = await vscode.workspace.findFiles(`**/${fp}`, '**/node_modules/**', 1);
        if (files[0]) {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(files[0]));
        } else {
            vscode.window.showErrorMessage(`Fichier introuvable : ${fp}`);
        }
    }

    private async _handleRunCommand(cmd: string, isImportant: boolean = false) {
        const perm = this._terminalPermission;
        let shouldRun = false;

        if (perm === 'allow-all') {
            shouldRun = true;
            this._view?.webview.postMessage({ type: 'terminalCommand', cmd, status: 'auto' });
        } else if (perm === 'ask-important' && !isImportant) {
            shouldRun = true;
            this._view?.webview.postMessage({ type: 'terminalCommand', cmd, status: 'auto' });
        } else {
            const answer = await vscode.window.showInformationMessage(
                `${isImportant ? '⚠️ Commande importante' : '💻 Terminal'} — Exécuter : \`${cmd}\``,
                { modal: isImportant },
                '🚀 Exécuter', '❌ Refuser'
            );
            shouldRun = answer === '🚀 Exécuter';
            this._view?.webview.postMessage({ type: 'terminalCommand', cmd, status: shouldRun ? 'accepted' : 'refused' });
        }

        if (shouldRun) {
            const t = vscode.window.activeTerminal ?? vscode.window.createTerminal('Antigravity AI');
            t.show();
            t.sendText(cmd);
        }
    }

    private async _handleGenerateCommitMessage() {
        const diff = await this._fileCtxManager.getStagedDiffForCommit();
        if (!diff) {
            vscode.window.showWarningMessage('Aucun fichier stagé. Faites d\'abord un `git add`.');
            return;
        }
        this.sendMessageFromEditor(
            `Génère un message de commit conventionnel (feat/fix/refactor/chore/docs/test) pour ce diff stagé. Réponds UNIQUEMENT avec le message de commit, sans explications :\n\`\`\`diff\n${diff.substring(0, 6000)}\n\`\`\``
        );
    }

    private async _handleReviewDiff() {
        const diff = await this._fileCtxManager.getGitDiff(false);
        if (!diff) {
            vscode.window.showWarningMessage('Aucune modification Git trouvée.');
            return;
        }
        this.sendMessageFromEditor(
            `Revois ce diff Git. Identifie : bugs potentiels, problèmes de sécurité, mauvaises pratiques, oublis.\n\`\`\`diff\n${diff.substring(0, 8000)}\n\`\`\``
        );
    }

    private async _handleGenerateTests() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Aucun fichier actif.'); return; }
        const fileName = path.basename(editor.document.fileName, path.extname(editor.document.fileName));
        const ext = path.extname(editor.document.fileName);
        this.sendMessageFromEditor(
            `Génère des tests unitaires complets pour le fichier actif. Crée le fichier [CREATE_FILE: ${fileName}.test${ext}] avec des cas de test couvrant les cas normaux, les cas limites, et les cas d'erreur. Utilise le framework de test approprié au projet.`
        );
    }

    private async _handleUpdateProjectSummary() {
        this.sendMessageFromEditor(
            `Génère un résumé technique de ce projet en 200-300 mots. Inclus : technos principales, architecture, rôle des dossiers clés, patterns utilisés. Encadre ta réponse avec [PROJECT_SUMMARY] et [/PROJECT_SUMMARY].`
        );
    }

    private _handleGetLspDiagnostics(scope: 'active' | 'workspace' | 'errors-only') {
        const report = this._lspManager.getSnapshot(scope);
        const formatted = this._lspManager.formatForPrompt(report);
        this._view?.webview.postMessage({
            type: 'lspDiagnostics',
            report: {
                summary: report.summary,
                errorCount: report.errorCount,
                warningCount: report.warningCount,
                affectedFiles: report.affectedFiles,
                formatted,
            }
        });
    }

    private _handleToggleLspWatch() {
        this._lspWatchActive = this._lspManager.toggleWatch((report) => {
            if (!this._view) return;
            if (report.errorCount === 0) return;
            const formatted = this._lspManager.formatForPrompt(report, 10);
            this._view.webview.postMessage({
                type: 'lspAutoReport',
                summary: report.summary,
                errorCount: report.errorCount,
                formatted,
            });
        });
        this._view?.webview.postMessage({ type: 'lspWatchToggled', active: this._lspWatchActive });
        vscode.window.showInformationMessage(
            this._lspWatchActive
                ? "👁 Surveillance LSP activée — l'IA sera notifiée des nouvelles erreurs."
                : '👁 Surveillance LSP désactivée.'
        );
    }

    private async _handleRunAgent(goal: string) {
        if (this._agentRunner.isRunning()) {
            vscode.window.showWarningMessage("Un agent est déjà en cours. Arrêtez-le avant d'en lancer un nouveau.");
            return;
        }

        const model = this._currentModel || 'llama3';
        const url = this._currentUrl || '';

        this._view?.webview.postMessage({ type: 'agentStarted', goal });

        this._agentRunner.onEvent((event) => {
            if (!this._view) return;
            switch (event.type) {
                case 'step_start':
                    this._view.webview.postMessage({
                        type: 'agentStep', status: 'running',
                        stepId: event.step!.id, stepType: event.step!.type,
                        description: event.step!.description, totalSteps: event.session.steps.length,
                    });
                    break;
                case 'step_done':
                    this._view.webview.postMessage({
                        type: 'agentStep', status: 'done',
                        stepId: event.step!.id, stepType: event.step!.type,
                        description: event.step!.description,
                        output: event.step!.output, durationMs: event.step!.durationMs,
                    });
                    break;
                case 'step_failed':
                    this._view.webview.postMessage({
                        type: 'agentStep', status: 'failed',
                        stepId: event.step!.id, stepType: event.step!.type,
                        description: event.step!.description, output: event.step!.output,
                    });
                    break;
                case 'session_done':
                    this._view.webview.postMessage({ type: 'agentDone', summary: event.message, steps: event.session.steps.length });
                    break;
                case 'session_failed':
                    this._view.webview.postMessage({ type: 'agentFailed', reason: event.message });
                    break;
                case 'log':
                    this._view.webview.postMessage({ type: 'agentLog', message: event.message });
                    break;
            }
        });

        const initialContext = [...this._contextFiles];
        const activeFile = await this._fileCtxManager.getActiveFile(8000);
        if (activeFile && !initialContext.find(f => f.name === activeFile.name)) {
            initialContext.unshift(activeFile);
        }

        this._agentSession = await this._agentRunner.run(goal, model, url, initialContext);
    }

    private _getHtmlForWebview(webview: vscode.Webview, showOnboarding: boolean = false): string {
        const bgUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'background.png')
        );
        const cspSource = webview.cspSource;

        const script: string = [
            "const vscode = acquireVsCodeApi();",
            "const chat = document.getElementById('chat');",
            "const promptEl = document.getElementById('prompt');",
            "",
            "var attachedImages = [];",
            "var imagePreviewContainer = null;",
            "",
            "function createImagePreview(base64, mimeType) {",
            "    if (!imagePreviewContainer) {",
            "        imagePreviewContainer = document.createElement('div');",
            "        imagePreviewContainer.id = 'imagePreview';",
            "        imagePreviewContainer.style.cssText = 'display:flex;gap:6px;padding:6px 12px;background:rgba(0,122,204,0.1);border-top:1px solid rgba(0,122,204,0.2);flex-wrap:wrap;align-items:center;';",
            "        var label = document.createElement('span');",
            "        label.style.cssText = 'color:#666;font-size:11px;';",
            "        label.textContent = '📷 Images :';",
            "        imagePreviewContainer.appendChild(label);",
            "        document.querySelector('.input-area').insertBefore(imagePreviewContainer, document.querySelector('.input-row'));",
            "    }",
            "    var wrapper = document.createElement('div');",
            "    wrapper.style.cssText = 'position:relative;width:60px;height:60px;border-radius:6px;overflow:hidden;border:1px solid rgba(0,210,255,0.3);';",
            "    var img = document.createElement('img');",
            "    img.src = 'data:'+mimeType+';base64,'+base64;",
            "    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';",
            "    var removeBtn = document.createElement('button');",
            "    removeBtn.innerHTML = '×';",
            "    removeBtn.style.cssText = 'position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;background:rgba(255,80,80,0.9);color:#fff;border:none;cursor:pointer;font-size:14px;line-height:1;padding:0;';",
            "    removeBtn.onclick = function() {",
            "        var idx = attachedImages.findIndex(function(x) { return x.base64 === base64; });",
            "        if (idx !== -1) attachedImages.splice(idx, 1);",
            "        wrapper.remove();",
            "        if (imagePreviewContainer && imagePreviewContainer.querySelectorAll('img').length === 0) {",
            "            imagePreviewContainer.remove(); imagePreviewContainer = null;",
            "        }",
            "    };",
            "    wrapper.appendChild(img); wrapper.appendChild(removeBtn);",
            "    imagePreviewContainer.appendChild(wrapper);",
            "}",
            "",
            "function addImage(file) {",
            "    var reader = new FileReader();",
            "    reader.onload = function(e) {",
            "        var base64 = e.target.result.split(',')[1];",
            "        var mimeType = file.type;",
            "        attachedImages.push({ base64: base64, mimeType: mimeType });",
            "        createImagePreview(base64, mimeType);",
            "        showNotification('📷 Image ajoutée (' + attachedImages.length + ')', 'info');",
            "    };",
            "    reader.readAsDataURL(file);",
            "}",
            "",
            "promptEl.addEventListener('paste', function(e) {",
            "    var items = e.clipboardData.items;",
            "    for (var i = 0; i < items.length; i++) {",
            "        if (items[i].type.indexOf('image') !== -1) {",
            "            e.preventDefault(); addImage(items[i].getAsFile()); break;",
            "        }",
            "    }",
            "});",
            "",
            "var inputArea = document.querySelector('.input-area');",
            "inputArea.addEventListener('drop', function(e) {",
            "    e.preventDefault(); e.stopPropagation();",
            "    if (e.dataTransfer.files.length > 0) {",
            "        for (var i = 0; i < e.dataTransfer.files.length; i++) {",
            "            if (e.dataTransfer.files[i].type.indexOf('image') !== -1) addImage(e.dataTransfer.files[i]);",
            "        }",
            "    }",
            "});",
            "inputArea.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); inputArea.style.background = 'rgba(0,210,255,0.05)'; });",
            "inputArea.addEventListener('dragleave', function(e) { e.preventDefault(); e.stopPropagation(); inputArea.style.background = ''; });",
            "",
            "const send = document.getElementById('send');",
            "const modelSelect = document.getElementById('modelSelect');",
            "const filesBar = document.getElementById('filesBar');",
            "const tokenBar = document.getElementById('tokenBar');",
            "const terminalLog = document.getElementById('terminalLog');",
            "const scrollBtn = document.getElementById('scrollBtn');",
            "const termPermSelect = document.getElementById('termPermSelect');",
            "let contextFiles = [];",
            "let currentAiMsg = null;",
            "let currentAiText = '';",
            "let thinkModeActive = false;",
            "let userScrolledUp = false;",
            "let _msgCounter = 0;",
            "let _allModels = [];",
            "var notificationContainer = null;",
            "",
            "var PROVIDER_COLORS = { local:'#b19cd9', lmstudio:'#74aa9c', gemini:'#7ab4f5', openai:'#74aa9c', openrouter:'#ffb74d', together:'#4dd0e1', mistral:'#ff8a80', groq:'#ffd700', anthropic:'#cc88ff', 'ollama-cloud':'#00d2ff' };",
            "function providerColor(p) { return PROVIDER_COLORS[p] || '#00d2ff'; }",
            "function providerBanner(p, name) {",
            "    var icons = { local:'⚡', lmstudio:'💻', gemini:'✦', openai:'◈', openrouter:'◎', together:'◉', mistral:'◆', groq:'▸', anthropic:'◈', 'ollama-cloud':'☁️' };",
            "    var labels = { local:'Mode Local', lmstudio:'LM Studio', gemini:'Gemini', openai:'OpenAI', openrouter:'OpenRouter', together:'Together AI', mistral:'Mistral', groq:'Groq', anthropic:'Anthropic', 'ollama-cloud':'Ollama Cloud' };",
            "    return (icons[p]||'☁️')+' <b>'+(labels[p]||'Cloud')+'</b> &mdash; '+name;",
            "}",
            "",
            "var modelComboBox = document.getElementById('modelComboBox');",
            "var modelSearch = document.getElementById('modelSearch');",
            "var modelDropdown = document.getElementById('modelDropdown');",
            "var _comboOpen = false;",
            "var _activeIdx = -1;",
            "var _currentFilter = '';",
            "",
            "function renderDropdown(filter) {",
            "    _currentFilter = filter || '';",
            "    var f = _currentFilter.toLowerCase().trim();",
            "    var filtered = f ? _allModels.filter(function(x) { ",
            "        var n = (x.name || '').toLowerCase();",
            "        var p = (x.provider || '').toLowerCase();",
            "        return n.indexOf(f) !== -1 || p.indexOf(f) !== -1;",
            "    }) : _allModels;",
            "    var listHtml = filtered.length === 0 ? '<div class=\"model-opt-empty\">Aucun résultat</div>'",
            "        : filtered.map(function(x, i) {",
            "            var c = providerColor(x.provider);",
            "            var sel = x.value === modelSelect.value ? ' selected' : '';",
            "            var icons = { local:'⚡', lmstudio:'💻', gemini:'✦', openai:'◈', openrouter:'◎', together:'◉', mistral:'◆', groq:'▸', anthropic:'◈', 'ollama-cloud':'☁️' };",
            "            var icon = icons[x.provider] || '☁️';",
            "            return '<div class=\"model-opt'+sel+'\" data-value=\"'+x.value+'\" data-idx=\"'+i+'\">'+",
            "                '<span class=\"opt-icon\" style=\"color:'+c+'\">'+icon+'</span>'+",
            "                '<span class=\"opt-name\" style=\"color:'+c+'\">'+escapeHtml(x.name)+'</span></div>';",
            "        }).join('');",
            "    modelDropdown.innerHTML = '<div id=\"modelDropdownSearch-wrap\"><input id=\"modelDropdownSearch\" placeholder=\"Rechercher…\" autocomplete=\"off\" spellcheck=\"false\"></div><div id=\"modelDropdownList\">'+listHtml+'</div>';",
            "    var dSearch = document.getElementById('modelDropdownSearch');",
            "    if (dSearch) {",
            "        dSearch.value = _currentFilter;",
            "        dSearch.focus();",
            "        var len = dSearch.value.length;",
            "        dSearch.setSelectionRange(len, len);",
            "        dSearch.addEventListener('input', function() { renderDropdown(dSearch.value); });",
            "        dSearch.addEventListener('keydown', function(e) {",
            "            var list = modelDropdown.querySelectorAll('.model-opt');",
            "            if (e.key === 'ArrowDown') { e.preventDefault(); _activeIdx = Math.min(_activeIdx+1, list.length-1); highlightActive(list); }",
            "            else if (e.key === 'ArrowUp') { e.preventDefault(); _activeIdx = Math.max(_activeIdx-1, 0); highlightActive(list); }",
            "            else if (e.key === 'Enter') { e.preventDefault(); if (_activeIdx >= 0 && list[_activeIdx]) selectModel(list[_activeIdx].getAttribute('data-value')); }",
            "            else if (e.key === 'Escape') { closeCombo(); }",
            "        });",
            "    }",
            "    modelDropdown.querySelectorAll('.model-opt').forEach(function(el) {",
            "        el.addEventListener('mousedown', function(e) { e.preventDefault(); selectModel(el.getAttribute('data-value')); });",
            "    });",
            "}",
            "",
            "function highlightActive(list) {",
            "    list.forEach(function(el, i) { el.classList.toggle('active', i === _activeIdx); });",
            "    if (_activeIdx >= 0 && list[_activeIdx]) list[_activeIdx].scrollIntoView({ block: 'nearest' });",
            "}",
            "",
            "function selectModel(val) {",
            "    var found = _allModels.find(function(x) { return x.value === val; });",
            "    if (!found) return;",
            "    modelSelect.value = val;",
            "    modelSearch.value = found.name;",
            "    modelSearch.style.color = providerColor(found.provider);",
            "    closeCombo(); updateSelectColor();",
            "    vscode.postMessage({ type: 'saveModel', model: val });",
            "}",
            "",
            "function openCombo() { _comboOpen = true; _activeIdx = -1; _currentFilter = ''; modelComboBox.classList.add('open'); modelDropdown.classList.add('open'); renderDropdown(''); }",
            "function closeCombo() {",
            "    _comboOpen = false; modelComboBox.classList.remove('open'); modelDropdown.classList.remove('open');",
            "    var found = _allModels.find(function(x) { return x.value === modelSelect.value; });",
            "    if (found) { modelSearch.value = found.name; modelSearch.style.color = providerColor(found.provider); }",
            "}",
            "",
            "modelComboBox.addEventListener('mousedown', function(e) {",
            "    if (e.target === modelSearch && _comboOpen) return;",
            "    e.preventDefault();",
            "    _comboOpen ? closeCombo() : openCombo();",
            "});",
            "document.addEventListener('mousedown', function(e) {",
            "    if (_comboOpen && !modelComboBox.contains(e.target) && !modelDropdown.contains(e.target)) closeCombo();",
            "});",
            "",
            "function renderModelOptions(models, selectedVal) {",
            "    _allModels = models;",
            "    modelSelect.innerHTML = models.map(function(x) {",
            "        var s = x.value === selectedVal ? ' selected' : '';",
            "        return '<option value=\"'+x.value+'\" data-name=\"'+x.name+'\" data-provider=\"'+(x.provider||'')+'\"'+s+'>'+x.name+'</option>';",
            "    }).join('');",
            "    var found = models.find(function(x) { return x.value === selectedVal; }) || models[0];",
            "    if (found) { modelSearch.value = found.name; modelSearch.style.color = providerColor(found.provider); }",
            "    updateSelectColor();",
            "}",
            "",
            "chat.addEventListener('scroll', function() {",
            "    var threshold = 60;",
            "    var atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < threshold;",
            "    userScrolledUp = !atBottom;",
            "    scrollBtn.style.display = userScrolledUp ? 'flex' : 'none';",
            "});",
            "scrollBtn.onclick = function() { chat.scrollTop = chat.scrollHeight; userScrolledUp = false; scrollBtn.style.display = 'none'; };",
            "function smartScroll() { if (!userScrolledUp) chat.scrollTop = chat.scrollHeight; }",
            "",
            "termPermSelect.onchange = function() { vscode.postMessage({ type: 'setTerminalPermission', value: termPermSelect.value }); };",
            "",
            "promptEl.addEventListener('input', function() { promptEl.style.height = 'auto'; promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px'; });",
            "",
            "function addContextFile(name, content) {",
            "    if (contextFiles.find(function(f) { return f.name === name; })) return;",
            "    contextFiles.push({ name: name, content: content });",
            "    renderFilesBar();",
            "    vscode.postMessage({ type: 'getTokenBudget' });",
            "}",
            "",
            "function renderFilesBar() {",
            "    if (contextFiles.length === 0) { filesBar.style.display = 'none'; return; }",
            "    filesBar.style.display = 'flex';",
            "    filesBar.innerHTML = '<span style=\"color:#666;margin-right:4px;\">📁</span>' +",
            "        contextFiles.map(function(f, i) {",
            "            var tokens = Math.ceil(f.content.length / 4);",
            "            return '<span class=\"file-tag\" data-idx=\"'+i+'\" title=\"'+tokens+' tokens\">'+f.name+' <span style=\"color:#888;font-size:10px\">('+tokens+'t)</span> ×</span>';",
            "        }).join('') +",
            "        '<button class=\"file-tag btn-clear-files\" onclick=\"clearAllFiles()\" style=\"color:#ff6b6b;border-color:#ff6b6b;\">Vider</button>';",
            "    filesBar.querySelectorAll('.file-tag[data-idx]').forEach(function(el) {",
            "        el.onclick = function() {",
            "            var idx = parseInt(el.getAttribute('data-idx'));",
            "            vscode.postMessage({ type: 'removeContextFile', name: contextFiles[idx].name });",
            "            contextFiles.splice(idx, 1); renderFilesBar();",
            "        };",
            "    });",
            "}",
            "",
            "function clearAllFiles() {",
            "    contextFiles.forEach(function(f) { vscode.postMessage({ type: 'removeContextFile', name: f.name }); });",
            "    contextFiles = []; renderFilesBar();",
            "}",
            "",
            "function updateTokenBar(used, max, isCloud) {",
            "    var pct = Math.min(100, Math.round(used / max * 100));",
            "    var color = pct > 85 ? '#ff6b6b' : pct > 60 ? '#ffaa00' : '#00d2ff';",
            "    var icon = isCloud ? '☁️' : '⚡';",
            "    tokenBar.innerHTML = '<span style=\"color:#666;font-size:10px\">' + icon + ' Tokens : ' +",
            "        '<span style=\"color:' + color + '\">' + used + '</span>/' + max +",
            "        ' <div style=\"display:inline-block;width:60px;height:4px;background:#222;border-radius:2px;vertical-align:middle;margin-left:4px;\">'+",
            "        '<div style=\"width:' + pct + '%;height:100%;background:' + color + ';border-radius:2px;\"></div></div>' +",
            "        (pct > 85 ? ' ⚠️ Contexte saturé' : '') + '</span>';",
            "    tokenBar.style.display = 'block';",
            "}",
            "",
            "function revertToMessage(index) {",
            "    if (confirm('Revenir à ce message ?\\nL\\'historique après ce point sera supprimé.')) {",
            "        vscode.postMessage({ type: 'revertTo', index: index });",
            "    }",
            "}",
            "",
            "function addMsg(txt, cls, isHtml, messageIndex) {",
            "    var d = document.createElement('div');",
            "    d.className = 'msg ' + cls;",
            "    var contentWrap = document.createElement('div');",
            "    contentWrap.style.cssText = 'display: flex; flex-direction: column; gap: 6px; width: 100%;';",
            "    var content = document.createElement('div');",
            "    if (isHtml) { content.innerHTML = txt; } else { content.innerText = txt; }",
            "    contentWrap.appendChild(content);",
            "    if (cls === 'user' && messageIndex !== undefined) {",
            "        var revertBtn = document.createElement('button');",
            "        revertBtn.className = 'msg-revert-btn';",
            "        revertBtn.innerHTML = '↩️ Revenir à ce message';",
            "        revertBtn.onclick = function() { revertToMessage(messageIndex); };",
            "        contentWrap.appendChild(revertBtn);",
            "    }",
            "    d.appendChild(contentWrap);",
            "    chat.appendChild(d);",
            "    smartScroll();",
            "    return d;",
            "}",
            "",
            "function addStatusMsg(txt) { showNotification(txt, 'info'); }",
            "",
            "function showNotification(message, type) {",
            "    type = type || 'info';",
            "    if (!notificationContainer) {",
            "        notificationContainer = document.createElement('div');",
            "        notificationContainer.id = 'notificationContainer';",
            "        notificationContainer.style.cssText = 'position:fixed;bottom:80px;right:20px;display:flex;flex-direction:column;gap:8px;z-index:10000;max-width:320px;';",
            "        document.body.appendChild(notificationContainer);",
            "    }",
            "    var colors = {",
            "        info: { bg: 'rgba(0,210,255,0.15)', border: 'rgba(0,210,255,0.4)', color: '#00d2ff', icon: 'ℹ️' },",
            "        success: { bg: 'rgba(0,200,100,0.15)', border: 'rgba(0,200,100,0.4)', color: '#6debb0', icon: '✅' },",
            "        warning: { bg: 'rgba(255,170,0,0.15)', border: 'rgba(255,170,0,0.4)', color: '#ffb74d', icon: '⚠️' },",
            "        error: { bg: 'rgba(255,80,80,0.15)', border: 'rgba(255,80,80,0.4)', color: '#ff8888', icon: '❌' }",
            "    };",
            "    var style = colors[type] || colors.info;",
            "    var notif = document.createElement('div');",
            "    notif.style.cssText = 'background:'+style.bg+';border:1px solid '+style.border+';color:'+style.color+';padding:10px 14px;border-radius:8px;font-size:12px;display:flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);animation:slideIn 0.3s ease;';",
            "    notif.innerHTML = '<span style=\"font-size:16px;flex-shrink:0;\">'+style.icon+'</span><span style=\"flex:1;\">'+escapeHtml(message)+'</span>';",
            "    notificationContainer.appendChild(notif);",
            "    setTimeout(function() {",
            "        notif.style.animation = 'slideOut 0.3s ease';",
            "        setTimeout(function() {",
            "            notif.remove();",
            "            if (notificationContainer && notificationContainer.children.length === 0) { notificationContainer.remove(); notificationContainer = null; }",
            "        }, 300);",
            "    }, 2500);",
            "}",
            "",
            "function escapeHtml(t) { return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }",
            "",
            "window._codeRegistry = [];",
            "function _registerCode(content) { window._codeRegistry.push(content); return window._codeRegistry.length - 1; }",
            "",
            "function renderMarkdown(text) {",
            "    text = text.replace(/\\[PLAN\\]([\\s\\S]*?)\\[\\/PLAN\\]/g, function(_, plan) {",
            "        var idx = _registerCode(plan);",
            "        return '<div class=\"msg plan-msg\"><b>🧠 Plan de l\\'IA :</b><br>' + escapeHtml(plan).replace(/\\n/g,'<br>') + '<div style=\"margin-top:10px;\"><button class=\"btn-cloud\" style=\"background:#cc88ff;color:#000;border:none;\" onclick=\"startPlanImplementation(' + idx + ')\">🚀 Démarrer l\\'implémentation</button></div></div>';",
            "    });",
            "    text = text.replace(/\\[PROJECT_SUMMARY\\][\\s\\S]*?\\[\\/PROJECT_SUMMARY\\]/g, '');",
            "    text = text.replace(/\\[NEED_FILE:[^\\]]+\\]/g, '');",
            "    text = text.replace(/\\[WILL_MODIFY:[^\\]]+\\]/g, '');",
            "    text = text.replace(/\\[FILE:\\s*([^ \\]\\n]+)(?: [^\\]\\n]+)?\\]\\s*```(\\w+)?\\n([\\s\\S]*?)```/g, function(_, fname, lang, code) {",
            "        var idx = _registerCode(code); var fidx = _registerCode(fname);",
            "        return '<div class=\"code-block patch\"><div class=\"code-header\"><span>📄 '+escapeHtml(fname)+'</span><button onclick=\"applyFilePatch('+idx+','+fidx+')\">✅ Appliquer</button></div><div class=\"code-content\">'+escapeHtml(code)+'</div></div>';",
            "    });",
            "    text = text.replace(/```(\\w+)?\\n([\\s\\S]*?)```/g, function(_, lang, code) {",
            "        var idx = _registerCode(code);",
            "        var isPatch = /SEARCH/i.test(code);",
            "        var cls = isPatch ? 'patch' : '';",
            "        var btns = '<button onclick=\"applyCode('+idx+')\">✅ Appliquer</button>';",
            "        if (isPatch) btns += ' <button onclick=\"copyCode('+idx+')\">📋 Copier</button>';",
            "        else btns = '<button onclick=\"copyCode('+idx+')\">📋 Copier</button> ' + btns;",
            "        return '<div class=\"code-block '+cls+'\"><div class=\"code-header\"><span>'+(lang||'code')+'</span>'+btns+'</div><div class=\"code-content\">'+escapeHtml(code)+'</div></div>';",
            "    });",
            "    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');",
            "    text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');",
            "    text = text.replace(/\\*([^*]+)\\*/g, '<i>$1</i>');",
            "    var paras = text.split('\\n\\n');",
            "    return paras.map(function(p) {",
            "        p = p.trim(); if (!p) return '';",
            "        if (p.startsWith('<div')) return p;",
            "        p = p.replace(/\\n/g, '<br>');",
            "        return '<p>' + p + '</p>';",
            "    }).join('');",
            "}",
            "",
            "function applyCode(idx) { vscode.postMessage({ type: 'applyToActiveFile', value: window._codeRegistry[idx] }); }",
            "function applyFilePatch(codeIdx, fileIdx) { vscode.postMessage({ type: 'applyToActiveFile', value: window._codeRegistry[codeIdx], targetFile: window._codeRegistry[fileIdx] }); }",
            "function copyCode(idx) { navigator.clipboard.writeText(window._codeRegistry[idx]); }",
            "function startPlanImplementation(idx) { vscode.postMessage({ type: 'injectMessage', value: 'Démarre l\\'implémentation du plan :\\n' + window._codeRegistry[idx] }); }",
            "",
            "var isGenerating = false;",
            "function showStopButton() { isGenerating = true; send.style.display = 'none'; document.getElementById('stop').style.display = 'block'; }",
            "function hideStopButton() { isGenerating = false; send.style.display = 'block'; document.getElementById('stop').style.display = 'none'; }",
            "",
            "function sendMessage() {",
            "    var val = promptEl.value.trim();",
            "    if (!val || isGenerating) return;",
            "    var msgIdx = _msgCounter; _msgCounter += 2;",
            "    addMsg(val, 'user', false, msgIdx);",
            "    showStopButton();",
            "    var selectedOpt = modelSelect.options[modelSelect.selectedIndex];",
            "    var modelVal = modelSelect.value;",
            "    var modelUrl = selectedOpt ? (selectedOpt.getAttribute('data-url') || '') : '';",
            "    vscode.postMessage({ type: 'sendMessage', value: val, model: modelVal, url: modelUrl, contextFiles: contextFiles, thinkMode: thinkModeActive, images: attachedImages });",
            "    promptEl.value = ''; promptEl.style.height = 'auto';",
            "    attachedImages = [];",
            "    if (imagePreviewContainer) { imagePreviewContainer.remove(); imagePreviewContainer = null; }",
            "}",
            "",
            "send.onclick = sendMessage;",
            "document.getElementById('stop').onclick = function() { vscode.postMessage({ type: 'stopGeneration' }); hideStopButton(); };",
            "promptEl.addEventListener('keydown', function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });",
            "",
            "document.getElementById('btnAddFile').onclick = function() { vscode.postMessage({ type: 'requestFileAccess', target: 'picker' }); };",
            "document.getElementById('btnRelatedFiles').onclick = function() { vscode.postMessage({ type: 'addRelatedFiles' }); };",
            "document.getElementById('btnThink').onclick = function() { vscode.postMessage({ type: 'toggleThinkMode' }); };",
            "document.getElementById('btnCloud').onclick = function() { vscode.postMessage({ type: 'openCloudConnect' }); };",
            "document.getElementById('btnClearHistory').onclick = function() { if (confirm('Effacer l\\'historique ?')) { vscode.postMessage({ type: 'clearHistory' }); chat.innerHTML = ''; } };",
            "document.getElementById('btnReset').onclick = function() { vscode.postMessage({ type: 'resetChat' }); };",
            "document.getElementById('btnLsp').onclick = function() { vscode.postMessage({ type: 'getLspDiagnostics', scope: 'workspace' }); };",
            "var _lspWatchActive = false;",
            "document.getElementById('btnLspWatch').onclick = function() { vscode.postMessage({ type: 'toggleLspWatch' }); };",
            "document.getElementById('btnAgent').onclick = function() {",
            "    if (_agentRunning) { vscode.postMessage({ type: 'stopAgent' }); return; }",
            "    var goal = promptEl.value.trim();",
            "    if (!goal) { goal = window.prompt('Objectif de l\\'agent :'); }",
            "    if (!goal) return;",
            "    promptEl.value = '';",
            "    vscode.postMessage({ type: 'runAgent', goal: goal });",
            "};",
            "function stopAgent() { vscode.postMessage({ type: 'stopAgent' }); }",
            "function sendLspToAi() {",
            "    if (!_currentLspFormatted) return;",
            "    promptEl.value = 'Analyse ces erreurs LSP et propose les correctifs :\\n' + _currentLspFormatted;",
            "    document.getElementById('lspPanel').style.display = 'none';",
            "    promptEl.focus();",
            "}",
            "document.getElementById('btnGitReview').onclick = function() { vscode.postMessage({ type: 'reviewDiff' }); };",
            "document.getElementById('btnCommit').onclick = function() { vscode.postMessage({ type: 'generateCommitMessage' }); };",
            "document.getElementById('btnTests').onclick = function() { vscode.postMessage({ type: 'generateTests' }); };",
            "document.getElementById('btnError').onclick = function() {",
            "    var err = promptEl.value.trim();",
            "    if (!err) { var inp = window.prompt('Coller votre erreur / stack trace :'); if (!inp) return; err = inp; }",
            "    vscode.postMessage({ type: 'analyzeError', value: err }); promptEl.value = '';",
            "};",
            "",
            "function updateSelectColor() {",
            "    var val = modelSelect.value;",
            "    var found = _allModels.find(function(x) { return x.value === val; });",
            "    var provider = found ? (found.provider || 'ollama-cloud') : '';",
            "    var warn = document.getElementById('localWarn');",
            "    if (!val || !found) { warn.style.cssText = ''; warn.className = 'offline'; warn.innerHTML = '⚠️ Ollama hors ligne'; warn.style.display = 'block'; }",
            "    else { warn.className = provider; warn.innerHTML = providerBanner(provider, found.name); warn.style.display = 'block'; }",
            "    vscode.postMessage({ type: 'getTokenBudget' });",
            "}",
            "modelSelect.onchange = function() { updateSelectColor(); vscode.postMessage({ type: 'saveModel', model: modelSelect.value }); };",
            "",
            "window.addEventListener('message', function(e) {",
            "    var m = e.data;",
            "    if (m.type === 'setModels') {",
            "        if (m.models && m.models.length > 0) { _allModels = m.models; renderModelOptions(m.models, m.selected); }",
            "        else { _allModels = []; modelSelect.innerHTML = '<option value=\"\" style=\"color:#ff6b6b\">⚠️ Aucun modèle — lancez Ollama ou LM Studio</option>'; updateSelectColor(); }",
            "    }",
            "    if (m.type === 'startResponse') {",
            "        showStopButton();",
            "        currentAiMsg = document.createElement('div'); currentAiMsg.className = 'msg ai';",
            "        currentAiMsg.innerHTML = '<div class=\"thinking\"><span></span><span></span><span></span></div>';",
            "        chat.appendChild(currentAiMsg); chat.scrollTop = chat.scrollHeight; currentAiText = '';",
            "    }",
            "    if (m.type === 'partialResponse') {",
            "        if (!currentAiMsg) { currentAiMsg = addMsg('', 'ai', true); }",
            "        currentAiText += m.value; currentAiMsg.innerHTML = renderMarkdown(currentAiText); smartScroll();",
            "    }",
            "    if (m.type === 'endResponse') {",
            "        hideStopButton();",
            "        var finalText = m.value || currentAiText;",
            "        if (currentAiMsg) { currentAiMsg.innerHTML = renderMarkdown(finalText); }",
            "        else { addMsg(renderMarkdown(finalText), 'ai', true); }",
            "        currentAiMsg = null; currentAiText = '';",
            "    }",
            "    if (m.type === 'fileContent') { addContextFile(m.name, m.content); }",
            "    if (m.type === 'injectMessage') {",
            "        promptEl.value = m.value; promptEl.style.height = 'auto';",
            "        promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px'; promptEl.focus();",
            "    }",
            "    if (m.type === 'restoreHistory' && m.history) {",
            "        chat.innerHTML = ''; _msgCounter = 0;",
            "        m.history.forEach(function(msg, index) {",
            "            if (msg.role === 'user') { addMsg(msg.value, 'user', false, index); }",
            "            else { addMsg(renderMarkdown(msg.value), 'ai', true); }",
            "        });",
            "        _msgCounter = m.history.length;",
            "    }",
            "    if (m.type === 'statusMessage') { addStatusMsg(m.value); }",
            "    if (m.type === 'thinkModeChanged') {",
            "        thinkModeActive = m.active;",
            "        var btn = document.getElementById('btnThink');",
            "        btn.style.background = m.active ? 'rgba(160,0,255,0.25)' : '';",
            "        btn.style.borderColor = m.active ? '#a000ff' : '';",
            "        btn.style.color = m.active ? '#cc88ff' : '';",
            "    }",
            "    if (m.type === 'tokenBudget') { updateTokenBar(m.used, m.max, m.isCloud); }",
            "    if (m.type === 'notification') { showNotification(m.message, m.notificationType); }",
            "    if (m.type === 'terminalCommand') {",
            "        terminalLog.style.display = 'block';",
            "        var line = document.createElement('div'); line.className = 'cmd-line';",
            "        var badge = m.status === 'refused' ? 'refused' : (m.status === 'auto' ? 'auto' : 'accepted');",
            "        var label = m.status === 'refused' ? 'refusé' : (m.status === 'auto' ? 'auto' : 'ok');",
            "        line.innerHTML = '<span class=\"cmd-badge '+badge+'\">'+label+'</span><span class=\"cmd-text\">$ '+escapeHtml(m.cmd)+'</span>';",
            "        terminalLog.appendChild(line); terminalLog.scrollTop = terminalLog.scrollHeight;",
            "        if (terminalLog.children.length > 20) terminalLog.removeChild(terminalLog.firstChild);",
            "    }",
            "    if (m.type === 'setTerminalPermission') { termPermSelect.value = m.value || 'ask-all'; }",
            "    if (m.type === 'lspDiagnostics') {",
            "        var panel = document.getElementById('lspPanel');",
            "        var content = document.getElementById('lspContent');",
            "        var summary = document.getElementById('lspSummary');",
            "        _currentLspFormatted = m.report.formatted;",
            "        summary.innerHTML = (m.report.errorCount > 0 ? '🔴' : '🟡') + ' ' + escapeHtml(m.report.summary);",
            "        content.textContent = m.report.formatted; panel.style.display = 'block';",
            "    }",
            "    if (m.type === 'lspAutoReport') { showNotification('🔴 ' + m.summary, 'error'); _currentLspFormatted = m.formatted; }",
            "    if (m.type === 'lspWatchToggled') {",
            "        _lspWatchActive = m.active;",
            "        var btn = document.getElementById('btnLspWatch');",
            "        btn.style.background = m.active ? 'rgba(255,80,80,0.2)' : '';",
            "        btn.style.borderColor = m.active ? 'rgba(255,80,80,0.5)' : '';",
            "        btn.style.color = m.active ? '#ff8888' : '';",
            "    }",
            "    if (m.type === 'agentStarted') {",
            "        _agentRunning = true;",
            "        var panel = document.getElementById('agentPanel');",
            "        var steps = document.getElementById('agentSteps');",
            "        var label = document.getElementById('agentGoalLabel');",
            "        label.textContent = '🤖 ' + m.goal; steps.innerHTML = ''; panel.style.display = 'block';",
            "        var btn = document.getElementById('btnAgent');",
            "        btn.textContent = '⏹ Stop'; btn.style.background = 'rgba(255,80,80,0.2)';",
            "        btn.style.borderColor = 'rgba(255,80,80,0.5)'; btn.style.color = '#ff8888';",
            "    }",
            "    if (m.type === 'agentStep') {",
            "        var stepIcons = { think:'💭', read_file:'📖', write_file:'✏️', run_command:'💻', fix_diagnostics:'🔍', done:'✅', error:'❌' };",
            "        var icon = stepIcons[m.stepType] || '▸';",
            "        var existing = document.getElementById('agent-step-'+m.stepId);",
            "        if (!existing) { existing = document.createElement('div'); existing.id = 'agent-step-'+m.stepId; existing.className = 'agent-step'; document.getElementById('agentSteps').appendChild(existing); }",
            "        var dur = m.durationMs ? '<span class=\"agent-step-dur\">('+Math.round(m.durationMs/100)/10+'s)</span>' : '';",
            "        var out = m.output ? '<div class=\"agent-step-out\">'+escapeHtml(m.output.substring(0,120))+'</div>' : '';",
            "        existing.className = 'agent-step step-'+m.status;",
            "        existing.innerHTML = '<div class=\"agent-step-icon\">'+icon+'</div><div class=\"agent-step-body\"><div class=\"agent-step-desc\">'+escapeHtml(m.description)+dur+'</div>'+out+'</div>';",
            "        document.getElementById('agentSteps').scrollTop = 9999;",
            "    }",
            "    if (m.type === 'agentDone' || m.type === 'agentStopped' || m.type === 'agentFailed') {",
            "        _agentRunning = false;",
            "        var btn = document.getElementById('btnAgent');",
            "        btn.textContent = '🤖 Agent'; btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';",
            "        showNotification((m.type === 'agentDone' ? '✅' : '❌') + ' Agent terminé — ' + (m.summary || m.reason || 'arrêté'), m.type === 'agentDone' ? 'success' : 'error');",
            "    }",
            "    if (m.type === 'agentLog') { showNotification(m.message, 'info'); }",
            "    if (m.type === 'showPlan') {",
            "        var planEl = document.createElement('div'); planEl.className = 'msg plan-msg';",
            "        planEl.innerHTML = '<b>🧠 Plan de l\\'IA :</b><br>' + escapeHtml(m.plan).replace(/\\n/g,'<br>');",
            "        chat.appendChild(planEl); chat.scrollTop = chat.scrollHeight;",
            "    }",
            "    if (m.type === 'updateContextFiles') {",
            "        m.files.forEach(function(f) {",
            "            if (!contextFiles.find(function(cf) { return cf.name === f.name; })) {",
            "                contextFiles.push({ name: f.name, content: '...', tokens: f.tokens });",
            "            }",
            "        });",
            "        renderFilesBar();",
            "    }",
            "    if (m.type === 'reset') {",
            "        chat.innerHTML = ''; _msgCounter = 0;",
            "        contextFiles = []; renderFilesBar();",
            "        showNotification(m.templateName ? '🔄 Chat réinitialisé avec \"' + m.templateName + '\"' : '🔄 Nouveau chat créé', 'success');",
            "    }",
            "});",
            "",
            "vscode.postMessage({ type: 'getModels' });",
            "vscode.postMessage({ type: 'restoreHistory' });",
            "vscode.postMessage({ type: 'getTokenBudget' });",
            "vscode.postMessage({ type: 'getTerminalPermission' });",
            "var _currentLspFormatted = '';",
            "var _agentRunning = false;",
            `var _showOnboarding = ${showOnboarding};`,
            "",
            "// ===== ONBOARDING FUNCTIONS (need vscode in scope) =====",
            "var _obCur = 1;",
            "var _obTitles = {",
            "    1: ['Mission Briefing', 'Configure your AI co-pilot in 60 seconds.'],",
            "    2: ['Local AI Setup', 'Private, offline, completely free.'],",
            "    3: ['Cloud Boost', 'Optional — supercharge with Gemini\\'s free tier.'],",
            "    4: ['The Cockpit', 'A quick tour before you launch.'],",
            "    5: ['All Systems Go', 'Your AI-powered IDE is ready.']",
            "};",
            "function obGo(step) {",
            "    var prev = document.getElementById('obStep' + _obCur);",
            "    if (prev) prev.classList.remove('active');",
            "    _obCur = step;",
            "    var next = document.getElementById('obStep' + step);",
            "    if (next) next.classList.add('active');",
            "    var t = _obTitles[step] || ['', ''];",
            "    var el = document.getElementById('obMainTitle');",
            "    var sub = document.getElementById('obMainSub');",
            "    var lbl = document.getElementById('obStepLabel');",
            "    if (el) { el.style.opacity='0'; setTimeout(function(){ el.textContent=t[0]; el.style.opacity='1'; el.style.transition='opacity 0.25s'; },120); }",
            "    if (sub) { sub.style.opacity='0'; setTimeout(function(){ sub.textContent=t[1]; sub.style.opacity='1'; sub.style.transition='opacity 0.25s'; },180); }",
            "    if (lbl) lbl.textContent = 'step ' + step + ' / 5';",
            "    for (var i=1; i<=5; i++) {",
            "        var seg = document.getElementById('obSeg'+i);",
            "        if (seg) seg.className = 'ob-seg' + (i<step?' done':i===step?' active':'');",
            "    }",
            "}",
            "function obSkip() {",
            "    var o = document.getElementById('obOverlay');",
            "    if (!o) return;",
            "    o.style.transition = 'opacity 0.4s';",
            "    o.style.opacity = '0';",
            "    setTimeout(function(){ o.style.display='none'; o.style.opacity='1'; o.style.transition=''; }, 400);",
            "}",
            "function obOpen() {",
            "    var o = document.getElementById('obOverlay');",
            "    if (!o) return;",
            "    _obCur = 1;",
            "    obGo(1);",
            "    o.style.transition = '';",
            "    o.style.opacity = '0';",
            "    o.style.display = 'flex';",
            "    setTimeout(function(){ o.style.transition='opacity 0.4s'; o.style.opacity='1'; }, 20);",
            "}",
            "function obFinish() {",
            "    var o = document.getElementById('obOverlay');",
            "    if (o) { o.style.transition='opacity 0.4s'; o.style.opacity='0'; setTimeout(function(){ o.style.display='none'; },400); }",
            "    vscode.postMessage({ type: 'finishOnboarding' });",
            "    setTimeout(function(){ vscode.postMessage({ type: 'getModels' }); }, 800);",
            "}",
            "function obTestOllama() {",
            "    var st = document.getElementById('obOllamaStatus');",
            "    var tx = document.getElementById('obOllamaStatusText');",
            "    if (!st||!tx) return;",
            "    st.className='ob-status testing'; tx.textContent='Testing localhost:11434…';",
            "    fetch('http://localhost:11434/api/tags',{signal:AbortSignal.timeout(4000)})",
            "        .then(function(r){ if(r.ok) return r.json(); throw new Error('HTTP '+r.status); })",
            "        .then(function(d){ var n=(d.models||[]).length; st.className='ob-status ok'; tx.textContent='✓ Ollama connected — '+n+' model'+(n!==1?'s':'')+' available'; setTimeout(function(){ obGo(3); },1200); })",
            "        .catch(function(){ st.className='ob-status fail'; tx.textContent='✗ Not found — is Ollama running?'; });",
            "}",
            "function obTestLmStudio() {",
            "    var st = document.getElementById('obLmStatus');",
            "    var tx = document.getElementById('obLmStatusText');",
            "    if (!st||!tx) return;",
            "    st.className='ob-status testing'; tx.textContent='Testing localhost:1234…';",
            "    fetch('http://localhost:1234/v1/models',{signal:AbortSignal.timeout(4000)})",
            "        .then(function(r){ if(r.ok) return r.json(); throw new Error('HTTP '+r.status); })",
            "        .then(function(d){ var n=(d.data||[]).length; st.className='ob-status ok'; tx.textContent='✓ LM Studio connected — '+n+' model'+(n!==1?'s':'')+' loaded'; setTimeout(function(){ obGo(3); },1200); })",
            "        .catch(function(){ st.className='ob-status fail'; tx.textContent='✗ Not found — start the Local Server in LM Studio'; });",
            "}",
            "function obSaveGemini() {",
            "    var inp = document.getElementById('obGeminiKey');",
            "    var key = inp ? inp.value.trim() : '';",
            "    var st = document.getElementById('obGeminiStatus');",
            "    var tx = document.getElementById('obGeminiStatusText');",
            "    if (!key || key.length < 10) { if(st) st.className='ob-status fail'; if(tx) tx.textContent='✗ Key looks too short — double-check it.'; return; }",
            "    if(st) st.className='ob-status testing'; if(tx) tx.textContent='Validating key…';",
            "    fetch('https://generativelanguage.googleapis.com/v1beta/models?key='+key,{signal:AbortSignal.timeout(5000)})",
            "        .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })",
            "        .then(function(){ if(st) st.className='ob-status ok'; if(tx) tx.textContent='✓ Key valid — Gemini connected!'; vscode.postMessage({type:'setupGeminiKey',key:key}); setTimeout(function(){ obGo(4); },1000); })",
            "        .catch(function(){ if(st) st.className='ob-status ok'; if(tx) tx.textContent='✓ Key saved (connection test skipped)'; vscode.postMessage({type:'setupGeminiKey',key:key}); setTimeout(function(){ obGo(4); },1000); });",
            "}",
            "if (_showOnboarding) { document.getElementById('obOverlay').style.display = 'flex'; }",
            "var _btnOb = document.getElementById('btnOnboarding'); if (_btnOb) { _btnOb.onclick = function() { obOpen(); }; }"
        ].join("\n");

        return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline';">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&family=Fira+Code&display=swap');
        * { box-sizing: border-box; }
        body { font-family: 'Inter', sans-serif; background: #000; color: #e0e0e0; margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; font-size: 13px; }
        .space-bg { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: url('${bgUri}') no-repeat center center; background-size: cover; filter: brightness(0.35); z-index: -1; }
        .header { padding: 8px 12px; background: rgba(5,5,15,0.92); display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(0,210,255,0.2); flex-shrink: 0; }
        .header-brand { font-weight: 900; letter-spacing: 2px; font-size: 14px; color: #fff; text-shadow: 0 0 10px rgba(0,210,255,0.5); }
        .header-controls { display: flex; gap: 6px; align-items: center; }
        .btn-cloud { background: none; border: 1px solid #00d2ff; color: #00d2ff; padding: 4px 10px; font-size: 11px; border-radius: 20px; cursor: pointer; font-weight: 700; transition: all 0.2s; }
        .btn-cloud:hover { background: rgba(0,210,255,0.15); }
        select#modelSelect { display: none; }
        #modelComboWrap { position: relative; min-width: 155px; max-width: 180px; }
        #modelComboBox { display: flex; align-items: center; background: #0a0a1a; border: 1px solid #333; border-radius: 6px; padding: 0 8px; gap: 4px; cursor: pointer; transition: border-color 0.2s; height: 28px; }
        #modelComboBox:focus-within, #modelComboBox.open { border-color: rgba(0,210,255,0.5); box-shadow: 0 0 0 2px rgba(0,210,255,0.08); }
        #modelSearch { flex: 1; background: none; color: #e0e0e0; border: none; outline: none; font-size: 11px; font-family: 'Inter', sans-serif; cursor: pointer; min-width: 0; width: 100%; }
        #modelSearch::placeholder { color: #555; }
        #modelComboArrow { color: #555; font-size: 10px; flex-shrink: 0; pointer-events: none; transition: transform 0.2s; }
        #modelComboBox.open #modelComboArrow { transform: rotate(180deg); color: #00d2ff; }
        #modelDropdown { display: none; position: absolute; top: calc(100% + 4px); right: 0; min-width: 220px; max-width: 300px; background: #0d0d1e; border: 1px solid rgba(0,210,255,0.25); border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); z-index: 9999; overflow: hidden; flex-direction: column; }
        #modelDropdown.open { display: flex; }
        #modelDropdownSearch-wrap { padding: 6px 8px; border-bottom: 1px solid #1e1e30; background: rgba(0,0,0,0.3); }
        #modelDropdownSearch { background: rgba(255,255,255,0.06); border: 1px solid #2a2a3a; border-radius: 5px; color: #e0e0e0; padding: 5px 9px; font-size: 11px; font-family: 'Inter', sans-serif; outline: none; width: 100%; transition: border-color 0.2s; }
        #modelDropdownSearch:focus { border-color: rgba(0,210,255,0.4); }
        #modelDropdownList { overflow-y: auto; max-height: 220px; }
        #modelDropdownList::-webkit-scrollbar { width: 4px; }
        #modelDropdownList::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }
        .model-opt { padding: 7px 12px; font-size: 11px; cursor: pointer; color: #ccc; display: flex; align-items: center; gap: 6px; transition: background 0.12s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .model-opt:hover, .model-opt.active { background: rgba(0,210,255,0.1); color: #fff; }
        .model-opt.selected { background: rgba(0,210,255,0.15); color: #00d2ff; font-weight: 600; }
        .model-opt .opt-icon { flex-shrink: 0; width: 14px; text-align: center; }
        .model-opt .opt-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
        .model-opt-empty { padding: 10px 12px; font-size: 11px; color: #555; text-align: center; }
        #localWarn.gemini    { background: rgba(66,133,244,0.1);  color: #7ab4f5;  border-color: rgba(66,133,244,0.3); }
        #localWarn.openai    { background: rgba(116,170,156,0.1); color: #74aa9c;  border-color: rgba(116,170,156,0.3); }
        #localWarn.openrouter{ background: rgba(255,152,0,0.1);   color: #ffb74d;  border-color: rgba(255,152,0,0.3); }
        #localWarn.mistral   { background: rgba(255,107,107,0.1); color: #ff8a80;  border-color: rgba(255,107,107,0.3); }
        #localWarn.groq      { background: rgba(255,215,0,0.1);   color: #ffd700;  border-color: rgba(255,215,0,0.3); }
        #localWarn.together  { background: rgba(0,188,212,0.1);   color: #4dd0e1;  border-color: rgba(0,188,212,0.3); }
        #localWarn.anthropic { background: rgba(204,136,255,0.1); color: #cc88ff;  border-color: rgba(204,136,255,0.3); }
        #localWarn { display: none; padding: 4px 12px; font-size: 11px; text-align: center; border-bottom: 1px solid; flex-shrink: 0; }
        #localWarn.local { background: rgba(177,156,217,0.12); color: #c9a9f5; border-color: rgba(177,156,217,0.25); }
        #localWarn.cloud { background: rgba(0,210,255,0.08); color: #00d2ff; border-color: rgba(0,210,255,0.2); }
        #localWarn.offline { background: rgba(255,80,80,0.1); color: #ff6b6b; border-color: rgba(255,80,80,0.25); }
        #tokenBar { display: none; padding: 3px 12px; background: rgba(0,0,0,0.4); border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; }
        #filesBar { display: none; background: rgba(0,122,204,0.1); padding: 5px 12px; font-size: 11px; color: #aaa; border-bottom: 1px solid rgba(0,122,204,0.2); flex-direction: row; gap: 6px; align-items: center; overflow-x: auto; white-space: nowrap; flex-shrink: 0; }
        #filesBar .file-tag { background: rgba(0,122,204,0.25); color: #6cb6ff; border: 1px solid rgba(0,122,204,0.4); padding: 2px 8px; border-radius: 10px; cursor: pointer; font-size: 11px; transition: background 0.2s; }
        #filesBar .file-tag:hover { background: rgba(0,122,204,0.5); }
        #chat { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
        #chat::-webkit-scrollbar { width: 4px; } #chat::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        .msg { padding: 10px 14px; border-radius: 12px; max-width: 95%; line-height: 1.6; word-break: break-word; }
        .user { background: rgba(0,80,200,0.35); align-self: flex-end; border: 1px solid rgba(0,120,255,0.3); border-bottom-right-radius: 2px; white-space: pre-wrap; }
        .ai { background: rgba(15,15,30,0.9); align-self: flex-start; width: 100%; border: 1px solid rgba(255,255,255,0.07); border-bottom-left-radius: 2px; }
        .ai p { margin: 6px 0; }
        .ai b { color: #fff; }
        .ai code { background: #1a1a2e; color: #00d2ff; padding: 2px 5px; border-radius: 4px; font-family: 'Fira Code', monospace; font-size: 11px; }
        .plan-msg { background: rgba(120,0,255,0.12); border: 1px solid rgba(160,0,255,0.3); border-radius: 10px; padding: 10px 14px; align-self: flex-start; width: 100%; font-size: 12px; color: #cc88ff; }
        .code-block { background: #0d0d1a; border: 1px solid #2a2a3a; border-radius: 8px; margin: 10px 0; overflow: hidden; }
        .code-header { background: #141424; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #888; border-bottom: 1px solid #2a2a3a; gap: 6px; }
        .code-header span { flex: 1; }
        .code-header button { padding: 4px 10px; font-size: 11px; background: #007acc; border-radius: 12px; cursor: pointer; border: none; color: #fff; font-weight: 700; transition: background 0.2s; white-space: nowrap; }
        .code-header button:hover { background: #0090e0; }
        .code-content { padding: 12px; font-family: 'Fira Code', monospace; font-size: 12px; color: #cdd; white-space: pre-wrap; overflow-x: auto; max-height: 400px; overflow-y: auto; }
        .code-block.patch { border-color: rgba(0,122,204,0.5); }
        .code-block.patch .code-header { background: rgba(0,60,120,0.4); color: #6cb6ff; border-color: rgba(0,122,204,0.3); }
        .input-area { padding: 10px 12px; background: rgba(5,5,15,0.92); display: flex; flex-direction: column; gap: 8px; border-top: 1px solid rgba(0,210,255,0.15); flex-shrink: 0; }
        .input-row { display: flex; gap: 8px; align-items: flex-end; }
        #prompt { flex: 1; background: rgba(20,20,40,0.8); color: #e0e0e0; border: 1px solid #333; padding: 10px 14px; border-radius: 22px; outline: none; font-family: 'Inter', sans-serif; font-size: 13px; resize: none; min-height: 40px; max-height: 120px; line-height: 1.4; transition: border-color 0.2s; }
        #prompt:focus { border-color: rgba(0,210,255,0.5); }
        #send { background: #007acc; color: #fff; border: none; padding: 10px 18px; border-radius: 22px; cursor: pointer; font-weight: 700; font-size: 13px; white-space: nowrap; transition: background 0.2s; }
        #send:hover { background: #0090e0; }
        #stop { background: #ff6b6b; color: #fff; border: none; padding: 10px 18px; border-radius: 22px; cursor: pointer; font-weight: 700; font-size: 13px; white-space: nowrap; font-family: 'Inter', sans-serif; }
        #stop:hover { background: #ff5252; }
        .msg-revert-btn { align-self: flex-start; background: rgba(100,100,255,0.08); border: 1px solid rgba(100,100,255,0.25); color: #7a8fff; padding: 4px 10px; border-radius: 10px; font-size: 11px; cursor: pointer; transition: all 0.2s; margin-top: 4px; font-family: 'Inter', sans-serif; font-weight: 500; }
        .msg-revert-btn:hover { background: rgba(100,100,255,0.15); border-color: rgba(100,100,255,0.4); color: #9bb0ff; }
        .input-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .btn-action { background: rgba(255,255,255,0.06); color: #aaa; border: 1px solid #333; padding: 4px 10px; border-radius: 12px; cursor: pointer; font-size: 11px; transition: all 0.2s; white-space: nowrap; }
        .btn-action:hover { background: rgba(255,255,255,0.12); color: #fff; }
        .thinking { display: flex; gap: 4px; align-items: center; padding: 6px 0; }
        .thinking span { width: 6px; height: 6px; background: #00d2ff; border-radius: 50%; animation: bounce 1.2s infinite; }
        .thinking span:nth-child(2) { animation-delay: 0.2s; } .thinking span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-8px)} }
        button { font-family: 'Inter', sans-serif; }
        @keyframes slideIn { from { transform: translateX(400px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(400px); opacity: 0; } }
        #terminalLog { display: none; background: rgba(0,0,0,0.5); border-top: 1px solid rgba(0,210,255,0.1); padding: 4px 12px; font-family: 'Fira Code', monospace; font-size: 11px; color: #888; max-height: 80px; overflow-y: auto; flex-shrink: 0; }
        #terminalLog .cmd-line { display: flex; gap: 6px; align-items: center; padding: 2px 0; }
        #terminalLog .cmd-badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; flex-shrink: 0; }
        #terminalLog .cmd-badge.accepted { background: rgba(0,200,100,0.2); color: #6debb0; border: 1px solid rgba(0,200,100,0.3); }
        #terminalLog .cmd-badge.refused { background: rgba(255,80,80,0.15); color: #ff8888; border: 1px solid rgba(255,80,80,0.3); }
        #terminalLog .cmd-badge.auto { background: rgba(0,210,255,0.15); color: #00d2ff; border: 1px solid rgba(0,210,255,0.25); }
        #terminalLog .cmd-text { color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #termPermSelect { background: rgba(20,20,40,0.8); color: #aaa; border: 1px solid #333; border-radius: 12px; padding: 3px 8px; font-size: 10px; cursor: pointer; outline: none; font-family: 'Inter', sans-serif; }
        #agentPanel { background: rgba(0,0,0,0.55); border-top: 1px solid rgba(120,0,255,0.3); padding: 6px 10px; font-size: 11px; max-height: 160px; overflow-y: auto; flex-shrink: 0; }
        #agentHeader { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; color: #cc88ff; font-weight: 700; }
        #agentHeader button { background: rgba(255,80,80,0.15); border: 1px solid rgba(255,80,80,0.3); color: #ff8888; padding: 2px 8px; border-radius: 8px; cursor: pointer; font-size: 10px; }
        .agent-step { display: flex; gap: 6px; align-items: flex-start; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
        .agent-step-icon { flex-shrink: 0; width: 16px; text-align: center; }
        .agent-step-body { flex: 1; min-width: 0; }
        .agent-step-desc { color: #ccc; }
        .agent-step-out { color: #777; font-size: 10px; font-family: 'Fira Code', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .agent-step-dur { color: #555; font-size: 10px; margin-left: 4px; }
        .step-running .agent-step-desc { color: #00d2ff; }
        .step-done .agent-step-desc { color: #6debb0; }
        .step-failed .agent-step-desc { color: #ff8888; }
        #lspPanel { background: rgba(0,0,0,0.55); border-top: 1px solid rgba(255,80,80,0.3); padding: 6px 10px; font-size: 11px; max-height: 180px; overflow-y: auto; flex-shrink: 0; }
        #lspHeader { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; color: #ff8888; font-weight: 700; }
        #lspHeader button { background: none; border: none; color: #666; cursor: pointer; font-size: 13px; }
        #lspContent { font-family: 'Fira Code', monospace; font-size: 10px; color: #ccc; white-space: pre-wrap; line-height: 1.6; }
        #lspActions { margin-top: 6px; display: flex; gap: 6px; }
        #lspActions button { background: rgba(0,122,204,0.25); border: 1px solid rgba(0,122,204,0.4); color: #6cb6ff; padding: 3px 10px; border-radius: 8px; cursor: pointer; font-size: 11px; }
        #scrollBtn { display: none; position: absolute; bottom: 14px; right: 14px; width: 32px; height: 32px; border-radius: 50%; background: rgba(0,210,255,0.2); border: 1px solid rgba(0,210,255,0.4); color: #00d2ff; font-size: 16px; cursor: pointer; align-items: center; justify-content: center; transition: all 0.2s; z-index: 10; }
        #scrollBtn:hover { background: rgba(0,210,255,0.35); }
        #chatWrap { flex: 1; position: relative; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
    </style>
</head>
<body>
    <div class="space-bg"></div>
    <div class="header">
        <span class="header-brand">ANTIGRAVITY</span>
        <div class="header-controls">
            <button class="btn-cloud" id="btnCloud">☁️ Cloud</button>
            <button class="btn-cloud" id="btnOnboarding" title="Revoir le guide de démarrage" style="padding:4px 8px;">🛸</button>
            <div id="modelComboWrap">
                <div id="modelComboBox">
                    <input id="modelSearch" type="text" placeholder="Modèle…" autocomplete="off" spellcheck="false">
                    <span id="modelComboArrow">▾</span>
                </div>
                <div id="modelDropdown"></div>
                <select id="modelSelect" style="display:none"></select>
            </div>
        </div>
    </div>
    <div id="localWarn"></div>
    <div id="tokenBar"></div>
    <div id="filesBar"></div>
    <div id="chatWrap">
        <div id="chat"></div>
        <button id="scrollBtn" title="Retour en bas">↓</button>
    </div>
    <div id="terminalLog"></div>
    <div id="agentPanel" style="display:none">
        <div id="agentHeader">
            <span id="agentGoalLabel">🤖 Agent</span>
            <button id="agentStopBtn" onclick="stopAgent()">⏹ Stop</button>
        </div>
        <div id="agentSteps"></div>
    </div>
    <div id="lspPanel" style="display:none">
        <div id="lspHeader">
            <span id="lspSummary">🔴 LSP</span>
            <button onclick="document.getElementById('lspPanel').style.display='none'">✕</button>
        </div>
        <div id="lspContent"></div>
        <div id="lspActions">
            <button onclick="sendLspToAi()">🤖 Envoyer à l'IA</button>
            <button onclick="document.getElementById('lspPanel').style.display='none'">Fermer</button>
        </div>
    </div>
    <div class="input-area">
        <div class="input-actions">
            <button class="btn-action" id="btnAddFile" title="Ajouter un fichier au contexte">📎 Fichier</button>
            <button class="btn-action" id="btnRelatedFiles" title="Ajouter les fichiers importés du fichier actif">🔗 Liés</button>
            <button class="btn-action" id="btnThink" title="Mode Réflexion">🧠 Réflexion</button>
            <button class="btn-action" id="btnError" title="Analyser une erreur">🐛 Erreur</button>
            <button class="btn-action" id="btnGitReview" title="Revue du diff Git">📝 Diff</button>
            <button class="btn-action" id="btnCommit" title="Générer un message de commit">💾 Commit</button>
            <button class="btn-action" id="btnTests" title="Générer les tests du fichier actif">🧪 Tests</button>
            <button class="btn-action" id="btnClearHistory" title="Effacer l'historique">🗑 Vider</button>
            <button class="btn-action" id="btnReset" title="Nouveau chat / Reset">🔄 Reset</button>
            <button class="btn-action" id="btnLsp" title="Analyser les erreurs LSP">🔴 LSP</button>
            <button class="btn-action" id="btnLspWatch" title="Surveiller les erreurs en temps réel">👁 Veille</button>
            <button class="btn-action" id="btnAgent" title="Lancer l'agent autonome IA">🤖 Agent</button>
            <select id="termPermSelect" title="Permissions terminal IA">
                <option value="ask-all">💻 Demander toujours</option>
                <option value="ask-important">⚠️ Demander si important</option>
                <option value="allow-all">🚀 Autoriser tout</option>
            </select>
        </div>
        <div class="input-row">
            <textarea id="prompt" placeholder="Posez une question… (Entrée pour envoyer, Shift+Entrée pour saut de ligne)" rows="1"></textarea>
            <button id="send">SEND</button>
            <button id="stop" style="display:none;">⏹ STOP</button>
        </div>
    </div>
    <script>${script}</script>

    <style>
        #obOverlay {
            display: none;
            position: fixed; inset: 0;
            z-index: 10000;
            align-items: center; justify-content: center;
            overflow: hidden;
        }
        #obCanvas {
            position: absolute; inset: 0;
            width: 100%; height: 100%;
            pointer-events: none;
        }
        #obBg {
            position: absolute; inset: 0;
            background: radial-gradient(ellipse at 50% 40%, #0a0a2e 0%, #04040f 65%, #000 100%);
        }

        #obCard {
            position: relative;
            width: 94%; max-width: 430px;
            background: linear-gradient(160deg, rgba(8,8,24,0.97) 0%, rgba(10,6,28,0.97) 100%);
            border: 1px solid rgba(0,210,255,0.18);
            border-radius: 22px;
            overflow: hidden;
            box-shadow:
                0 0 0 1px rgba(0,210,255,0.08),
                0 0 60px rgba(0,210,255,0.12),
                0 0 120px rgba(100,0,255,0.08),
                inset 0 1px 0 rgba(255,255,255,0.06);
            animation: obCardIn 0.6s cubic-bezier(0.16,1,0.3,1) both;
        }
        @keyframes obCardIn {
            from { opacity:0; transform: translateY(32px) scale(0.95); }
            to   { opacity:1; transform: translateY(0)    scale(1);    }
        }

        #obCard::before {
            content: '';
            position: absolute; top: 0; left: 0; right: 0; height: 1px;
            background: linear-gradient(90deg, transparent, #00d2ff, #7b00ff, transparent);
            opacity: 0.6;
        }

        .ob-hdr {
            padding: 20px 22px 14px;
            position: relative;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .ob-logo-row {
            display: flex; align-items: center; gap: 10px; margin-bottom: 12px;
        }
        .ob-logo-hex {
            width: 36px; height: 36px;
            background: linear-gradient(135deg, #00d2ff22, #7b00ff22);
            border: 1px solid rgba(0,210,255,0.3);
            border-radius: 10px;
            display: flex; align-items: center; justify-content: center;
            font-size: 18px;
        }
        .ob-logo-text { display: flex; flex-direction: column; }
        .ob-brand-tag {
            font-size: 9px; font-weight: 800; letter-spacing: 3.5px;
            color: rgba(0,210,255,0.45); text-transform: uppercase;
        }
        .ob-step-label {
            font-size: 10px; color: #444; margin-top: 1px; font-family: 'Fira Code', monospace;
        }
        .ob-title {
            font-size: 20px; font-weight: 900; color: #fff;
            line-height: 1.15; margin: 0;
            text-shadow: 0 0 20px rgba(0,210,255,0.3);
        }
        .ob-sub { font-size: 12px; color: #555; margin-top: 5px; }

        .ob-progress {
            display: flex; gap: 5px; padding: 12px 22px 0;
        }
        .ob-seg {
            height: 2px; flex: 1; border-radius: 2px;
            background: rgba(255,255,255,0.07);
            transition: background 0.5s ease, box-shadow 0.5s ease;
            overflow: hidden; position: relative;
        }
        .ob-seg.done { background: rgba(0,210,255,0.3); }
        .ob-seg.active {
            background: rgba(0,210,255,0.6);
            box-shadow: 0 0 8px rgba(0,210,255,0.5);
        }
        .ob-seg.active::after {
            content: '';
            position: absolute; top: 0; left: -100%; width: 60%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent);
            animation: obShimmer 1.6s 0.3s infinite;
        }
        @keyframes obShimmer {
            to { left: 200%; }
        }

        .ob-body { padding: 18px 22px 22px; }
        .ob-step {
            display: none; flex-direction: column; gap: 12px;
            animation: obStepIn 0.35s cubic-bezier(0.16,1,0.3,1) both;
        }
        .ob-step.active { display: flex; }
        @keyframes obStepIn {
            from { opacity:0; transform: translateX(16px); }
            to   { opacity:1; transform: translateX(0);    }
        }

        .ob-eyebrow {
            font-size: 9px; font-weight: 800; letter-spacing: 2.5px;
            text-transform: uppercase; color: rgba(0,210,255,0.4); margin-bottom: 2px;
        }
        .ob-h2 { font-size: 16px; font-weight: 900; color: #fff; margin: 0 0 4px; }
        .ob-desc { font-size: 12px; color: #777; line-height: 1.6; margin: 0; }
        .ob-desc b { color: #aaa; }
        .ob-desc a { color: #00d2ff; text-decoration: none; font-weight: 700; }
        .ob-desc a:hover { text-decoration: underline; }

        .ob-box {
            background: rgba(0,210,255,0.04);
            border: 1px solid rgba(0,210,255,0.12);
            border-radius: 12px; padding: 12px 14px;
            font-size: 11px; color: #666; line-height: 1.7;
        }
        .ob-box.purple {
            background: rgba(120,0,255,0.05);
            border-color: rgba(160,0,255,0.15);
        }
        .ob-box b { color: #00d2ff; }
        .ob-box.purple b { color: #cc88ff; }
        .ob-box code {
            background: rgba(0,210,255,0.1); color: #00d2ff;
            padding: 1px 6px; border-radius: 4px;
            font-family: 'Fira Code', monospace; font-size: 10px;
        }
        .ob-box a { color: #00d2ff; font-weight: 700; text-decoration: none; }
        .ob-box a:hover { text-decoration: underline; }
        .ob-box-row { display: flex; align-items: flex-start; gap: 8px; padding: 3px 0; }
        .ob-box-icon { flex-shrink: 0; font-size: 13px; margin-top: 1px; }

        .ob-features {
            display: grid; grid-template-columns: 1fr 1fr;
            gap: 8px;
        }
        .ob-feat {
            background: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.06);
            border-radius: 10px; padding: 10px 12px;
            font-size: 11px; color: #666;
            transition: all 0.2s;
        }
        .ob-feat:hover { background: rgba(0,210,255,0.05); border-color: rgba(0,210,255,0.2); }
        .ob-feat-icon { font-size: 18px; margin-bottom: 5px; }
        .ob-feat-name { font-weight: 700; color: #aaa; font-size: 12px; }
        .ob-feat-desc { color: #555; font-size: 10px; margin-top: 2px; line-height: 1.4; }

        .ob-shortcuts { display: flex; flex-direction: column; gap: 5px; }
        .ob-shortcut {
            display: flex; align-items: center; justify-content: space-between;
            background: rgba(255,255,255,0.025);
            border: 1px solid rgba(255,255,255,0.05);
            border-radius: 8px; padding: 7px 12px;
            font-size: 11px;
        }
        .ob-shortcut-desc { color: #777; }
        .ob-shortcut-key {
            background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.12);
            color: #aaa; padding: 2px 8px; border-radius: 5px;
            font-family: 'Fira Code', monospace; font-size: 10px;
            white-space: nowrap;
        }

        .ob-btns { display: flex; gap: 8px; }
        .ob-btn {
            flex: 1; padding: 11px 12px; border-radius: 12px;
            border: 1px solid rgba(255,255,255,0.1);
            background: rgba(255,255,255,0.04);
            color: #aaa; font-size: 12px; font-weight: 700;
            cursor: pointer; transition: all 0.2s;
            font-family: 'Inter', sans-serif; text-align: center;
        }
        .ob-btn:hover { background: rgba(255,255,255,0.08); color: #fff; border-color: rgba(255,255,255,0.2); }
        .ob-btn.cyan {
            background: rgba(0,210,255,0.08);
            border-color: rgba(0,210,255,0.3); color: #00d2ff;
        }
        .ob-btn.cyan:hover { background: rgba(0,210,255,0.18); border-color: rgba(0,210,255,0.55); }
        .ob-btn.purple {
            background: rgba(120,0,255,0.1);
            border-color: rgba(160,0,255,0.3); color: #cc88ff;
        }
        .ob-btn.purple:hover { background: rgba(120,0,255,0.2); border-color: rgba(160,0,255,0.55); }
        .ob-btn.launch {
            background: linear-gradient(135deg, rgba(0,210,255,0.15), rgba(100,0,255,0.15));
            border-color: rgba(0,210,255,0.4); color: #fff;
            font-size: 14px; padding: 14px;
            box-shadow: 0 0 20px rgba(0,210,255,0.1);
        }
        .ob-btn.launch:hover {
            background: linear-gradient(135deg, rgba(0,210,255,0.25), rgba(100,0,255,0.25));
            box-shadow: 0 0 30px rgba(0,210,255,0.2);
            transform: translateY(-1px);
        }
        .ob-btn:active { transform: scale(0.97); }
        .ob-skip {
            text-align: center; font-size: 11px; color: #333;
            cursor: pointer; padding-top: 2px; transition: color 0.2s;
        }
        .ob-skip:hover { color: #555; }

        .ob-input {
            width: 100%; background: rgba(0,0,0,0.5);
            border: 1px solid rgba(0,210,255,0.2); border-radius: 10px;
            color: #e0e0e0; padding: 11px 14px;
            font-size: 13px; outline: none;
            font-family: 'Inter', sans-serif;
            transition: border-color 0.2s, box-shadow 0.2s;
            box-sizing: border-box;
        }
        .ob-input:focus {
            border-color: rgba(0,210,255,0.5);
            box-shadow: 0 0 0 3px rgba(0,210,255,0.07);
        }
        .ob-input::placeholder { color: #333; }

        .ob-status {
            display: flex; align-items: center; gap: 8px;
            padding: 8px 12px; border-radius: 10px;
            font-size: 11px; font-weight: 600;
            transition: all 0.3s;
        }
        .ob-status.idle { background: rgba(255,255,255,0.03); color: #444; border: 1px solid rgba(255,255,255,0.05); }
        .ob-status.testing { background: rgba(0,210,255,0.06); color: #00d2ff; border: 1px solid rgba(0,210,255,0.2); }
        .ob-status.ok { background: rgba(0,200,100,0.08); color: #6debb0; border: 1px solid rgba(0,200,100,0.2); }
        .ob-status.fail { background: rgba(255,80,80,0.07); color: #ff8888; border: 1px solid rgba(255,80,80,0.2); }
        .ob-status-dot {
            width: 7px; height: 7px; border-radius: 50%;
            background: currentColor; flex-shrink: 0;
        }
        .ob-status.testing .ob-status-dot { animation: obPulse 1s infinite; }
        @keyframes obPulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(1.4)} }

        .ob-celebration {
            text-align: center; padding: 8px 0 4px;
        }
        .ob-big-icon {
            font-size: 52px; margin-bottom: 10px;
            animation: obOrbit 3s ease-in-out infinite;
            display: block;
        }
        @keyframes obOrbit {
            0%,100% { transform: translateY(0) rotate(-3deg); }
            50%      { transform: translateY(-8px) rotate(3deg); }
        }
        .ob-celebration h3 {
            font-size: 22px; font-weight: 900; color: #fff; margin: 0 0 6px;
            text-shadow: 0 0 30px rgba(0,210,255,0.4);
        }
        .ob-celebration p { font-size: 12px; color: #555; line-height: 1.6; margin: 0 0 14px; }
        #obCloseBtn:hover { background: rgba(255,80,80,0.15) !important; color: #ff8888 !important; border-color: rgba(255,80,80,0.3) !important; }
    </style>

    <div id="obOverlay">
        <div id="obBg"></div>
        <canvas id="obCanvas"></canvas>

        <div id="obCard">
            <!-- Header -->
            <div class="ob-hdr">
                <div class="ob-logo-row">
                    <div class="ob-logo-hex">🛸</div>
                    <div class="ob-logo-text">
                        <span class="ob-brand-tag">Antigravity IDE</span>
                        <span class="ob-step-label" id="obStepLabel">step 1 / 5</span>
                    </div>
                    <button id="obCloseBtn" onclick="obSkip();" title="Fermer et revenir au chat" style="margin-left:auto;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#666;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:sans-serif;">✕</button>
                </div>
                <h2 class="ob-title" id="obMainTitle">Mission Briefing</h2>
                <p class="ob-sub" id="obMainSub">Configure your AI co-pilot in 60 seconds.</p>
            </div>

            <div class="ob-progress">
                <div class="ob-seg active" id="obSeg1"></div>
                <div class="ob-seg" id="obSeg2"></div>
                <div class="ob-seg" id="obSeg3"></div>
                <div class="ob-seg" id="obSeg4"></div>
                <div class="ob-seg" id="obSeg5"></div>
            </div>

            <div class="ob-body">

                <div class="ob-step active" id="obStep1">
                    <p class="ob-desc">
                        <b>Antigravity</b> is your AI pair-programmer, built directly into VS Code.<br>
                        It runs <b>locally</b> (private, free) or connects to <b>cloud models</b> — your choice.
                    </p>
                    <div class="ob-features">
                        <div class="ob-feat">
                            <div class="ob-feat-icon">⚡</div>
                            <div class="ob-feat-name">Inline completion</div>
                            <div class="ob-feat-desc">Copilot-style suggestions as you type</div>
                        </div>
                        <div class="ob-feat">
                            <div class="ob-feat-icon">🤖</div>
                            <div class="ob-feat-name">Autonomous agent</div>
                            <div class="ob-feat-desc">Multi-step tasks, reads & writes files</div>
                        </div>
                        <div class="ob-feat">
                            <div class="ob-feat-icon">✨</div>
                            <div class="ob-feat-name">Smart commits</div>
                            <div class="ob-feat-desc">Conventional commits from your diff</div>
                        </div>
                        <div class="ob-feat">
                            <div class="ob-feat-icon">🔴</div>
                            <div class="ob-feat-name">LSP analysis</div>
                            <div class="ob-feat-desc">Fix TypeScript errors with one click</div>
                        </div>
                    </div>
                    <div class="ob-btns">
                        <button class="ob-btn launch" onclick="obGo(2)">Begin setup →</button>
                    </div>
                </div>

                <div class="ob-step" id="obStep2">
                    <div class="ob-eyebrow">Option A — Local & Private</div>
                    <div class="ob-h2">🦙 Ollama</div>
                    <p class="ob-desc">Run AI models on your own machine. <b>No API key, no internet, no cost.</b></p>
                    <div class="ob-box">
                        <div class="ob-box-row">
                            <span class="ob-box-icon">1.</span>
                            <span>Download from <a href="https://ollama.com/download" target="_blank">ollama.com/download ↗</a></span>
                        </div>
                        <div class="ob-box-row">
                            <span class="ob-box-icon">2.</span>
                            <span>In a terminal: <code>ollama run llama3</code></span>
                        </div>
                        <div class="ob-box-row">
                            <span class="ob-box-icon">3.</span>
                            <span>Auto-detected on <code>localhost:11434</code> ✓</span>
                        </div>
                        <div class="ob-box-row" style="margin-top:4px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.05);font-size:10px;color:#666;">
                            <span class="ob-box-icon">💡</span>
                            <span>If the requested model isn't installed, Antigravity auto-selects the <b>lightest available model</b></span>
                        </div>
                    </div>
                    <div class="ob-status idle" id="obOllamaStatus">
                        <div class="ob-status-dot"></div>
                        <span id="obOllamaStatusText">Not tested</span>
                    </div>
                    <div class="ob-btns">
                        <button class="ob-btn cyan" onclick="obTestOllama()">🔍 Test Ollama</button>
                        <button class="ob-btn" onclick="obGo(3)">Skip →</button>
                    </div>

                    <div class="ob-eyebrow" style="margin-top:16px;">Option B — Local GUI</div>
                    <div class="ob-h2" style="font-size:16px;margin-top:2px;">💻 LM Studio</div>
                    <p class="ob-desc" style="font-size:11px;margin-top:2px;">Download <a href="https://lmstudio.ai" target="_blank">lmstudio.ai ↗</a>, load a model, then enable <b>Local Server</b> (port 1234).</p>
                    <div class="ob-status idle" id="obLmStatus">
                        <div class="ob-status-dot"></div>
                        <span id="obLmStatusText">Not tested</span>
                    </div>
                    <div class="ob-btns" style="margin-top:6px;">
                        <button class="ob-btn" style="background:rgba(116,170,156,0.15);border-color:rgba(116,170,156,0.4);color:#74aa9c;" onclick="obTestLmStudio()">🔍 Test LM Studio</button>
                    </div>

                    <div class="ob-skip" onclick="obGo(3)">I'll set this up later</div>
                </div>

                <div class="ob-step" id="obStep3">
                    <div class="ob-eyebrow">Cloud Provider — Free Tier</div>
                    <div class="ob-h2">✨ Google Gemini</div>
                    <p class="ob-desc">The most generous free tier available — <b>no credit card required.</b></p>
                    <div class="ob-box purple">
                        <div class="ob-box-row"><span class="ob-box-icon">🧠</span><span><b>1M token</b> context window — fit entire codebases</span></div>
                        <div class="ob-box-row"><span class="ob-box-icon">🚀</span><span>Fast streaming, vision support (screenshots → code)</span></div>
                        <div class="ob-box-row"><span class="ob-box-icon">🆓</span><span>Free on standard plan — no billing setup</span></div>
                    </div>
                    <div id="obGeminiForm" style="display:flex;flex-direction:column;gap:8px;">
                        <p class="ob-desc" style="font-size:11px;">
                            Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com ↗</a>
                            → <b>Create API key</b> → paste below:
                        </p>
                        <input type="password" id="obGeminiKey" class="ob-input"
                            placeholder="AIzaSy…" autocomplete="off" />
                        <div class="ob-status idle" id="obGeminiStatus">
                            <div class="ob-status-dot"></div>
                            <span id="obGeminiStatusText">Enter key above to validate</span>
                        </div>
                        <div class="ob-btns">
                            <button class="ob-btn purple" onclick="obSaveGemini()">💾 Save & continue</button>
                            <button class="ob-btn" onclick="obGo(4)">Skip</button>
                        </div>
                    </div>
                    <div class="ob-skip" onclick="obGo(4)">I'll configure cloud providers later</div>
                </div>

                <div class="ob-step" id="obStep4">
                    <div class="ob-eyebrow">Quick Reference</div>
                    <div class="ob-h2">🗺️ The cockpit</div>
                    <p class="ob-desc">Everything you need is in the toolbar below the chat.</p>
                    <div class="ob-shortcuts">
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">📎 <b>File</b> — add file to AI context</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">🧠 <b>Think</b> — plan before acting</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">✨ <b>Commit</b> — AI commit message from diff</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">🤖 <b>Agent</b> — autonomous multi-step tasks</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">🔴 <b>LSP</b> — fix type errors with AI</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">☁️ <b>Cloud</b> — manage API keys</span>
                            <span class="ob-shortcut-key">header</span>
                        </div>
                    </div>
                    <div class="ob-btns" style="margin-top:4px;">
                        <button class="ob-btn cyan" onclick="obGo(5)">Got it →</button>
                    </div>
                </div>

                <div class="ob-step" id="obStep5">
                    <div class="ob-celebration">
                        <span class="ob-big-icon" id="obRocket">🛸</span>
                        <h3>You're cleared for launch.</h3>
                        <p>Select a model in the top-right corner<br>and start building with your AI co-pilot.</p>
                    </div>
                    <div class="ob-box" style="font-size:11px; line-height:1.8;">
                        <b>Pro tip:</b> Open any file, then ask the AI to explain it.<br>
                        Use <b>📎 File</b> to give it full context of your project.
                    </div>
                    <button class="ob-btn launch" onclick="obFinish()">🚀 Launch Antigravity</button>
                </div>

            </div>
        </div>
    </div>

    <script>
        (function initCanvas() {
            var canvas = document.getElementById('obCanvas');
            if (!canvas) return;
            var ctx = canvas.getContext('2d');
            var W, H, particles = [];

            function resize() {
                W = canvas.width  = canvas.offsetWidth;
                H = canvas.height = canvas.offsetHeight;
            }
            resize();
            window.addEventListener('resize', resize);

            for (var i = 0; i < 80; i++) {
                particles.push({
                    x: Math.random() * 1600,
                    y: Math.random() * 1200,
                    r: Math.random() * 1.2 + 0.2,
                    dx: (Math.random() - 0.5) * 0.12,
                    dy: (Math.random() - 0.5) * 0.12,
                    a: Math.random() * 0.5 + 0.1,
                    da: (Math.random() - 0.5) * 0.004,
                    hue: Math.random() < 0.6 ? 190 : 270,
                });
            }

            var shooters = [];
            function spawnShooter() {
                shooters.push({
                    x: Math.random() * W,
                    y: 0,
                    len: Math.random() * 60 + 30,
                    speed: Math.random() * 3 + 2,
                    angle: Math.PI / 4 + (Math.random() - 0.5) * 0.3,
                    a: 0.7,
                });
            }
            setInterval(spawnShooter, 2400);

            function draw() {
                ctx.clearRect(0, 0, W, H);
                particles.forEach(function(p) {
                    p.x += p.dx; p.y += p.dy; p.a += p.da;
                    if (p.a < 0.05 || p.a > 0.65) p.da *= -1;
                    if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
                    if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
                    ctx.fillStyle = 'hsla(' + p.hue + ',80%,80%,' + p.a + ')';
                    ctx.fill();
                });
                shooters = shooters.filter(function(s) { return s.a > 0.01; });
                shooters.forEach(function(s) {
                    s.x += Math.cos(s.angle) * s.speed;
                    s.y += Math.sin(s.angle) * s.speed;
                    s.a -= 0.012;
                    var grd = ctx.createLinearGradient(s.x, s.y, s.x - Math.cos(s.angle)*s.len, s.y - Math.sin(s.angle)*s.len);
                    grd.addColorStop(0, 'rgba(0,210,255,' + s.a + ')');
                    grd.addColorStop(1, 'rgba(0,210,255,0)');
                    ctx.beginPath();
                    ctx.moveTo(s.x, s.y);
                    ctx.lineTo(s.x - Math.cos(s.angle)*s.len, s.y - Math.sin(s.angle)*s.len);
                    ctx.strokeStyle = grd;
                    ctx.lineWidth = 1.5;
                    ctx.stroke();
                });
                requestAnimationFrame(draw);
            }
            draw();
        })();
    </script>
</body>
</html>`;
    }
}