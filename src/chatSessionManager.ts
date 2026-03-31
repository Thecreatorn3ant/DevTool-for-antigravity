import * as vscode from 'vscode';

export interface ChatSession {
    id: string;
    title: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
    model: string;
    createdAt: number;
    updatedAt: number;
    systemPrompt?: string;
}

export interface PromptTemplate {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    initialMessage?: string;
    category: 'coding' | 'analysis' | 'writing' | 'custom';
    icon: string;
}

export class ChatSessionManager {
    private _currentSession: ChatSession | null = null;
    private _context: vscode.ExtensionContext;
    private _templates: Map<string, PromptTemplate> = new Map();

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._loadTemplates();
        this._loadLastSession();
    }

    async createNewSession(model: string, systemPrompt?: string): Promise<ChatSession> {
        if (this._currentSession && this._currentSession.messages.length > 0) {
            await this._saveSession(this._currentSession);
        }

        const session: ChatSession = {
            id: this._generateSessionId(),
            title: `Session ${new Date().toLocaleString('fr-FR')}`,
            messages: [],
            model,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            systemPrompt,
        };

        this._currentSession = session;
        await this._context.workspaceState.update('lastSessionId', session.id);

        return session;
    }

    async promptForReset(): Promise<{ reset: boolean; template?: PromptTemplate }> {
        const choice = await vscode.window.showQuickPick([
            {
                label: '$(refresh) Nouveau chat vide',
                description: 'Réinitialiser sans template',
                value: 'empty'
            },
            {
                label: '$(library) Utiliser un template',
                description: 'Démarrer avec un prompt prédéfini',
                value: 'template'
            },
            {
                label: '$(history) Charger une ancienne session',
                description: 'Reprendre une conversation sauvegardée',
                value: 'load'
            },
            {
                label: '$(close) Annuler',
                description: 'Continuer la session actuelle',
                value: 'cancel'
            }
        ], {
            placeHolder: 'Comment souhaitez-vous réinitialiser le chat ?'
        });

        if (!choice || choice.value === 'cancel') {
            return { reset: false };
        }

        if (choice.value === 'empty') {
            return { reset: true };
        }

        if (choice.value === 'template') {
            const template = await this._selectTemplate();
            if (!template) return { reset: false };
            return { reset: true, template };
        }

        if (choice.value === 'load') {
            await this._loadSessionFromHistory();
            return { reset: false };
        }

        return { reset: false };
    }

    private async _selectTemplate(): Promise<PromptTemplate | undefined> {
        const items = Array.from(this._templates.values()).map(t => ({
            label: `${t.icon} ${t.name}`,
            description: t.description,
            template: t
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Sélectionnez un template de prompt'
        });

        return selected?.template;
    }

    private async _loadSessionFromHistory(): Promise<void> {
        const sessions = await this._getAllSessions();

        if (sessions.length === 0) {
            vscode.window.showInformationMessage('Aucune session sauvegardée');
            return;
        }

        const items = sessions.map(s => ({
            label: s.title,
            description: `${s.messages.length} messages • ${new Date(s.updatedAt).toLocaleString('fr-FR')}`,
            detail: `Modèle: ${s.model}`,
            session: s
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Chargez une session sauvegardée'
        });

        if (selected) {
            this._currentSession = selected.session;
            await this._context.workspaceState.update('lastSessionId', selected.session.id);
        }
    }

    async exportSession(): Promise<void> {
        if (!this._currentSession || this._currentSession.messages.length === 0) {
            vscode.window.showWarningMessage('Aucune conversation à exporter');
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`chat-${this._currentSession.id}.json`),
            filters: {
                'JSON': ['json'],
                'Markdown': ['md']
            }
        });

        if (!uri) return;

        const format = uri.fsPath.endsWith('.md') ? 'markdown' : 'json';
        const content = format === 'json'
            ? JSON.stringify(this._currentSession, null, 2)
            : this._sessionToMarkdown(this._currentSession);

        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        vscode.window.showInformationMessage(`✅ Session exportée: ${uri.fsPath}`);
    }

    async importSession(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { 'JSON': ['json'] }
        });

        if (!uris || uris.length === 0) return;

        try {
            const content = await vscode.workspace.fs.readFile(uris[0]);
            const session: ChatSession = JSON.parse(content.toString());

            if (!session.id || !session.messages || !Array.isArray(session.messages)) {
                throw new Error('Format de session invalide');
            }
            session.id = this._generateSessionId();
            session.updatedAt = Date.now();

            await this._saveSession(session);
            this._currentSession = session;

            vscode.window.showInformationMessage(`✅ Session importée: ${session.title}`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Erreur d'import: ${e.message}`);
        }
    }

    addMessage(role: 'user' | 'assistant', content: string): void {
        if (!this._currentSession) {
            throw new Error('Aucune session active');
        }

        this._currentSession.messages.push({
            role,
            content,
            timestamp: Date.now()
        });

        this._currentSession.updatedAt = Date.now();

        if (this._currentSession.messages.length === 2 &&
            this._currentSession.title.startsWith('Session')) {
            this._currentSession.title = this._generateTitle(content);
        }
    }

    getCurrentSession(): ChatSession | null {
        return this._currentSession;
    }

    async getAllSessions(): Promise<ChatSession[]> {
        return this._getAllSessions();
    }

    async loadSession(id: string): Promise<ChatSession | undefined> {
        const sessions = await this._getAllSessions();
        const session = sessions.find(s => s.id === id);
        if (session) {
            this._currentSession = session;
            await this._context.workspaceState.update('lastSessionId', id);
            return session;
        }
        return undefined;
    }

    private _generateSessionId(): string {
        return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    private _generateTitle(firstMessage: string): string {
        const preview = firstMessage.substring(0, 50).trim();
        return preview + (firstMessage.length > 50 ? '...' : '');
    }

    private _sessionToMarkdown(session: ChatSession): string {
        const lines: string[] = [
            `# ${session.title}`,
            '',
            `**Modèle**: ${session.model}`,
            `**Créé le**: ${new Date(session.createdAt).toLocaleString('fr-FR')}`,
            `**Mis à jour le**: ${new Date(session.updatedAt).toLocaleString('fr-FR')}`,
            '',
            '---',
            ''
        ];

        if (session.systemPrompt) {
            lines.push('## Prompt Système', '', session.systemPrompt, '', '---', '');
        }

        for (const msg of session.messages) {
            const label = msg.role === 'user' ? '👤 Utilisateur' : '🤖 Assistant';
            const time = new Date(msg.timestamp).toLocaleTimeString('fr-FR');
            lines.push(`### ${label} (${time})`, '', msg.content, '', '---', '');
        }

        return lines.join('\n');
    }

    private async _saveSession(session: ChatSession): Promise<void> {
        const sessions = await this._getAllSessions();
        const index = sessions.findIndex(s => s.id === session.id);

        if (index >= 0) {
            sessions[index] = session;
        } else {
            sessions.push(session);
        }

        // Garder max 50 sessions
        if (sessions.length > 50) {
            sessions.sort((a, b) => b.updatedAt - a.updatedAt);
            sessions.splice(50);
        }

        await this._context.globalState.update('chatSessions', sessions);
    }

    private async _getAllSessions(): Promise<ChatSession[]> {
        return this._context.globalState.get<ChatSession[]>('chatSessions', []);
    }

    private async _loadLastSession(): Promise<void> {
        const lastId = this._context.workspaceState.get<string>('lastSessionId');
        if (!lastId) return;

        const sessions = await this._getAllSessions();
        const session = sessions.find(s => s.id === lastId);

        if (session) {
            this._currentSession = session;
        }
    }

    private _loadTemplates(): void {
        // Templates par défaut
        const defaults: PromptTemplate[] = [
            {
                id: 'code-review',
                name: 'Code Review Expert',
                description: 'Review de code avec focus sur la qualité et la sécurité',
                systemPrompt: `Tu es un expert en code review. Tu dois :
- Identifier les bugs, vulnérabilités de sécurité et problèmes de performance
- Suggérer des améliorations de clean code
- Vérifier les bonnes pratiques du langage
- Être constructif et pédagogique dans tes retours`,
                initialMessage: 'Je vais te partager du code à reviewer.',
                category: 'coding',
                icon: '🔍'
            },
            {
                id: 'architect',
                name: 'Architecte Logiciel',
                description: 'Conception d\'architecture et patterns',
                systemPrompt: `Tu es un architecte logiciel senior. Tu dois :
- Proposer des architectures scalables et maintenables
- Recommander les meilleurs patterns de design
- Considérer les trade-offs entre différentes approches
- Penser long-terme et évolutivité`,
                category: 'coding',
                icon: '🏗️'
            },
            {
                id: 'debugger',
                name: 'Debugger Expert',
                description: 'Aide au debugging et résolution d\'erreurs',
                systemPrompt: `Tu es un expert en debugging. Tu dois :
- Analyser les stack traces et messages d'erreur
- Proposer des hypothèses sur la cause du bug
- Suggérer des étapes de debugging méthodiques
- Donner des solutions avec explications`,
                category: 'coding',
                icon: '🐛'
            },
            {
                id: 'doc-writer',
                name: 'Rédacteur de Documentation',
                description: 'Création de documentation technique',
                systemPrompt: `Tu es un rédacteur technique spécialisé. Tu dois :
- Écrire une documentation claire et complète
- Inclure des exemples concrets
- Structurer l'information de manière logique
- Adapter le niveau de détail à l'audience`,
                category: 'writing',
                icon: '📝'
            },
            {
                id: 'test-writer',
                name: 'Expert en Tests',
                description: 'Génération de tests unitaires et d\'intégration',
                systemPrompt: `Tu es un expert en testing. Tu dois :
- Générer des tests complets et pertinents
- Couvrir les cas limites et edge cases
- Utiliser les bonnes pratiques de testing
- Écrire des tests maintenables et lisibles`,
                category: 'coding',
                icon: '🧪'
            },
            {
                id: 'refactoring',
                name: 'Refactoring Specialist',
                description: 'Refactoring et amélioration de code existant',
                systemPrompt: `Tu es un spécialiste du refactoring. Tu dois :
- Améliorer la lisibilité et la maintenabilité du code
- Éliminer la duplication et le code mort
- Appliquer les principes SOLID
- Refactorer par étapes incrémentales`,
                category: 'coding',
                icon: '♻️'
            },
            {
                id: 'analyst',
                name: 'Analyste de Données',
                description: 'Analyse de données et insights',
                systemPrompt: `Tu es un analyste de données. Tu dois :
- Analyser les données de manière rigoureuse
- Identifier des patterns et insights
- Visualiser les résultats de manière claire
- Proposer des recommandations actionnables`,
                category: 'analysis',
                icon: '📊'
            }
        ];

        for (const template of defaults) {
            this._templates.set(template.id, template);
        }

        // Charger les templates custom de l'utilisateur
        const custom = this._context.globalState.get<PromptTemplate[]>('customTemplates', []);
        for (const template of custom) {
            this._templates.set(template.id, template);
        }
    }

    async createCustomTemplate(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Nom du template',
            placeHolder: 'Mon Template Custom'
        });

        if (!name) return;

        const description = await vscode.window.showInputBox({
            prompt: 'Description du template',
            placeHolder: 'Ce template sert à...'
        });

        const systemPrompt = await vscode.window.showInputBox({
            prompt: 'Prompt système (instructions pour l\'IA)',
            placeHolder: 'Tu es un expert en...',
            validateInput: (value) => value.length < 10 ? 'Prompt trop court' : null
        });

        if (!systemPrompt) return;

        const template: PromptTemplate = {
            id: `custom_${Date.now()}`,
            name,
            description: description || '',
            systemPrompt,
            category: 'custom',
            icon: '⭐'
        };

        this._templates.set(template.id, template);

        const custom = this._context.globalState.get<PromptTemplate[]>('customTemplates', []);
        custom.push(template);
        await this._context.globalState.update('customTemplates', custom);

        vscode.window.showInformationMessage(`✅ Template "${name}" créé`);
    }

    getTemplate(id: string): PromptTemplate | undefined {
        return this._templates.get(id);
    }

    getAllTemplates(): PromptTemplate[] {
        return Array.from(this._templates.values());
    }
}
