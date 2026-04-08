import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { OllamaClient, ContextFile, ApiKeyStatus, estimateTokens, AttachedImage } from './ollamaClient';
import { FileContextManager } from './fileContextManager';
import { LspDiagnosticsManager } from './lspDiagnosticsManager';
import { AgentRunner, AgentSession } from './agentRunner';
import { ChatSessionManager, PromptTemplate } from './chatSessionManager';
import { CommitManager } from './commitManager';
import { I18nManager } from './i18n';

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

function parseAgentTags(response: string): {
    readFiles: string[];
    searches: string[];
} {
    const readFiles: string[] = [];
    const searches: string[] = [];

    const readFileRegex = /\[READ_FILE:\s*([^\]]+)\]/g;
    let m;
    while ((m = readFileRegex.exec(response)) !== null) {
        readFiles.push(m[1].trim());
    }

    const searchRegex = /\[SEARCH:\s*([^\]]+)\]/g;
    while ((m = searchRegex.exec(response)) !== null) {
        searches.push(m[1].trim());
    }

    return { readFiles, searches };
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
    private readonly _commitManager: CommitManager;

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _ollamaClient: OllamaClient,
        private readonly _fileCtxManager: FileContextManager,
        sessionManager: ChatSessionManager,
        commitManager: CommitManager,
        private readonly _i18n: I18nManager
    ) {
        this._sessionManager = sessionManager;
        this._commitManager = commitManager;
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
                    if (data.language) {
                        await this._i18n.setLanguage(data.language);
                    }
                    await this._context.globalState.update('antigravity.onboardingComplete', true);
                    // Reload webview to apply language
                    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, false);
                    break;
                case 'setupGeminiKey':
                    if (data.key) {
                        await this._ollamaClient.addApiKey({
                            name: 'Google Gemini (Onboarding)',
                            url: 'https://generativelanguage.googleapis.com/v1beta',
                            key: data.key
                        });
                        vscode.window.showInformationMessage('âÅ“… Clé Gemini configurée avec succès !');
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
                    vscode.window.showInformationMessage(`âÅ“… ${data.summary}`);
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
                case 'getSettings': {
                    const settings = {
                        contextMult: this._context.workspaceState.get<number>('contextMultiplier', 1),
                        maxTokens: this._context.workspaceState.get<number>('maxTokensLimit', 32000)
                    };
                    webviewView.webview.postMessage({ type: 'settingsData', settings });
                    break;
                }
                case 'saveSettings':
                    if (data.settings) {
                        await this._context.workspaceState.update('contextMultiplier', data.settings.contextMult);
                        await this._context.workspaceState.update('maxTokensLimit', data.settings.maxTokens);
                        this._showNotification('Paramètres mis à jour.', 'success');
                    }
                    break;
                case 'getHistoryList': {
                    const sessions = await this._sessionManager.getAllSessions();
                    const sessionData = sessions.map((s: any) => ({
                        id: s.id,
                        timestamp: s.updatedAt,
                        model: s.model,
                        preview: s.messages.find((m: any) => m.role === 'user')?.content.substring(0, 60) || 'Nouvelle discussion'
                    }));
                    webviewView.webview.postMessage({ type: 'historyList', sessions: sessionData });
                    break;
                }
                case 'loadSession':
                    if (data.id) {
                        const session = await this._sessionManager.loadSession(data.id);
                        if (session) {
                            this._history = session.messages.map((m: any) => ({
                                role: (m.role === 'assistant' ? 'ai' : 'user') as 'user' | 'ai',
                                value: m.content
                            }));
                            webviewView.webview.postMessage({ type: 'restoreHistory', history: this._history });
                            this._showNotification(this._i18n.t('session_loaded'), 'success');
                        }
                    }
                    break;
                case 'deleteSession':
                    if (data.id) {
                        await this._sessionManager.deleteSession(data.id);
                        this._showNotification('Session supprimée.', 'success');
                        const sessions = await this._sessionManager.getAllSessions();
                        const sessionData = sessions.map((s: any) => ({
                            id: s.id,
                            timestamp: s.updatedAt,
                            model: s.model,
                            preview: s.messages.find((m: any) => m.role === 'user')?.content.substring(0, 60) || 'Nouvelle discussion'
                        }));
                        webviewView.webview.postMessage({ type: 'historyList', sessions: sessionData });
                    }
                    break;
                case 'setLanguage':
                    if (data.value) {
                        await this._i18n.setLanguage(data.value);
                        // Refresh with new texts
                        webviewView.webview.postMessage({
                            type: 'languageChanged',
                            lang: data.value,
                            translations: this._i18n.getAll()
                        });
                    }
                    break;
            }
        });
    }

    private _showNotification(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
        this._view?.webview.postMessage({ type: 'notification', message, notificationType: type });
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

        const multiplier = this._context.workspaceState.get<number>('contextMultiplier', 1);
        const maxTokens = this._context.workspaceState.get<number>('maxTokensLimit', 32000);

        const budget = await this._ollamaClient.getTokenBudgetAsync(resolvedModel, resolvedUrl || undefined, multiplier, maxTokens);

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

        const agentInstructions = `
[DISPOSITIFS AGENTIQUES ACTIVÉS]
Tu es un expert en exploration de base de code. Si tu as besoin de plus d'informations pour répondre :
- Analyse la [STRUCTURE] ci-dessous.
- Utilise [READ_FILE: chemin/relatif] pour lire un fichier et analyser ses imports.
- Utilise [SEARCH: terme] pour trouver des fichiers par nom.
Tu peux effectuer jusqu'à 5 actions autonomes par message. Reste focalisé sur l'objectif de l'utilisateur.

`;

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

        const finalPrompt = agentInstructions + thinkPrefix + userMsg;

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

            let currentIteration = 0;
            const MAX_ITERATIONS = 5;
            let lastResponse = fullRes;

            while (currentIteration < MAX_ITERATIONS) {
                const agentTags = parseAgentTags(lastResponse);
                if (agentTags.readFiles.length === 0 && agentTags.searches.length === 0) break;

                currentIteration++;
                this._view.webview.postMessage({ type: 'agentLoopStart', iteration: currentIteration });

                let explorationContext = "";

                for (const filePath of agentTags.readFiles) {
                    this._view.webview.postMessage({ type: 'agentStep', status: 'running', stepType: 'read_file', description: `Lecture de ${filePath}` });
                    const file = await this._fileCtxManager.handleAiFileRequest(filePath, 'allow-all'); // Using allow-all for fluid experience as discussed
                    if (file) {
                        this.addFilesToContext([file]);
                        explorationContext += `\n[CONTENU DE ${file.name}]\n${file.content}\n`;
                        this._view.webview.postMessage({ type: 'agentStep', status: 'done', stepType: 'read_file', description: `Lu ${file.name}`, output: `Taille: ${file.content.length} chars` });
                    } else {
                        explorationContext += `\n[ERREUR] Impossible de lire ${filePath}\n`;
                        this._view.webview.postMessage({ type: 'agentStep', status: 'failed', stepType: 'read_file', description: `Erreur lecture ${filePath}` });
                    }
                }

                for (const query of agentTags.searches) {
                    this._view.webview.postMessage({ type: 'agentStep', status: 'running', stepType: 'fix_diagnostics', description: `Recherche de "${query}"` });
                    const results = await this._fileCtxManager.searchFiles(query);
                    explorationContext += `\n[RÉSULTATS DE RECHERCHE POUR "${query}"]\n${results.join('\n') || 'Aucun résultat'}\n`;
                    this._view.webview.postMessage({ type: 'agentStep', status: 'done', stepType: 'fix_diagnostics', description: `Recherche terminée`, output: `${results.length} fichiers trouvés` });
                }

                this._view.webview.postMessage({ type: 'startResponse', isContinuing: true });
                let nextRes = "";

                await this._ollamaClient.generateStreamingResponse(
                    "Continue ton analyse avec ces nouvelles informations.",
                    fullContext + "\n\n[NOUVELLES INFORMATIONS D'EXPLORATION]\n" + explorationContext,
                    (chunk) => {
                        nextRes += chunk;
                        this._view?.webview.postMessage({ type: 'partialResponse', value: chunk });
                    },
                    resolvedModel,
                    resolvedUrl || undefined,
                    undefined,
                    'chat',
                    '',
                    this._currentAbortController?.signal
                );

                this._history.push({ role: 'ai', value: nextRes });
                this._updateHistory();
                this._view.webview.postMessage({ type: 'endResponse', value: nextRes });
                await this._processAiResponse(nextRes);
                lastResponse = nextRes;
            }

        } catch (e: any) {
            if (e.name === 'AbortError') {
                this._history.push({
                    role: 'ai',
                    value: 'âÅ¡Â ïÂ¸Â Génération arrêtée par l\'utilisateur.'
                });
                this._updateHistory();
                this._view.webview.postMessage({
                    type: 'endResponse',
                    value: 'âÅ¡Â ïÂ¸Â Génération arrêtée par l\'utilisateur.'
                });
            } else {
                const msg = e?.message ?? String(e);
                const is403 = msg.includes('403') || msg.includes('PERMISSION_DENIED');
                const is404 = msg.includes('404') || msg.includes('not found');
                const isRateLimit = msg.includes('429') || msg.includes('rate limit');

                let errorMessage = '';

                if (is403) {
                    errorMessage = `âÂÅ’ **Erreur 403 - Accès refusé**\n\nLa requête a été refusée par le serveur.\n\n**Solutions :**\n1. Vérifiez votre clé API dans les paramètres (âËœÂïÂ¸Â Cloud)\n2. Essayez un autre modèle\n\n_Détails : ${msg}_`;
                } else if (is404) {
                    errorMessage = `âÂÅ’ **Erreur 404 - Modèle introuvable**\n\nLe modèle demandé n'existe pas ou n'est plus disponible.\n\n_Détails : ${msg}_`;
                } else if (isRateLimit) {
                    errorMessage = `âÅ¡Â ïÂ¸Â **Erreur 429 - Limite de requêtes atteinte**\n\nVous avez atteint la limite de requêtes autorisées.\n\n_Détails : ${msg}_`;
                } else {
                    errorMessage = `âÂÅ’ **Erreur lors de la génération**\n\n\`\`\`\n${msg}\n\`\`\``;
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
                    'âÅ“… Créer', 'âÂÅ’ Ignorer'
                );
                if (answer === 'âÅ“… Créer') {
                    await this._handleFileCreation(cf.name, cf.content);
                }
            }
        }

        for (const filePath of parsed.deleteFiles) {
            if (this._fileCtxManager.isInWorkspace(filePath)) {
                await this._handleFileDeletion(filePath);
            } else {
                const answer = await vscode.window.showInformationMessage(
                    `âÅ¡Â ïÂ¸Â L'IA veut SUPPRIMER : "${filePath}" (hors workspace). Confirmer ?`,
                    { modal: true },
                    '🗑️ Supprimer', 'âÂÅ’ Annuler'
                );
                if (answer === '🗑️ Supprimer') {
                    await this._handleFileDeletion(filePath);
                }
            }
        }

        if (parsed.projectSummary) {
            await this._fileCtxManager.saveProjectSummary(parsed.projectSummary);
            this._showNotification('âÅ“… Mémoire du projet mise à jour', 'success');
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
                    '📋 Appliquer', '👁 Voir fichier par fichier', 'âÂÅ’ Ignorer'
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
            this._showNotification(`âÅ“… ${applied} fichier(s) modifié(s)`, 'success');
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
            detail: `${s.statusLabel}  Ã‚·  Ajouté ${s.entry.addedAt ? new Date(s.entry.addedAt).toLocaleDateString('fr-FR') : 'N/A'}`,
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
            title: 'âËœÂïÂ¸Â Gestion des clés API Cloud',
            placeHolder: statuses.length === 0 ? 'Aucune clé configurée â€â€ ajoutez-en une' : 'Sélectionner un compte ou gérer les clés',
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
                    `âÅ¡Â ïÂ¸Â "${entry.name}" est en cooldown encore ${status.cooldownSecsLeft}s. Utiliser quand même ?`,
                    'Utiliser quand même', 'Réinitialiser le cooldown', 'Annuler'
                );
                if (!choice || choice === 'Annuler') return;
                if (choice === 'Réinitialiser le cooldown') {
                    await this._ollamaClient.resetKeyCooldown(entry.key, entry.url);
                    vscode.window.showInformationMessage(`âÅ“… Cooldown réinitialisé pour "${entry.name}".`);
                }
            }
            await this._updateModelsList(entry.url, entry.key);
        }
    }

    private async _handleAddKey() {
        const name = await vscode.window.showInputBox({
            title: 'Ajouter un provider â€â€ 1/3',
            prompt: 'Nom du provider',
            placeHolder: 'ex: OpenAI perso, Ollama VPS, OpenRouter #2â€Â¦',
            ignoreFocusOut: true,
        });
        if (!name) return;

        interface UrlPreset extends vscode.QuickPickItem {
            description: string;
            needsKey: boolean;
        }
        const PRESET_URLS: UrlPreset[] = [
            { label: 'âËœÂïÂ¸Â Ollama Cloud (ollama.com)', description: 'https://api.ollama.com', needsKey: true, detail: 'Clé API sur ollama.com/settings' },
            { label: 'âÅ¡Â¡ Ollama auto-hébergé (sans clé)', description: '', needsKey: false, detail: 'Serveur Ollama local ou VPS' },
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
            { label: 'Autre / PersonnalisÃƒÂ©â€Â¦', description: '', needsKey: true, detail: 'Entrer une URL manuellement' },
        ];

        const urlPick = await vscode.window.showQuickPick(PRESET_URLS, {
            title: 'Ajouter un provider â€â€ 2/3',
            placeHolder: 'Choisir le type de provider',
            matchOnDetail: true,
        });
        if (!urlPick) return;

        let url = urlPick.description;
        if (!url) {
            const isOllama = urlPick.label.startsWith('âÅ¡Â¡');
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
            title: 'Ajouter un provider â€â€ 3/3',
            prompt: keyRequired ? `Clé API pour "${name}"` : `Clé API pour "${name}" (optionnelle)`,
            placeHolder: keyRequired ? 'sk-â€Â¦' : '(optionnel)',
            password: true,
            ignoreFocusOut: true,
        });
        if (key === undefined) return;

        const result = await this._ollamaClient.addApiKey({ name, url, key: key || '' });
        if (!result.success) {
            vscode.window.showWarningMessage(`âÅ¡Â ïÂ¸Â ${result.reason}`);
            return;
        }

        vscode.window.showInformationMessage(`âÅ“… Provider "${name}" ajouté.`);
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
            detail: s.statusLabel + (s.entry.key ? `  Ã‚·  Clé: ${s.entry.key.substring(0, 8)}Ã‚·Ã‚·Ã‚·Ã‚·Ã‚·Ã‚·Ã‚·Ã‚·` : ''),
            statusIdx: i,
        }));

        const picked = await vscode.window.showQuickPick(items, {
            title: '🔑 Gérer les clés â€â€ Sélectionner une clé',
            placeHolder: 'Choisir la clé à modifier',
        });
        if (!picked) return;

        const target = statuses[picked.statusIdx];
        await this._handleKeyActions(target);
    }

    private async _handleKeyActions(target: ApiKeyStatus) {
        const entry = target.entry;
        const actions: vscode.QuickPickItem[] = [
            { label: 'âÅ“ÂïÂ¸Â  Renommer', description: `Nom actuel : "${entry.name}"` },
            { label: '🔑  Changer la clé API', description: `Clé actuelle : ${entry.key.substring(0, 8)}Ã‚·Ã‚·Ã‚·Ã‚·Ã‚·` },
            ...(target.status === 'cooldown' ? [{ label: '🔄  Réinitialiser le cooldown', description: `Restant : ${target.cooldownSecsLeft}s` }] : []),
            { label: '🗑️ïÂ¸Â  Supprimer cette clé', description: `"${entry.name}" â€â€ ${entry.url}` },
            { label: 'ââ€ Â©ïÂ¸Â  Retour' },
        ];

        const action = await vscode.window.showQuickPick(actions, { title: `âÅ¡â„¢ïÂ¸Â Actions â€â€ ${entry.name}` });
        if (!action || action.label === 'ââ€ Â©ïÂ¸Â  Retour') { await this._handleManageKeys(); return; }

        if (action.label.startsWith('âÅ“ÂïÂ¸Â')) {
            const newName = await vscode.window.showInputBox({ prompt: 'Nouveau nom', value: entry.name, ignoreFocusOut: true });
            if (!newName || newName === entry.name) return;
            await this._ollamaClient.updateApiKey(entry.key, entry.url, { name: newName });
            this._showNotification(`âÅ“… Renommé en "${newName}"`, 'success');
        } else if (action.label.startsWith('🔑')) {
            const newKey = await vscode.window.showInputBox({ prompt: `Nouvelle clé API pour "${entry.name}"`, placeHolder: 'sk-â€Â¦', password: true, ignoreFocusOut: true });
            if (!newKey) return;
            await this._ollamaClient.deleteApiKey(entry.key, entry.url);
            await this._ollamaClient.addApiKey({ name: entry.name, url: entry.url, key: newKey, platform: entry.platform });
            this._showNotification(`âÅ“… Clé mise à jour pour "${entry.name}"`, 'success');
            await this._updateModelsList(entry.url, newKey);
        } else if (action.label.startsWith('🔄')) {
            await this._ollamaClient.resetKeyCooldown(entry.key, entry.url);
            this._showNotification(`âÅ“… Cooldown réinitialisé â€â€ "${entry.name}" disponible`, 'success');
        } else if (action.label.startsWith('🗑️ïÂ¸Â')) {
            const confirm = await vscode.window.showWarningMessage(
                `Supprimer la clé "${entry.name}" ? Cette action est irréversible.`,
                { modal: true }, '🗑️ïÂ¸Â Supprimer', 'Annuler'
            );
            if (confirm !== '🗑️ïÂ¸Â Supprimer') return;
            await this._ollamaClient.deleteApiKey(entry.key, entry.url);
            this._showNotification(`🗑️ïÂ¸Â Clé "${entry.name}" supprimée`, 'info');
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
                local: 'âÅ¡Â¡', lmstudio: 'Ã°Å¸â€™»', gemini: 'âÅ“Â¦', openai: 'ââ€”Ë†', openrouter: 'ââ€”Å½',
                together: 'ââ€”â€°', mistral: 'ââ€”â€ ', groq: 'ââ€“Â¸', anthropic: 'ââ€”Ë†',
                deepseek: 'ââ€”â€°', cohere: 'ââ€”Ë†', perplexity: 'ââ€”Å½', xai: 'ââ€”Ë†',
                fireworks: 'âÅ¡Â¡', 'ollama-cloud': 'âËœÂïÂ¸Â'
            };
            const formattedModels: Array<{ label: string; value: string; name: string; url: string; isLocal: boolean; provider: string }> = allModels.map(m => ({
                label: `${PROVIDER_ICONS[m.provider] || 'âËœÂïÂ¸Â'} ${m.name}`,
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
                                formattedModels.push({ label: `âËœÂïÂ¸Â  ${m}`, value: val, name: m, url: tmpKey.url, isLocal: false, provider: 'ollama-cloud' });
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
            this._showNotification(`âÅ“… Fichier créé : ${fileName}`, 'success');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Erreur création : ${e.message}`);
        }
    }

    private async _handleFileDeletion(fileName: string) {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
        const uri = vscode.Uri.file(path.join(folder, fileName));
        try {
            await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
            this._showNotification(`🗑️ Fichier supprimé : ${fileName}`, 'info');
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

        let result = 'âÅ“… Accepter';
        if (!autoAccept) {
            result = await vscode.window.showInformationMessage(
                patchCount > 0
                    ? `Appliquer ${patchCount} modification(s) à "${path.basename(uri.fsPath)}" ?`
                    : `Aucune modification SEARCH/REPLACE trouvée. Remplacer tout le fichier ?`,
                { modal: false },
                'âÅ“… Accepter', 'âÂÅ’ Rejeter'
            ) || 'âÂÅ’ Rejeter';
        }

        ChatViewProvider._previewProvider.delete(previewUri);

        if (result === 'âÅ“… Accepter') {
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
            const detail = patchCount > 0 ? `${patchCount} patch(s) â€Â¢ Ligne ${firstChangedLine}` : 'Fichier remplacé';
            this._showNotification(`âÅ“… ${fileName}: ${detail}`, 'success');

            setTimeout(async () => {
                const report = this._lspManager.getSnapshot('active');
                if (report.errorCount > 0) {
                    const ans = await vscode.window.showErrorMessage(
                        `âÅ¡Â ïÂ¸Â Des erreurs ont été détectées après l'application du code à "${fileName}". Voulez-vous que l'IA tente de les corriger ?`,
                        '🤖 Corriger avec l\'IA', 'âÂÅ’ Ignorer'
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
                `${isImportant ? 'âÅ¡Â ïÂ¸Â Commande importante' : 'Ã°Å¸â€™» Terminal'} â€â€ Exécuter : \`${cmd}\``,
                { modal: isImportant },
                'Ã°Å¸Å¡€ Exécuter', 'âÂÅ’ Refuser'
            );
            shouldRun = answer === 'Ã°Å¸Å¡€ Exécuter';
            this._view?.webview.postMessage({ type: 'terminalCommand', cmd, status: shouldRun ? 'accepted' : 'refused' });
        }

        if (shouldRun) {
            const t = vscode.window.activeTerminal ?? vscode.window.createTerminal('Antigravity AI');
            t.show();
            t.sendText(cmd);
        }
    }

    private async _handleGenerateCommitMessage() {
        const lastUserMsgs = this._history
            .filter(m => m.role === 'user')
            .slice(-2)
            .map(m => m.value)
            .join('\n');

        await this._commitManager.generateAndShowCommitUI(lastUserMsgs || null);
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
                ? "👁 Surveillance LSP activée â€â€ l'IA sera notifiée des nouvelles erreurs."
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
        const bgUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'background.png'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.css'));
        const cspSource = webview.cspSource;
        const t = this._i18n.getAll();
        const lang = this._i18n.language;

        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src *; img-src ${cspSource} data:; style-src 'unsafe-inline' https://fonts.googleapis.com ${cspSource}; font-src https://fonts.gstatic.com; script-src 'unsafe-inline' ${cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}">
    <style>
        .space-bg { background-image: url('${bgUri}'); }
    </style>
</head>
<body class="lang-${lang}">
    <div class="space-bg"></div>
    
    <div class="app-container">
        <!-- Main Header -->
        <header class="main-header">
            <div class="header-left">
                <span class="brand">ANTIGRAVITY</span>
                <span class="version">v0.4.0</span>
            </div>
            <div class="header-right">
                <button id="btnNewChat" class="icon-btn" title="${t.new_chat}">➕</button>
                <div class="lang-selector">
                    <button id="btnLang" class="lang-btn">${lang.toUpperCase()}</button>
                </div>
                <div id="modelComboWrap">
                    <div id="modelComboBox">
                        <input id="modelSearch" type="text" placeholder="Select Model..." autocomplete="off" spellcheck="false">
                        <span id="modelComboArrow">▾</span>
                    </div>
                    <div id="modelDropdown"></div>
                    <select id="modelSelect" style="display:none"></select>
                </div>
            </div>
        </header>

        <!-- Provider Status Banner -->
        <div id="localWarn"></div>

        <!-- Main Content Area (Tabs) -->
        <main class="tabs-content">
            <!-- Chat Tab -->
            <section id="tab-chat" class="tab-pane active">
                <div id="tokenBar"></div>
                <div id="filesBar"></div>
                <div id="chatWrap">
                    <div id="chat"></div>
                    <button id="scrollBtn" title="Scroll to bottom">↓</button>
                </div>
                
                <div id="terminalLog"></div>
                
                <div id="agentPanel" style="display:none">
                    <div id="agentHeader">
                        <span id="agentGoalLabel">🤖 Agent</span>
                        <button id="agentStopBtn">⏹ Stop</button>
                    </div>
                    <div id="agentSteps"></div>
                </div>

                <div id="lspPanel" style="display:none">
                    <div id="lspHeader">
                        <span id="lspSummary">🔴 LSP</span>
                        <button id="btnCloseLsp">✕</button>
                    </div>
                    <div id="lspContent"></div>
                    <div id="lspActions">
                        <button id="btnLspAi">🤖 Solve with AI</button>
                    </div>
                </div>

                <div class="input-area">
                    <div class="input-actions-scroll">
                        <div class="input-actions">
                            <button class="btn-action" id="btnAddFile" title="Add file">📎</button>
                            <button class="btn-action" id="btnThink" title="Think Mode">🧠</button>
                            <button class="btn-action" id="btnGitReview" title="Review Changes">📝</button>
                            <button class="btn-action" id="btnAgent" title="AI Agent">🤖</button>
                            <button class="btn-action" id="btnLsp" title="LSP Analysis">🔴</button>
                            <select id="termPermSelect">
                                <option value="ask-all">💻 Ask</option>
                                <option value="ask-important">⚠️ Warn</option>
                                <option value="allow-all">🚀 Auto</option>
                            </select>
                        </div>
                    </div>
                    <div class="input-row">
                        <textarea id="prompt" placeholder="${t.chat_placeholder}" rows="1"></textarea>
                        <button id="send">${t.btn_send}</button>
                        <button id="stop" style="display:none;">${t.btn_stop}</button>
                    </div>
                </div>
            </section>

            <!-- History Tab -->
            <section id="tab-history" class="tab-pane">
                <div class="tab-header">
                    <h2>${t.tab_history}</h2>
                    <button id="btnRefreshHistory" class="text-btn">🔄</button>
                </div>
                <div id="historyList" class="scrollable-list">
                    <div class="loading-spinner"></div>
                </div>
            </section>

            <!-- Settings Tab -->
            <section id="tab-settings" class="tab-pane">
                <div class="tab-header">
                    <h2>${t.tab_settings}</h2>
                </div>
                <div class="settings-list">
                    <div class="setting-group">
                        <h3>AI Providers</h3>
                        <div class="setting-item">
                            <label>Local AI (Ollama/LM Studio)</label>
                            <div class="toggle-switch">
                                <input type="checkbox" id="toggleLocal" checked>
                                <span class="slider"></span>
                            </div>
                        </div>
                        <div class="setting-item">
                            <label>Cloud AI (Gemini/OpenAI)</label>
                            <div class="toggle-switch">
                                <input type="checkbox" id="toggleCloud" checked>
                                <span class="slider"></span>
                            </div>
                        </div>
                    </div>

                    <div class="setting-group">
                        <h3>Coding Assistant</h3>
                        <div class="setting-item">
                            <label>${t.local_only_prediction}</label>
                            <div class="toggle-switch">
                                <input type="checkbox" id="toggleLocalPrediction" checked>
                                <span class="slider"></span>
                            </div>
                        </div>
                        <div class="setting-item">
                            <label>Context Multiplier</label>
                            <input type="range" id="settingContextMult" min="0.5" max="4" step="0.1" value="1">
                            <span id="multValue">1.0x</span>
                        </div>
                    </div>

                    <div class="setting-group">
                        <h3>Language</h3>
                        <div class="setting-item">
                            <label>Application Language</label>
                            <select id="selectLang">
                                <option value="fr" ${lang === 'fr' ? 'selected' : ''}>Français</option>
                                <option value="en" ${lang === 'en' ? 'selected' : ''}>English</option>
                            </select>
                        </div>
                    </div>
                    
                    <button id="btnSaveSettings" class="primary-btn">${t.finish}</button>
                </div>
            </section>
        </main>

        <!-- Bottom Navigation -->
        <nav class="bottom-nav">
            <button class="nav-item active" data-tab="chat">
                <span class="nav-icon">💬</span>
                <span class="nav-label">${t.tab_chat}</span>
            </button>
            <button class="nav-item" data-tab="history">
                <span class="nav-icon">📜</span>
                <span class="nav-label">${t.tab_history}</span>
            </button>
            <button class="nav-item" data-tab="settings">
                <span class="nav-icon">⚙️</span>
                <span class="nav-label">${t.tab_settings}</span>
            </button>
        </nav>
    </div>

    <!-- Onboarding Overlay -->
    <div id="obOverlay" style="${showOnboarding ? 'display:flex' : 'display:none'}">
        <div id="obBg"></div>
        <canvas id="obCanvas"></canvas>
        <div id="obCard">
            <div class="ob-hdr">
                <h2 class="ob-title">Antigravity</h2>
                <p class="ob-sub">Mission Briefing : Configurez votre copilote IA en 60 secondes.</p>
            </div>
            <div class="ob-body">
                <!-- STEP 1: Language -->
                <div id="ob-step-1" class="ob-step active">
                    <div class="ob-section">
                        <div class="ob-section-title">🌐 Configuration</div>
                        <p>Choisissez votre langue de prédilection pour l'interface :</p>
                        <div class="lang-btns">
                            <button onclick="setLang('fr'); setObStep(2)" class="ob-btn ${lang === 'fr' ? 'cyan' : ''}">🇫🇷 Français</button>
                            <button onclick="setLang('en'); setObStep(2)" class="ob-btn ${lang === 'en' ? 'cyan' : ''}">🇺🇸 English</button>
                        </div>
                    </div>
                </div>

                <!-- STEP 2: Cloud AI (Gemini) -->
                <div id="ob-step-2" class="ob-step">
                    <div class="ob-section">
                        <div class="ob-section-title">✨ Google Gemini (Recommandé)</div>
                        <p>Le tier gratuit le plus généreux : <b>1M de tokens</b> de contexte, gratuit, sans carte bancaire.</p>
                        
                        <div class="ob-input-group">
                            <input type="password" id="obGeminiKey" class="ob-input" placeholder="Collez votre clé API Gemini ici...">
                            <p style="font-size: 11px; margin-top: 8px; color: var(--text-muted)">Obtenez une clé gratuite sur <a href="https://aistudio.google.com/" target="_blank">AI Studio</a></p>
                        </div>

                        <div class="ob-nav-footer">
                            <button onclick="setObStep(1)" class="ob-btn secondary">Retour</button>
                            <button onclick="saveGeminiKey()" class="ob-btn primary">Enregistrer & Continuer</button>
                            <button onclick="setObStep(3)" class="ob-btn secondary">Plus tard</button>
                        </div>
                    </div>
                </div>

                <!-- STEP 3: Quick Reference -->
                <div id="ob-step-3" class="ob-step">
                    <div class="ob-section">
                        <div class="ob-section-title">🚀 Guide de pilotage</div>
                        
                        <div class="ob-feature-item">
                            <div class="ob-feature-icon">📎</div>
                            <div class="ob-feature-text">
                                <div class="ob-feature-label">Contexte Fichiers</div>
                                <div class="ob-feature-desc">Ajoutez des fichiers au chat pour une analyse précise.</div>
                            </div>
                        </div>

                        <div class="ob-feature-item">
                            <div class="ob-feature-icon">🧠</div>
                            <div class="ob-feature-text">
                                <div class="ob-feature-label">Mode Réflexion</div>
                                <div class="ob-feature-desc">L'IA planifie avant de coder pour de meilleurs résultats.</div>
                            </div>
                        </div>

                        <div class="ob-feature-item">
                            <div class="ob-feature-icon">🤖</div>
                            <div class="ob-feature-text">
                                <div class="ob-feature-label">Agent Autonome</div>
                                <div class="ob-feature-desc">Laissez l'IA explorer et modifier votre projet seule.</div>
                            </div>
                        </div>
                    </div>

                    <div class="ob-nav-footer">
                        <button onclick="setObStep(2)" class="ob-btn secondary">Retour</button>
                        <button onclick="setObStep(4)" class="ob-btn primary">Compris !</button>
                    </div>
                </div>

                <!-- STEP 4: Launch -->
                <div id="ob-step-4" class="ob-step">
                    <div class="ob-section" style="text-align: center; padding: 40px 20px;">
                        <div style="font-size: 50px; margin-bottom: 20px;">🛸</div>
                        <h3 style="color: var(--primary); margin-bottom: 10px;">Paré au décollage !</h3>
                        <p>Sélectionnez un modèle en haut à droite pour commencer.</p>
                    </div>
                    <button class="ob-btn launch" onclick="obFinish()">Démarrer Antigravity 🚀</button>
                </div>
            </div>
        </div>
    </div>

    <script src="${scriptUri}"></script>
    <script>
        window.I18N = ${JSON.stringify(t)};
        window.LANG = "${lang}";
        function setLang(l) { 
            vscode.postMessage({ type: 'setLanguage', value: l }); 
        }
    </script>
</body>
</html>`;
    }
}
