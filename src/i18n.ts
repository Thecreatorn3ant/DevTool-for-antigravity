import * as vscode from 'vscode';

export type Language = 'fr' | 'en';

export interface Translations {
    chat_placeholder: string;
    btn_send: string;
    btn_stop: string;
    tab_chat: string;
    tab_history: string;
    tab_settings: string;
    new_chat: string;
    clear_history: string;
    confirm_clear: string;
    cloud_connect: string;
    local_ai_active: string;
    cloud_ai_active: string;
    offline_mode: string;
    onboarding_title: string;
    onboarding_subtitle: string;
    select_language: string;
    finish: string;
    agent_thinking: string;
    token_usage: string;
    session_loaded: string;
    no_sessions: string;
    delete_session: string;
    confirm_delete: string;
    local_only_prediction: string;
}

const fr: Translations = {
    chat_placeholder: "Posez une question ou demandez une modification...",
    btn_send: "Envoyer",
    btn_stop: "Arrêter",
    tab_chat: "Discussion",
    tab_history: "Historique",
    tab_settings: "Paramètres",
    new_chat: "Nouvel échange",
    clear_history: "Vider l'historique",
    confirm_clear: "Voulez-vous vraiment effacer tout l'historique ?",
    cloud_connect: "Connexion Cloud",
    local_ai_active: "IA Locale Active",
    cloud_ai_active: "IA Cloud Active",
    offline_mode: "Mode Hors-ligne",
    onboarding_title: "Bienvenue sur Antigravity",
    onboarding_subtitle: "Votre assistant de programmation par paire expert.",
    select_language: "Choisissez votre langue",
    finish: "Terminer la configuration",
    agent_thinking: "L'IA réfléchit...",
    token_usage: "Tokens utilisés",
    session_loaded: "Session chargée avec succès",
    no_sessions: "Aucune session trouvée",
    delete_session: "Supprimer",
    confirm_delete: "Supprimer cette session ?",
    local_only_prediction: "Prédiction locale uniquement"
};

const en: Translations = {
    chat_placeholder: "Ask a question or request a code change...",
    btn_send: "Send",
    btn_stop: "Stop",
    tab_chat: "Chat",
    tab_history: "History",
    tab_settings: "Settings",
    new_chat: "New Chat",
    clear_history: "Clear History",
    confirm_clear: "Are you sure you want to clear all history?",
    cloud_connect: "Cloud Connect",
    local_ai_active: "Local AI Active",
    cloud_ai_active: "Cloud AI Active",
    offline_mode: "Offline Mode",
    onboarding_title: "Welcome to Antigravity",
    onboarding_subtitle: "Your expert pair-programming assistant.",
    select_language: "Choose your language",
    finish: "Finish Setup",
    agent_thinking: "AI is thinking...",
    token_usage: "Tokens used",
    session_loaded: "Session loaded successfully",
    no_sessions: "No sessions found",
    delete_session: "Delete",
    confirm_delete: "Delete this session?",
    local_only_prediction: "Local prediction only"
};

export class I18nManager {
    private _currentLanguage: Language = 'fr';

    constructor(private readonly _context: vscode.ExtensionContext) {
        this._currentLanguage = this._context.globalState.get<Language>('antigravity.language', 'fr');
    }

    get language(): Language {
        return this._currentLanguage;
    }

    async setLanguage(lang: Language) {
        this._currentLanguage = lang;
        await this._context.globalState.update('antigravity.language', lang);
    }

    t(key: keyof Translations): string {
        const translations = this._currentLanguage === 'fr' ? fr : en;
        return translations[key];
    }

    getAll(): Translations {
        return this._currentLanguage === 'fr' ? fr : en;
    }
}
