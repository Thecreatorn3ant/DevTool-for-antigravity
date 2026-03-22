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
                        vscode.window.showInformationMessage('Ã¢Å“â€¦ ClÃƒÂ© Gemini configurÃƒÂ©e avec succÃƒÂ¨s !');
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
                    vscode.window.showInformationMessage(`Ã¢Å“â€¦ ${data.summary}`);
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
                ? `Ã°Å¸â€â€ž Chat rÃƒÂ©initialisÃƒÂ© avec template "${template.name}"`
                : 'Ã°Å¸â€â€ž Nouveau chat crÃƒÂ©ÃƒÂ©'
        );
    }

    public async analyzeError(errorText: string) {
        if (!this._view) return;

        this._view.webview.postMessage({ type: 'statusMessage', value: 'Ã°Å¸â€Â Analyse de l\'erreur en cours...' });

        const relatedFiles = await this._fileCtxManager.findFilesForError(errorText);

        if (relatedFiles.length > 0) {
            this.addFilesToContext(relatedFiles);
            this._view.webview.postMessage({
                type: 'statusMessage',
                value: `Ã°Å¸â€œÂ ${relatedFiles.length} fichier(s) dÃƒÂ©tectÃƒÂ©(s) automatiquement : ${relatedFiles.map(f => f.name).join(', ')}`
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
            ? 'MODE RÃƒâ€°FLEXION ACTIVÃƒâ€° : Commence par un bloc [PLAN] listant TOUTES les modifications que tu prÃƒÂ©vois de faire (fichiers, fonctions, raisons), puis [/PLAN]. Ensuite seulement, fournis le code.\n\n'
            : '';

        const fullContext = [
            projectSummary ? `[MÃƒâ€°MOIRE PROJET]\n${projectSummary}` : '',
            '[STRUCTURE]',
            treeStr,
            '',
            '[HISTORIQUE RÃƒâ€°CENT]',
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
                    value: 'Ã¢Å¡Â Ã¯Â¸Â GÃƒÂ©nÃƒÂ©ration arrÃƒÂªtÃƒÂ©e par l\'utilisateur.'
                });
                this._updateHistory();
                this._view.webview.postMessage({
                    type: 'endResponse',
                    value: 'Ã¢Å¡Â Ã¯Â¸Â GÃƒÂ©nÃƒÂ©ration arrÃƒÂªtÃƒÂ©e par l\'utilisateur.'
                });
            } else {
                const msg = e?.message ?? String(e);
                const is403 = msg.includes('403') || msg.includes('PERMISSION_DENIED');
                const is404 = msg.includes('404') || msg.includes('not found');
                const isRateLimit = msg.includes('429') || msg.includes('rate limit');

                let errorMessage = '';

                if (is403) {
                    errorMessage = `Ã¢ÂÅ’ **Erreur 403 - AccÃƒÂ¨s refusÃƒÂ©**\n\nLa requÃƒÂªte a ÃƒÂ©tÃƒÂ© refusÃƒÂ©e par le serveur.\n\n**Solutions :**\n1. VÃƒÂ©rifiez votre clÃƒÂ© API dans les paramÃƒÂ¨tres (Ã¢ËœÂÃ¯Â¸Â Cloud)\n2. Essayez un autre modÃƒÂ¨le\n\n_DÃƒÂ©tails : ${msg}_`;
                } else if (is404) {
                    errorMessage = `Ã¢ÂÅ’ **Erreur 404 - ModÃƒÂ¨le introuvable**\n\nLe modÃƒÂ¨le demandÃƒÂ© n'existe pas ou n'est plus disponible.\n\n_DÃƒÂ©tails : ${msg}_`;
                } else if (isRateLimit) {
                    errorMessage = `Ã¢Å¡Â Ã¯Â¸Â **Erreur 429 - Limite de requÃƒÂªtes atteinte**\n\nVous avez atteint la limite de requÃƒÂªtes autorisÃƒÂ©es.\n\n_DÃƒÂ©tails : ${msg}_`;
                } else {
                    errorMessage = `Ã¢ÂÅ’ **Erreur lors de la gÃƒÂ©nÃƒÂ©ration**\n\n\`\`\`\n${msg}\n\`\`\``;
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
                    value: `Ã°Å¸â€œÂ Fichier "${file.name}" ajoutÃƒÂ© au contexte IA.`
                });
            }
        }

        for (const cf of parsed.createFiles) {
            if (this._fileCtxManager.isInWorkspace(cf.name)) {
                await this._handleFileCreation(cf.name, cf.content);
            } else {
                const answer = await vscode.window.showInformationMessage(
                    `L'IA veut crÃƒÂ©er : "${cf.name}" (hors workspace). Confirmer ?`,
                    'Ã¢Å“â€¦ CrÃƒÂ©er', 'Ã¢ÂÅ’ Ignorer'
                );
                if (answer === 'Ã¢Å“â€¦ CrÃƒÂ©er') {
                    await this._handleFileCreation(cf.name, cf.content);
                }
            }
        }

        for (const filePath of parsed.deleteFiles) {
            if (this._fileCtxManager.isInWorkspace(filePath)) {
                await this._handleFileDeletion(filePath);
            } else {
                const answer = await vscode.window.showInformationMessage(
                    `Ã¢Å¡Â Ã¯Â¸Â L'IA veut SUPPRIMER : "${filePath}" (hors workspace). Confirmer ?`,
                    { modal: true },
                    'Ã°Å¸â€”â€˜ Supprimer', 'Ã¢ÂÅ’ Annuler'
                );
                if (answer === 'Ã°Å¸â€”â€˜ Supprimer') {
                    await this._handleFileDeletion(filePath);
                }
            }
        }

        if (parsed.projectSummary) {
            await this._fileCtxManager.saveProjectSummary(parsed.projectSummary);
            this._showNotification('Ã¢Å“â€¦ MÃƒÂ©moire du projet mise ÃƒÂ  jour', 'success');
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
                    'Ã°Å¸â€œâ€¹ Appliquer', 'Ã°Å¸â€˜Â Voir fichier par fichier', 'Ã¢ÂÅ’ Ignorer'
                );
                if (answer === 'Ã°Å¸â€œâ€¹ Appliquer') {
                    await this._handleMultiFileApply(
                        Array.from(multiPatches.entries()).map(([name, patch]) => ({ name, patch }))
                    );
                } else if (answer === 'Ã°Å¸â€˜Â Voir fichier par fichier') {
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
            this._showNotification(`Ã¢Å“â€¦ ${applied} fichier(s) modifiÃƒÂ©(s)`, 'success');
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
            this._showNotification('Aucun import local dÃƒÂ©tectÃƒÂ©', 'info');
            return;
        }

        this.addFilesToContext(related);
        this._view?.webview.postMessage({
            type: 'statusMessage',
            value: `Ã°Å¸â€â€” ${related.length} fichier(s) liÃƒÂ©(s) ajoutÃƒÂ©(s) : ${related.map(f => f.name).join(', ')}`
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
            detail: `${s.statusLabel}  Ã‚Â·  AjoutÃƒÂ© ${s.entry.addedAt ? new Date(s.entry.addedAt).toLocaleDateString('fr-FR') : 'N/A'}`,
            action: 'select',
            keyIdx: i,
        }));

        const items: KeyMenuItem[] = [
            ...keyItems,
            { label: '', kind: vscode.QuickPickItemKind.Separator } as any,
            { label: '$(add)  Ajouter une clÃƒÂ© API', description: 'Configurer un nouveau provider cloud', action: 'add' },
            { label: '$(gear)  GÃƒÂ©rer les clÃƒÂ©s existantes', description: 'Modifier / Supprimer / RÃƒÂ©initialiser le cooldown', action: 'manage' },
        ];

        const picked = await vscode.window.showQuickPick(items, {
            title: 'Ã¢ËœÂÃ¯Â¸Â Gestion des clÃƒÂ©s API Cloud',
            placeHolder: statuses.length === 0 ? 'Aucune clÃƒÂ© configurÃƒÂ©e Ã¢â‚¬â€ ajoutez-en une' : 'SÃƒÂ©lectionner un compte ou gÃƒÂ©rer les clÃƒÂ©s',
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
                    `Ã¢Å¡Â Ã¯Â¸Â "${entry.name}" est en cooldown encore ${status.cooldownSecsLeft}s. Utiliser quand mÃƒÂªme ?`,
                    'Utiliser quand mÃƒÂªme', 'RÃƒÂ©initialiser le cooldown', 'Annuler'
                );
                if (!choice || choice === 'Annuler') return;
                if (choice === 'RÃƒÂ©initialiser le cooldown') {
                    await this._ollamaClient.resetKeyCooldown(entry.key, entry.url);
                    vscode.window.showInformationMessage(`Ã¢Å“â€¦ Cooldown rÃƒÂ©initialisÃƒÂ© pour "${entry.name}".`);
                }
            }
            await this._updateModelsList(entry.url, entry.key);
        }
    }

    private async _handleAddKey() {
        const name = await vscode.window.showInputBox({
            title: 'Ajouter un provider Ã¢â‚¬â€ 1/3',
            prompt: 'Nom du provider',
            placeHolder: 'ex: OpenAI perso, Ollama VPS, OpenRouter #2Ã¢â‚¬Â¦',
            ignoreFocusOut: true,
        });
        if (!name) return;

        interface UrlPreset extends vscode.QuickPickItem {
            description: string;
            needsKey: boolean;
        }
        const PRESET_URLS: UrlPreset[] = [
            { label: 'Ã¢ËœÂÃ¯Â¸Â Ollama Cloud (ollama.com)', description: 'https://api.ollama.com', needsKey: true, detail: 'ClÃƒÂ© API sur ollama.com/settings' },
            { label: 'Ã¢Å¡Â¡ Ollama auto-hÃƒÂ©bergÃƒÂ© (sans clÃƒÂ©)', description: '', needsKey: false, detail: 'Serveur Ollama local ou VPS' },
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
            { label: 'Autre / PersonnalisÃƒÂ©Ã¢â‚¬Â¦', description: '', needsKey: true, detail: 'Entrer une URL manuellement' },
        ];

        const urlPick = await vscode.window.showQuickPick(PRESET_URLS, {
            title: 'Ajouter un provider Ã¢â‚¬â€ 2/3',
            placeHolder: 'Choisir le type de provider',
            matchOnDetail: true,
        });
        if (!urlPick) return;

        let url = urlPick.description;
        if (!url) {
            const isOllama = urlPick.label.startsWith('Ã¢Å¡Â¡');
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
            title: 'Ajouter un provider Ã¢â‚¬â€ 3/3',
            prompt: keyRequired ? `ClÃƒÂ© API pour "${name}"` : `ClÃƒÂ© API pour "${name}" (optionnelle)`,
            placeHolder: keyRequired ? 'sk-Ã¢â‚¬Â¦' : '(optionnel)',
            password: true,
            ignoreFocusOut: true,
        });
        if (key === undefined) return;

        const result = await this._ollamaClient.addApiKey({ name, url, key: key || '' });
        if (!result.success) {
            vscode.window.showWarningMessage(`Ã¢Å¡Â Ã¯Â¸Â ${result.reason}`);
            return;
        }

        vscode.window.showInformationMessage(`Ã¢Å“â€¦ Provider "${name}" ajoutÃƒÂ©.`);
        await this._updateModelsList(url, key || undefined);
    }

    private async _handleManageKeys() {
        const statuses = await this._ollamaClient.getApiKeyStatusesAsync();
        if (statuses.length === 0) {
            const addNow = await vscode.window.showInformationMessage('Aucune clÃƒÂ© configurÃƒÂ©e. Ajouter une clÃƒÂ© ?', 'Ajouter', 'Annuler');
            if (addNow === 'Ajouter') await this._handleAddKey();
            return;
        }

        interface ManageItem extends vscode.QuickPickItem { statusIdx: number; }
        const items: ManageItem[] = statuses.map((s, i) => ({
            label: `${s.statusIcon} ${s.entry.name}`,
            description: s.entry.url,
            detail: s.statusLabel + (s.entry.key ? `  Ã‚Â·  ClÃƒÂ©: ${s.entry.key.substring(0, 8)}Ã‚Â·Ã‚Â·Ã‚Â·Ã‚Â·Ã‚Â·Ã‚Â·Ã‚Â·Ã‚Â·` : ''),
            statusIdx: i,
        }));

        const picked = await vscode.window.showQuickPick(items, {
            title: 'Ã°Å¸â€â€˜ GÃƒÂ©rer les clÃƒÂ©s Ã¢â‚¬â€ SÃƒÂ©lectionner une clÃƒÂ©',
            placeHolder: 'Choisir la clÃƒÂ© ÃƒÂ  modifier',
        });
        if (!picked) return;

        const target = statuses[picked.statusIdx];
        await this._handleKeyActions(target);
    }

    private async _handleKeyActions(target: ApiKeyStatus) {
        const entry = target.entry;
        const actions: vscode.QuickPickItem[] = [
            { label: 'Ã¢Å“ÂÃ¯Â¸Â  Renommer', description: `Nom actuel : "${entry.name}"` },
            { label: 'Ã°Å¸â€â€˜  Changer la clÃƒÂ© API', description: `ClÃƒÂ© actuelle : ${entry.key.substring(0, 8)}Ã‚Â·Ã‚Â·Ã‚Â·Ã‚Â·Ã‚Â·` },
            ...(target.status === 'cooldown' ? [{ label: 'Ã°Å¸â€â€ž  RÃƒÂ©initialiser le cooldown', description: `Restant : ${target.cooldownSecsLeft}s` }] : []),
            { label: 'Ã°Å¸â€”â€˜Ã¯Â¸Â  Supprimer cette clÃƒÂ©', description: `"${entry.name}" Ã¢â‚¬â€ ${entry.url}` },
            { label: 'Ã¢â€ Â©Ã¯Â¸Â  Retour' },
        ];

        const action = await vscode.window.showQuickPick(actions, { title: `Ã¢Å¡â„¢Ã¯Â¸Â Actions Ã¢â‚¬â€ ${entry.name}` });
        if (!action || action.label === 'Ã¢â€ Â©Ã¯Â¸Â  Retour') { await this._handleManageKeys(); return; }

        if (action.label.startsWith('Ã¢Å“ÂÃ¯Â¸Â')) {
            const newName = await vscode.window.showInputBox({ prompt: 'Nouveau nom', value: entry.name, ignoreFocusOut: true });
            if (!newName || newName === entry.name) return;
            await this._ollamaClient.updateApiKey(entry.key, entry.url, { name: newName });
            this._showNotification(`Ã¢Å“â€¦ RenommÃƒÂ© en "${newName}"`, 'success');
        } else if (action.label.startsWith('Ã°Å¸â€â€˜')) {
            const newKey = await vscode.window.showInputBox({ prompt: `Nouvelle clÃƒÂ© API pour "${entry.name}"`, placeHolder: 'sk-Ã¢â‚¬Â¦', password: true, ignoreFocusOut: true });
            if (!newKey) return;
            await this._ollamaClient.deleteApiKey(entry.key, entry.url);
            await this._ollamaClient.addApiKey({ name: entry.name, url: entry.url, key: newKey, platform: entry.platform });
            this._showNotification(`Ã¢Å“â€¦ ClÃƒÂ© mise ÃƒÂ  jour pour "${entry.name}"`, 'success');
            await this._updateModelsList(entry.url, newKey);
        } else if (action.label.startsWith('Ã°Å¸â€â€ž')) {
            await this._ollamaClient.resetKeyCooldown(entry.key, entry.url);
            this._showNotification(`Ã¢Å“â€¦ Cooldown rÃƒÂ©initialisÃƒÂ© Ã¢â‚¬â€ "${entry.name}" disponible`, 'success');
        } else if (action.label.startsWith('Ã°Å¸â€”â€˜Ã¯Â¸Â')) {
            const confirm = await vscode.window.showWarningMessage(
                `Supprimer la clÃƒÂ© "${entry.name}" ? Cette action est irrÃƒÂ©versible.`,
                { modal: true }, 'Ã°Å¸â€”â€˜Ã¯Â¸Â Supprimer', 'Annuler'
            );
            if (confirm !== 'Ã°Å¸â€”â€˜Ã¯Â¸Â Supprimer') return;
            await this._ollamaClient.deleteApiKey(entry.key, entry.url);
            this._showNotification(`Ã°Å¸â€”â€˜Ã¯Â¸Â ClÃƒÂ© "${entry.name}" supprimÃƒÂ©e`, 'info');
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
                local: 'Ã¢Å¡Â¡', lmstudio: 'Ã°Å¸â€™Â»', gemini: 'Ã¢Å“Â¦', openai: 'Ã¢â€”Ë†', openrouter: 'Ã¢â€”Å½',
                together: 'Ã¢â€”â€°', mistral: 'Ã¢â€”â€ ', groq: 'Ã¢â€“Â¸', anthropic: 'Ã¢â€”Ë†',
                deepseek: 'Ã¢â€”â€°', cohere: 'Ã¢â€”Ë†', perplexity: 'Ã¢â€”Å½', xai: 'Ã¢â€”Ë†',
                fireworks: 'Ã¢Å¡Â¡', 'ollama-cloud': 'Ã¢ËœÂÃ¯Â¸Â'
            };
            const formattedModels: Array<{ label: string; value: string; name: string; url: string; isLocal: boolean; provider: string }> = allModels.map(m => ({
                label: `${PROVIDER_ICONS[m.provider] || 'Ã¢ËœÂÃ¯Â¸Â'} ${m.name}`,
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
                                formattedModels.push({ label: `Ã¢ËœÂÃ¯Â¸Â  ${m}`, value: val, name: m, url: tmpKey.url, isLocal: false, provider: 'ollama-cloud' });
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
            this._showNotification(`Ã¢Å“â€¦ Fichier crÃƒÂ©ÃƒÂ© : ${fileName}`, 'success');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Erreur crÃƒÂ©ation : ${e.message}`);
        }
    }

    private async _handleFileDeletion(fileName: string) {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = vscode.Uri.file(path.join(folder, fileName));
        try {
            await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
            this._showNotification(`Ã°Å¸â€”â€˜ Fichier supprimÃƒÂ© : ${fileName}`, 'info');
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
                `Le bloc SEARCH/REPLACE n'a pas pu ÃƒÂªtre appliquÃƒÂ© ÃƒÂ  "${path.basename(uri.fsPath)}".`,
                'Fermer'
            );
            ChatViewProvider._previewProvider.delete(previewUri);
            return;
        }

        let result = 'Ã¢Å“â€¦ Accepter';
        if (!autoAccept) {
            result = await vscode.window.showInformationMessage(
                patchCount > 0
                    ? `Appliquer ${patchCount} modification(s) ÃƒÂ  "${path.basename(uri.fsPath)}" ?`
                    : `Aucune modification SEARCH/REPLACE trouvÃƒÂ©e. Remplacer tout le fichier ?`,
                { modal: false },
                'Ã¢Å“â€¦ Accepter', 'Ã¢ÂÅ’ Rejeter'
            ) || 'Ã¢ÂÅ’ Rejeter';
        }

        ChatViewProvider._previewProvider.delete(previewUri);

        if (result === 'Ã¢Å“â€¦ Accepter') {
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
            const detail = patchCount > 0 ? `${patchCount} patch(s) Ã¢â‚¬Â¢ Ligne ${firstChangedLine}` : 'Fichier remplacÃƒÂ©';
            this._showNotification(`Ã¢Å“â€¦ ${fileName}: ${detail}`, 'success');

            setTimeout(async () => {
                const report = this._lspManager.getSnapshot('active');
                if (report.errorCount > 0) {
                    const ans = await vscode.window.showErrorMessage(
                        `Ã¢Å¡Â Ã¯Â¸Â Des erreurs ont ÃƒÂ©tÃƒÂ© dÃƒÂ©tectÃƒÂ©es aprÃƒÂ¨s l'application du code ÃƒÂ  "${fileName}". Voulez-vous que l'IA tente de les corriger ?`,
                        'Ã°Å¸Â¤â€“ Corriger avec l\'IA', 'Ã¢ÂÅ’ Ignorer'
                    );
                    if (ans === 'Ã°Å¸Â¤â€“ Corriger avec l\'IA') {
                        const formatted = this._lspManager.formatForPrompt(report, 5);
                        this.sendMessageFromEditor(`Des erreurs LSP sont apparues dans "${fileName}" aprÃƒÂ¨s l'application de tes modifications. Voici les erreurs :\n${formatted}\n\nPropose un correctif.`);
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
                `${isImportant ? 'Ã¢Å¡Â Ã¯Â¸Â Commande importante' : 'Ã°Å¸â€™Â» Terminal'} Ã¢â‚¬â€ ExÃƒÂ©cuter : \`${cmd}\``,
                { modal: isImportant },
                'Ã°Å¸Å¡â‚¬ ExÃƒÂ©cuter', 'Ã¢ÂÅ’ Refuser'
            );
            shouldRun = answer === 'Ã°Å¸Å¡â‚¬ ExÃƒÂ©cuter';
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
            vscode.window.showWarningMessage('Aucun fichier stagÃƒÂ©. Faites d\'abord un `git add`.');
            return;
        }
        this.sendMessageFromEditor(
            `GÃƒÂ©nÃƒÂ¨re un message de commit conventionnel (feat/fix/refactor/chore/docs/test) pour ce diff stagÃƒÂ©. RÃƒÂ©ponds UNIQUEMENT avec le message de commit, sans explications :\n\`\`\`diff\n${diff.substring(0, 6000)}\n\`\`\``
        );
    }

    private async _handleReviewDiff() {
        const diff = await this._fileCtxManager.getGitDiff(false);
        if (!diff) {
            vscode.window.showWarningMessage('Aucune modification Git trouvÃƒÂ©e.');
            return;
        }
        this.sendMessageFromEditor(
            `Revois ce diff Git. Identifie : bugs potentiels, problÃƒÂ¨mes de sÃƒÂ©curitÃƒÂ©, mauvaises pratiques, oublis.\n\`\`\`diff\n${diff.substring(0, 8000)}\n\`\`\``
        );
    }

    private async _handleGenerateTests() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Aucun fichier actif.'); return; }
        const fileName = path.basename(editor.document.fileName, path.extname(editor.document.fileName));
        const ext = path.extname(editor.document.fileName);
        this.sendMessageFromEditor(
            `GÃƒÂ©nÃƒÂ¨re des tests unitaires complets pour le fichier actif. CrÃƒÂ©e le fichier [CREATE_FILE: ${fileName}.test${ext}] avec des cas de test couvrant les cas normaux, les cas limites, et les cas d'erreur. Utilise le framework de test appropriÃƒÂ© au projet.`
        );
    }

    private async _handleUpdateProjectSummary() {
        this.sendMessageFromEditor(
            `GÃƒÂ©nÃƒÂ¨re un rÃƒÂ©sumÃƒÂ© technique de ce projet en 200-300 mots. Inclus : technos principales, architecture, rÃƒÂ´le des dossiers clÃƒÂ©s, patterns utilisÃƒÂ©s. Encadre ta rÃƒÂ©ponse avec [PROJECT_SUMMARY] et [/PROJECT_SUMMARY].`
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
                ? "Ã°Å¸â€˜Â Surveillance LSP activÃƒÂ©e Ã¢â‚¬â€ l'IA sera notifiÃƒÂ©e des nouvelles erreurs."
                : 'Ã°Å¸â€˜Â Surveillance LSP dÃƒÂ©sactivÃƒÂ©e.'
        );
    }

    private async _handleRunAgent(goal: string) {
        if (this._agentRunner.isRunning()) {
            vscode.window.showWarningMessage("Un agent est dÃƒÂ©jÃƒÂ  en cours. ArrÃƒÂªtez-le avant d'en lancer un nouveau.");
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
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js')
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.css')
        );
        const cspSource = webview.cspSource;

        return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'unsafe-inline' https://fonts.googleapis.com ${cspSource}; font-src https://fonts.gstatic.com; script-src 'unsafe-inline' ${cspSource};">
    <link rel="stylesheet" href="${styleUri}">
    <style>
        .space-bg { background-image: url('${bgUri}'); }
    </style>
</head>
<body>
    <div class="space-bg"></div>
    <div class="header">
        <span class="header-brand">ANTIGRAVITY</span>
        <div class="header-controls">
            <button class="btn-cloud" id="btnHome" title="Accueil" style="padding:4px 8px; font-weight: 700;">ðŸ  Accueil</button>
            <button class="btn-cloud" id="btnCloud">â˜ï¸ Cloud</button>
            <button class="btn-cloud" id="btnOnboarding" title="Revoir le guide de dÃ©marrage" style="padding:4px 8px;">ðŸ›¸</button>
            <div id="modelComboWrap">
                <div id="modelComboBox">
                    <input id="modelSearch" type="text" placeholder="ModÃ¨leâ€¦" autocomplete="off" spellcheck="false">
                    <span id="modelComboArrow">â–¾</span>
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
        <button id="scrollBtn" title="Retour en bas">â†“</button>
    </div>
    <div id="terminalLog"></div>
    <div id="agentPanel" style="display:none">
        <div id="agentHeader">
            <span id="agentGoalLabel">ðŸ¤– Agent</span>
            <button id="agentStopBtn" onclick="stopAgent()">â¹ Stop</button>
        </div>
        <div id="agentSteps"></div>
    </div>
    <div id="lspPanel" style="display:none">
        <div id="lspHeader">
            <span id="lspSummary">ðŸ”´ LSP</span>
            <button onclick="document.getElementById('lspPanel').style.display='none'">âœ•</button>
        </div>
        <div id="lspContent"></div>
        <div id="lspActions">
            <button onclick="sendLspToAi()">ðŸ¤– Envoyer Ã  l'IA</button>
            <button onclick="document.getElementById('lspPanel').style.display='none'">Fermer</button>
        </div>
    </div>
    <div class="input-area">
        <div class="input-actions">
            <button class="btn-action" id="btnAddFile" title="Ajouter un fichier au contexte">ðŸ“Ž Fichier</button>
            <button class="btn-action" id="btnRelatedFiles" title="Ajouter les fichiers importÃ©s du fichier actif">ðŸ”— LiÃ©s</button>
            <button class="btn-action" id="btnThink" title="Mode RÃ©flexion">ðŸ§  RÃ©flexion</button>
            <button class="btn-action" id="btnError" title="Analyser une erreur">ðŸ› Erreur</button>
            <button class="btn-action" id="btnGitReview" title="Revue du diff Git">ðŸ“ Diff</button>
            <button class="btn-action" id="btnCommit" title="GÃ©nÃ©rer un message de commit">ðŸ’¾ Commit</button>
            <button class="btn-action" id="btnTests" title="GÃ©nÃ©rer les tests du fichier actif">ðŸ§ª Tests</button>
            <button class="btn-action" id="btnClearHistory" title="Effacer l'historique">ðŸ—‘ Vider</button>
            <button class="btn-action" id="btnReset" title="Nouveau chat / Reset">ðŸ”„ Reset</button>
            <button class="btn-action" id="btnLsp" title="Analyser les erreurs LSP">ðŸ”´ LSP</button>
            <button class="btn-action" id="btnLspWatch" title="Surveiller les erreurs en temps rÃ©el">ðŸ‘ Veille</button>
            <button class="btn-action" id="btnAgent" title="Lancer l'agent autonome IA">ðŸ¤– Agent</button>
            <select id="termPermSelect" title="Permissions terminal IA">
                <option value="ask-all">ðŸ’» Demander toujours</option>
                <option value="ask-important">âš ï¸ Demander si important</option>
                <option value="allow-all">ðŸš€ Autoriser tout</option>
            </select>
        </div>
        <div class="input-row">
            <textarea id="prompt" placeholder="Posez une questionâ€¦ (EntrÃ©e pour envoyer, Shift+EntrÃ©e pour saut de ligne)" rows="1"></textarea>
            <button id="send">SEND</button>
            <button id="stop" style="display:none;">â¹ STOP</button>
        </div>
    </div>

    <!-- Onboarding Overlay -->
    <div id="obOverlay">
        <div id="obBg"></div>
        <canvas id="obCanvas"></canvas>

        <div id="obCard">
            <!-- Header -->
            <div class="ob-hdr">
                <div class="ob-logo-row">
                    <div class="ob-logo-hex">ðŸ›¸</div>
                    <div class="ob-logo-text">
                        <span class="ob-brand-tag">Antigravity IDE</span>
                        <span class="ob-step-label" id="obStepLabel">step 1 / 5</span>
                    </div>
                    <button id="obCloseBtn" onclick="obSkip();" title="Fermer et revenir au chat" style="margin-left:auto;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:#666;width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:sans-serif;">âœ•</button>
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
                        It runs <b>locally</b> (private, free) or connects to <b>cloud models</b> â€” your choice.
                    </p>
                    <div class="ob-features">
                        <div class="ob-feat">
                            <div class="ob-feat-icon">âš¡</div>
                            <div class="ob-feat-name">Inline completion</div>
                            <div class="ob-feat-desc">Copilot-style suggestions as you type</div>
                        </div>
                        <div class="ob-feat">
                            <div class="ob-feat-icon">ðŸ¤–</div>
                            <div class="ob-feat-name">Autonomous agent</div>
                            <div class="ob-feat-desc">Multi-step tasks, reads & writes files</div>
                        </div>
                        <div class="ob-feat">
                            <div class="ob-feat-icon">âœ¨</div>
                            <div class="ob-feat-name">Smart commits</div>
                            <div class="ob-feat-desc">Conventional commits from your diff</div>
                        </div>
                        <div class="ob-feat">
                            <div class="ob-feat-icon">ðŸ”´</div>
                            <div class="ob-feat-name">LSP analysis</div>
                            <div class="ob-feat-desc">Fix TypeScript errors with one click</div>
                        </div>
                    </div>
                    <div class="ob-btns">
                        <button class="ob-btn launch" onclick="obGo(2)">Begin setup â†’</button>
                    </div>
                </div>

                <div class="ob-step" id="obStep2">
                    <div class="ob-eyebrow">Option A â€” Local & Private</div>
                    <div class="ob-h2">ðŸ¦™ Ollama</div>
                    <p class="ob-desc">Run AI models on your own machine. <b>No API key, no internet, no cost.</b></p>
                    <div class="ob-box">
                        <div class="ob-box-row">
                            <span class="ob-box-icon">1.</span>
                            <span>Download from <a href="https://ollama.com/download" target="_blank">ollama.com/download â†—</a></span>
                        </div>
                        <div class="ob-box-row">
                            <span class="ob-box-icon">2.</span>
                            <span>In a terminal: <code>ollama run llama3</code></span>
                        </div>
                        <div class="ob-box-row">
                            <span class="ob-box-icon">3.</span>
                            <span>Auto-detected on <code>localhost:11434</code> âœ“</span>
                        </div>
                        <div class="ob-box-row" style="margin-top:4px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.05);font-size:10px;color:#666;">
                            <span class="ob-box-icon">ðŸ’¡</span>
                            <span>If the requested model isn't installed, Antigravity auto-selects the <b>lightest available model</b></span>
                        </div>
                    </div>
                    <div class="ob-status idle" id="obOllamaStatus">
                        <div class="ob-status-dot"></div>
                        <span id="obOllamaStatusText">Not tested</span>
                    </div>
                    <div class="ob-btns">
                        <button class="ob-btn cyan" onclick="obTestOllama()">ðŸ” Test Ollama</button>
                        <button class="ob-btn" onclick="obGo(3)">Skip â†’</button>
                    </div>

                    <div class="ob-eyebrow" style="margin-top:16px;">Option B â€” Local GUI</div>
                    <div class="ob-h2" style="font-size:16px;margin-top:2px;">ðŸ’» LM Studio</div>
                    <p class="ob-desc" style="font-size:11px;margin-top:2px;">Download <a href="https://lmstudio.ai" target="_blank">lmstudio.ai â†—</a>, load a model, then enable <b>Local Server</b> (port 1234).</p>
                    <div class="ob-status idle" id="obLmStatus">
                        <div class="ob-status-dot"></div>
                        <span id="obLmStatusText">Not tested</span>
                    </div>
                    <div class="ob-btns" style="margin-top:6px;">
                        <button class="ob-btn" style="background:rgba(116,170,156,0.15);border-color:rgba(116,170,156,0.4);color:#74aa9c;" onclick="obTestLmStudio()">ðŸ” Test LM Studio</button>
                    </div>

                    <div class="ob-skip" onclick="obGo(3)">I'll set this up later</div>
                </div>

                <div class="ob-step" id="obStep3">
                    <div class="ob-eyebrow">Cloud Provider â€” Free Tier</div>
                    <div class="ob-h2">âœ¨ Google Gemini</div>
                    <p class="ob-desc">The most generous free tier available â€” <b>no credit card required.</b></p>
                    <div class="ob-box purple">
                        <div class="ob-box-row"><span class="ob-box-icon">ðŸ§ </span><span><b>1M token</b> context window â€” fit entire codebases</span></div>
                        <div class="ob-box-row"><span class="ob-box-icon">ðŸš€</span><span>Fast streaming, vision support (screenshots â†’ code)</span></div>
                        <div class="ob-box-row"><span class="ob-box-icon">ðŸ†“</span><span>Free on standard plan â€” no billing setup</span></div>
                    </div>
                    <div id="obGeminiForm" style="display:flex;flex-direction:column;gap:8px;">
                        <p class="ob-desc" style="font-size:11px;">
                            Get your key at <a href="https://aistudio.google.com/app/apikey" target="_blank">aistudio.google.com â†—</a>
                            â†’ <b>Create API key</b> â†’ paste below:
                        </p>
                        <input type="password" id="obGeminiKey" class="ob-input"
                            placeholder="AIzaSyâ€¦" autocomplete="off" />
                        <div class="ob-status idle" id="obGeminiStatus">
                            <div class="ob-status-dot"></div>
                            <span id="obGeminiStatusText">Enter key above to validate</span>
                        </div>
                        <div class="ob-btns">
                            <button class="ob-btn purple" onclick="obSaveGemini()">ðŸ’¾ Save & continue</button>
                            <button class="ob-btn" onclick="obGo(4)">Skip</button>
                        </div>
                    </div>
                    <div class="ob-skip" onclick="obGo(4)">I'll configure cloud providers later</div>
                </div>

                <div class="ob-step" id="obStep4">
                    <div class="ob-eyebrow">Quick Reference</div>
                    <div class="ob-h2">ðŸ—ºï¸ The cockpit</div>
                    <p class="ob-desc">Everything you need is in the toolbar below the chat.</p>
                    <div class="ob-shortcuts">
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">ðŸ“Ž <b>File</b> â€” add file to AI context</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">ðŸ§  <b>Think</b> â€” plan before acting</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">âœ¨ <b>Commit</b> â€” AI commit message from diff</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">ðŸ¤– <b>Agent</b> â€” autonomous multi-step tasks</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">ðŸ”´ <b>LSP</b> â€” fix type errors with AI</span>
                            <span class="ob-shortcut-key">click</span>
                        </div>
                        <div class="ob-shortcut">
                            <span class="ob-shortcut-desc">â˜ï¸ <b>Cloud</b> â€” manage API keys</span>
                            <span class="ob-shortcut-key">header</span>
                        </div>
                    </div>
                    <div class="ob-btns" style="margin-top:4px;">
                        <button class="ob-btn cyan" onclick="obGo(5)">Got it â†’</button>
                    </div>
                </div>

                <div class="ob-step" id="obStep5">
                    <div class="ob-celebration">
                        <span class="ob-big-icon" id="obRocket">ðŸ›¸</span>
                        <h3>You're cleared for launch.</h3>
                        <p>Select a model in the top-right corner<br>and start building with your AI co-pilot.</p>
                    </div>
                    <div class="ob-box" style="font-size:11px; line-height:1.8;">
                        <b>Pro tip:</b> Open any file, then ask the AI to explain it.<br>
                        Use <b>ðŸ“Ž File</b> to give it full context of your project.
                    </div>
                    <button class="ob-btn launch" onclick="obFinish()">ðŸš€ Launch Antigravity</button>
                </div>

            </div>
        </div>
    </div>

    <!-- State Injection and Main script -->
    <script>
        window._showOnboarding = ${showOnboarding};
    </script>
    <script src="${scriptUri}"></script>
</body>
</html>`;
    }
}
