import * as vscode from 'vscode';
import { ProviderRouter, TaskType, FREE_MODELS } from './providerRouter';

import {
    isLocalUrl,
    localStream,
    listLocalModels,
    checkLocalConnection,
    getLocalMaxChars,
    getLocalContextSize,
} from './localProvider';

import {
    isCloudUrl,
    cloudStream,
    detectProviderName,
    listGeminiModels,
    listOpenAICompatModels,
} from './cloudProvider';

export interface ApiKeyEntry {
    key: string;
    name: string;
    url: string;
    platform?: string;
    rateLimitedUntil?: number;
    addedAt?: number;
}

export type ApiKeyStatusCode = 'available' | 'cooldown' | 'no-key';
export interface ApiKeyStatus {
    entry: ApiKeyEntry;
    status: ApiKeyStatusCode;
    cooldownSecsLeft?: number;
    statusIcon: string;
    statusLabel: string;
}

export interface ContextFile {
    name: string;
    content: string;
    isActive?: boolean;
}

export interface TokenBudget {
    used: number;
    max: number;
    isCloud: boolean;
}

export interface AttachedImage {
    base64: string;
    mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    width?: number;
    height?: number;
    label?: string;
}

export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

const VISION_MODELS: Record<string, string[]> = {
    'gemini': ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
    'openai': ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    'openrouter': ['google/gemini-flash-1.5', 'openai/gpt-4o-mini', 'anthropic/claude-3-haiku'],
    'anthropic': ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    'local': ['llava', 'bakllava', 'llava-phi3', 'moondream', 'llava-llama3'],
};

function isVisionModel(model: string, provider: string): boolean {
    const m = model.toLowerCase();
    const list = VISION_MODELS[provider] || [];
    if (list.some(v => m.includes(v.toLowerCase()))) return true;
    return m.includes('vision') || m.includes('llava') || m.includes('4o') ||
        m.includes('gemini') || m.includes('claude-3') || m.includes('moondream');
}

function migrateKeyEntry(raw: any): ApiKeyEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const key = raw.key || '';
    if (!key) return null;
    return {
        key,
        name: raw.name || raw.label || 'Clé sans nom',
        url: raw.url || '',
        platform: raw.platform,
        rateLimitedUntil: raw.rateLimitedUntil,
        addedAt: raw.addedAt || Date.now(),
    };
}

export class OllamaClient {
    readonly router: ProviderRouter;

    constructor() {
        this.router = new ProviderRouter();
        this.router.registerProvider('http://localhost:11434', 'Ollama Local', 'local');
        this._syncProvidersToRouter();
    }

    private _getConfig() { return vscode.workspace.getConfiguration('local-ai'); }
    private _getBaseUrl(): string { return this._getConfig().get<string>('ollamaUrl') || 'http://localhost:11434'; }

    _detectProvider(url: string): string { return detectProviderName(url); }
    isCloud(url?: string): boolean { return isCloudUrl(url || this._getBaseUrl()); }

    _syncProvidersToRouter() {
        for (const entry of this.getApiKeys()) {
            if (!entry.url) continue;
            this.router.registerProvider(entry.url, entry.name, this._detectProvider(entry.url), entry.key);
            if (entry.rateLimitedUntil && entry.rateLimitedUntil > Date.now()) {
                this.router.reportRateLimit(entry.url, entry.rateLimitedUntil - Date.now(), entry.key);
            }
        }
    }

    getApiKeys(): ApiKeyEntry[] {
        const raw = this._getConfig().get<any[]>('apiKeys') || [];
        return raw.map(migrateKeyEntry).filter((k): k is ApiKeyEntry => k !== null);
    }

    private async _saveApiKeys(keys: ApiKeyEntry[]): Promise<void> {
        await this._getConfig().update('apiKeys', keys, vscode.ConfigurationTarget.Global);
    }

    async addApiKey(entry: Omit<ApiKeyEntry, 'addedAt'>): Promise<{ success: boolean; reason?: string }> {
        if (!entry.url) return { success: false, reason: 'Une URL est requise.' };
        const keys = this.getApiKeys();
        if (keys.find(k => k.url === entry.url && k.key === entry.key)) {
            return { success: false, reason: 'Ce provider avec cette clé est déjà configuré.' };
        }
        keys.push({ ...entry, addedAt: Date.now() });
        await this._saveApiKeys(keys);
        this.router.registerProvider(entry.url, entry.name, this._detectProvider(entry.url), entry.key);
        return { success: true };
    }

    async updateApiKey(keyValue: string, url: string, updates: Partial<Omit<ApiKeyEntry, 'key' | 'addedAt'>>): Promise<void> {
        const keys = this.getApiKeys();
        const idx = keys.findIndex(k => k.key === keyValue && k.url === url);
        if (idx === -1) return;
        keys[idx] = { ...keys[idx], ...updates };
        await this._saveApiKeys(keys);
        this._syncProvidersToRouter();
    }

    async deleteApiKey(keyValue: string, url: string): Promise<void> {
        const keys = this.getApiKeys().filter(k => !(k.key === keyValue && k.url === url));
        await this._saveApiKeys(keys);
        this.router.unregisterProvider(url);
        this._syncProvidersToRouter();
    }

    async resetKeyCooldown(keyValue: string, url: string): Promise<void> {
        const keys = this.getApiKeys();
        const idx = keys.findIndex(k => k.key === keyValue && k.url === url);
        if (idx === -1) return;
        delete keys[idx].rateLimitedUntil;
        await this._saveApiKeys(keys);
        this.router.setAvailable(url, true, keyValue);
        this.router.liftSuspension(url, keyValue);
    }

    getApiKeyStatuses(): ApiKeyStatus[] {
        const now = Date.now();
        return this.getApiKeys().map(entry => {
            if (!entry.key) return { entry, status: 'no-key' as ApiKeyStatusCode, statusIcon: '🔴', statusLabel: 'Pas de clé' };
            if (entry.rateLimitedUntil && entry.rateLimitedUntil > now) {
                const secsLeft = Math.ceil((entry.rateLimitedUntil - now) / 1000);
                return { entry, status: 'cooldown' as ApiKeyStatusCode, cooldownSecsLeft: secsLeft, statusIcon: '🟡', statusLabel: `Cooldown ${secsLeft}s` };
            }
            return { entry, status: 'available' as ApiKeyStatusCode, statusIcon: '🟢', statusLabel: 'Disponible' };
        });
    }

    private _getAvailableKey(targetUrl: string): { key: string; entry?: ApiKeyEntry } {
        const keys = this.getApiKeys();
        const now = Date.now();
        const exact = keys.find(k => k.url && targetUrl.startsWith(k.url.replace(/\/+$/, '')) && (!k.rateLimitedUntil || k.rateLimitedUntil < now));
        if (exact) return { key: exact.key, entry: exact };
        const platformMatch = keys.find(k => k.platform && targetUrl.includes(k.platform) && (!k.rateLimitedUntil || k.rateLimitedUntil < now));
        if (platformMatch) return { key: platformMatch.key, entry: platformMatch };
        return { key: this._getConfig().get<string>('apiKey') || '' };
    }

    private async _markKeyAsRateLimited(keyValue: string, url: string, cooldownMs = 60_000): Promise<void> {
        const keys = this.getApiKeys();
        let changed = false;
        const updated = keys.map(k => {
            if (k.key === keyValue && k.url === url) { changed = true; return { ...k, rateLimitedUntil: Date.now() + cooldownMs }; }
            return k;
        });
        if (changed) { await this._saveApiKeys(updated); this.router.reportRateLimit(url, cooldownMs); }
    }

    getTokenBudget(model: string, targetUrl?: string): TokenBudget {
        if (this.isCloud(targetUrl)) return { used: 0, max: 100_000 * 4, isCloud: true };
        // Synchronous fallback for local models
        return { used: 0, max: 8192 * 4, isCloud: false };
    }

    async getTokenBudgetAsync(model: string, targetUrl?: string): Promise<TokenBudget> {
        if (this.isCloud(targetUrl)) return { used: 0, max: 100_000 * 4, isCloud: true };
        const tokens = await getLocalContextSize(model, targetUrl || this._getBaseUrl());
        return { used: 0, max: tokens * 4, isCloud: false };
    }

    buildContext(files: ContextFile[], history: string, model: string, targetUrl?: string): { context: string; budget: TokenBudget } {
        return this._buildContextFromBudget(files, history, this.getTokenBudget(model, targetUrl));
    }

    async buildContextAsync(files: ContextFile[], history: string, model: string, targetUrl?: string): Promise<{ context: string; budget: TokenBudget }> {
        return this._buildContextFromBudget(files, history, await this.getTokenBudgetAsync(model, targetUrl));
    }

    private _buildContextFromBudget(files: ContextFile[], history: string, budget: TokenBudget): { context: string; budget: TokenBudget } {
        let remaining = budget.max - history.length - 500;
        const parts: string[] = [];
        for (const f of [...files.filter(f => f.isActive), ...files.filter(f => !f.isActive)]) {
            if (remaining <= 0) break;
            const header = `[FICHIER${f.isActive ? ' ACTIF' : ''}: ${f.name}]\n`;
            const available = remaining - header.length;
            if (available <= 100) break;
            const truncated = f.content.length > available ? f.content.substring(0, available) + '\n[... tronqué ...]' : f.content;
            parts.push(header + truncated);
            remaining -= (header.length + truncated.length);
        }
        budget.used = budget.max - remaining;
        return { context: parts.join('\n\n'), budget };
    }

    modelSupportsVision(model: string, url: string): boolean { return isVisionModel(model, this._detectProvider(url)); }
    getBestVisionModel(url: string): string | null { return VISION_MODELS[this._detectProvider(url)]?.[0] ?? null; }

    private _getSystemPrompt(): string {
        return `Tu es une IA d'édition de code intégrée dans VS Code. Ton seul but est d'éditer le code de l'utilisateur.

━━━ COMPORTEMENT STRICT ABSOLU (SINON ÉCHEC) ━━━
- RÉPONDRE EXCLUSIVEMENT EN FRANÇAIS.
- Modifie UNIQUEMENT le vrai code fourni dans le contexte.
- Style robotique : PAS de salutations, PAS d'explications inutiles. Fournis directement le correctif.
- Si tu as besoin d'accéder à un fichier qui n'est PAS dans ton contexte, indique-le EXPLICITEMENT avec la balise : [NEED_FILE: chemin/du/fichier]
- Pour suggérer une commande terminal, utilise : [CMD: commande] (ex: [CMD: npm install]). Pour une commande destructive ou risquée : [CMD_IMPORTANT: commande] (ex: [CMD_IMPORTANT: rm -rf dist]). L'utilisateur sera toujours consulté avant exécution selon ses préférences.
- Si tu identifies plusieurs fichiers à modifier, liste-les TOUS avant de commencer avec : [WILL_MODIFY: fichier1, fichier2, ...]
- Pour le mode "Réflexion", commence par un bloc [PLAN] qui liste toutes les modifications envisagées avant tout code.
- Si une image t'est fournie, analyse-la attentivement : identifie les erreurs, le code visible, les captures d'écran et base ton analyse sur ce que tu vois.

━━━ FORMAT OBLIGATOIRE POUR MODIFIER UN FICHIER ━━━
\`\`\`typescript
[FILE: nom_du_fichier.ts]
<<<< SEARCH
code_exact_existant
====
nouveau_code
>>>>
\`\`\`
1. SEARCH doit être un copié-collé STRICT. 2. Inclure 2 lignes de contexte. 3. Nouveau fichier : [CREATE_FILE: chemin].`;
    }

    async generateStreamingResponse(
        prompt: string, context: string, onUpdate: (chunk: string) => void,
        modelOverride?: string, targetUrl?: string, images?: AttachedImage[],
        taskType: TaskType = 'chat', preferredApiKey: string = '', signal?: AbortSignal
    ): Promise<string> {
        const model = modelOverride || this._getConfig().get<string>('defaultModel') || 'llama3';
        const fullPrompt = context ? `Contexte du projet:\n${context}\n\n---\nQuestion: ${prompt}` : prompt;
        const slot = await this.router.selectProvider(taskType, targetUrl, !!(images?.length), preferredApiKey);
        return this._doRequest(slot, model, fullPrompt, onUpdate, 0, images, taskType, signal);
    }

    async generateResponse(
        prompt: string, context: string = '', modelOverride?: string, targetUrl?: string,
        images?: AttachedImage[], preferredApiKey: string = '', signal?: AbortSignal
    ): Promise<string> {
        let full = '';
        await this.generateStreamingResponse(prompt, context, c => { full += c; }, modelOverride, targetUrl, images, 'chat', preferredApiKey, signal);
        return full;
    }

    private async _doRequest(
        slot: import('./providerRouter').SelectedSlot,
        model: string, fullPrompt: string, onUpdate: (chunk: string) => void,
        attempt: number, images?: AttachedImage[], taskType: TaskType = 'chat', signal?: AbortSignal
    ): Promise<string> {
        const { url, apiKey } = slot;
        const systemPrompt = this._getSystemPrompt();
        const hasImages = !!(images?.length);
        const t0 = Date.now();

        try {
            let result: string;

            if (isLocalUrl(url)) {
                result = await localStream(
                    { model, prompt: fullPrompt, systemPrompt, images, signal, baseUrl: url },
                    onUpdate
                );

            } else if (isCloudUrl(url)) {
                result = await cloudStream(
                    { model, prompt: fullPrompt, systemPrompt, baseUrl: url, apiKey, images, signal },
                    onUpdate
                );
            } else {
                throw new Error(`URL non reconnue : ${url}`);
            }

            this.router.reportSuccess(url, Date.now() - t0, estimateTokens(result), apiKey);
            return result;

        } catch (error: any) {
            const msg: string = error.message || String(error);

            if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
                await this._markKeyAsRateLimited(apiKey, url, 60_000);
                this.router.reportRateLimit(url, 60_000, apiKey);
                if (attempt < 3) {
                    try {
                        const next = await this.router.selectProvider(taskType, url, hasImages, apiKey);
                        if (next.url !== url || next.apiKey !== apiKey) {
                            vscode.window.showInformationMessage(`🔄 Rate limit — bascule sur ${next.name}`);
                            return this._doRequest(next, model, fullPrompt, onUpdate, attempt + 1, images, taskType, signal);
                        }
                    } catch { }
                    await new Promise(r => setTimeout(r, 5000));
                    return this._doRequest(slot, model, fullPrompt, onUpdate, attempt + 1, images, taskType, signal);
                }
                throw new Error('Tous les providers sont en rate limit.');
            }

            if ((msg.includes('HTTP 4') || msg.includes('HTTP 5')) && attempt < 2) {
                this.router.reportError(url, false, 60_000, apiKey);
                try {
                    const next = await this.router.selectProvider(taskType, undefined, hasImages);
                    if (next.url !== url || next.apiKey !== apiKey) {
                        vscode.window.showWarningMessage(`⚠️ Erreur — bascule sur ${next.name}`);
                        return this._doRequest(next, model, fullPrompt, onUpdate, attempt + 1, images, taskType, signal);
                    }
                } catch { }
            }

            this.router.reportError(url, false, 60_000, apiKey);
            if (msg.includes('ECONNREFUSED') || msg.includes('fetch') || msg.includes('NetworkError')) {
                vscode.window.showErrorMessage(`Serveur inaccessible : ${url}`);
            } else {
                vscode.window.showErrorMessage(`Erreur IA: ${msg}`);
            }
            return '';
        }
    }

    async listModels(): Promise<string[]> {
        const url = this._getBaseUrl();
        if (isLocalUrl(url)) return listLocalModels(url);
        const { key } = this._getAvailableKey(url);
        return listOpenAICompatModels(url, key);
    }

    async listAllModels(): Promise<{ name: string; isLocal: boolean; url: string; provider: string }[]> {
        const result: { name: string; isLocal: boolean; url: string; provider: string }[] = [];
        const seen = new Set<string>();
        const LOCAL_URL = 'http://localhost:11434';

        for (const m of await listLocalModels(LOCAL_URL)) {
            const k = `${LOCAL_URL}||${m}`;
            if (!seen.has(k)) { seen.add(k); result.push({ name: m, isLocal: true, url: LOCAL_URL, provider: 'local' }); }
        }

        const configUrl = this._getBaseUrl().replace(/\/+$/, '');
        if (isLocalUrl(configUrl) && configUrl !== LOCAL_URL && configUrl !== 'http://127.0.0.1:11434') {
            for (const m of await listLocalModels(configUrl)) {
                const k = `${configUrl}||${m}`;
                if (!seen.has(k)) { seen.add(k); result.push({ name: m, isLocal: true, url: configUrl, provider: 'local' }); }
            }
        }

        for (const entry of this.getApiKeys()) {
            if (!entry.url) continue;
            const baseUrl = entry.url.replace(/\/+$/, '');
            if (isLocalUrl(baseUrl) && !entry.key) continue;
            const provider = this._detectProvider(baseUrl);
            let list: string[] = [];
            try {
                if (provider === 'gemini' && entry.key) list = await listGeminiModels(entry.key);
                else list = await listOpenAICompatModels(baseUrl, entry.key);
            } catch { }
            for (const m of list) {
                const k = `${baseUrl}||${m}`;
                if (!seen.has(k)) { seen.add(k); result.push({ name: m, isLocal: false, url: baseUrl, provider }); }
            }
        }

        return result;
    }

    async checkConnection(): Promise<boolean> {
        const url = this._getBaseUrl();
        if (isLocalUrl(url)) return checkLocalConnection(url);
        try { const { key } = this._getAvailableKey(url); await listOpenAICompatModels(url, key); return true; }
        catch { return false; }
    }

    async detectBestFreeModel(preferVision = false): Promise<{ url: string; model: string; provider: string } | null> {
        const all = await this.listAllModels();
        if (!preferVision) { const l = all.find(m => m.isLocal); if (l) return { url: l.url, model: l.name, provider: 'local' }; }
        if (preferVision) { const lv = all.find(m => m.isLocal && isVisionModel(m.name, 'local')); if (lv) return { url: lv.url, model: lv.name, provider: 'local' }; }
        for (const e of this.getApiKeys()) {
            if (this._detectProvider(e.url) === 'gemini') { const m = FREE_MODELS['gemini']?.[0]; if (m) return { url: e.url, model: m, provider: 'gemini' }; }
        }
        for (const e of this.getApiKeys()) {
            if (e.url.includes('openrouter')) { const m = all.find(x => x.url === e.url); if (m) return { url: e.url, model: m.name, provider: 'openrouter' }; }
        }
        for (const e of this.getApiKeys()) {
            if (this._detectProvider(e.url) === 'groq') { const m = FREE_MODELS['groq']?.[0]; if (m) return { url: e.url, model: m, provider: 'groq' }; }
        }
        return null;
    }

    dispose() { this.router.dispose(); }
}