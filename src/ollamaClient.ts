import * as vscode from 'vscode';
import { ProviderRouter, TaskType, FREE_MODELS } from './providerRouter';
import { SecretKeyStore } from './secretKeyStore';
import { ModelConfigManager } from './modelConfigManager';

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

// Vraies limites de contexte par modèle (en tokens)
// Mise à jour : 2025 — sources: docs officielles de chaque provider
const MODEL_CONTEXT_LIMITS: Array<{ match: string | RegExp; tokens: number; note?: string }> = [
    { match: 'gemini-2.5-pro', tokens: 1_048_576, note: 'Gemini 2.5 Pro' },
    { match: 'gemini-2.5-flash', tokens: 1_048_576, note: 'Gemini 2.5 Flash' },
    { match: 'gemini-2.0-flash-exp', tokens: 1_048_576, note: 'Gemini 2.0 Flash Exp' },
    { match: 'gemini-2.0-flash', tokens: 1_048_576, note: 'Gemini 2.0 Flash' },
    { match: 'gemini-1.5-pro', tokens: 2_097_152, note: 'Gemini 1.5 Pro — 2M ctx' },
    { match: 'gemini-1.5-flash-8b', tokens: 1_048_576, note: 'Gemini 1.5 Flash 8B' },
    { match: 'gemini-1.5-flash', tokens: 1_048_576, note: 'Gemini 1.5 Flash' },
    { match: 'gemini-pro', tokens: 128_000, note: 'Gemini 1.0 Pro (legacy)' },
    { match: /gemini/, tokens: 1_048_576, note: 'Gemini (générique)' },

    { match: 'claude-3-5-sonnet', tokens: 200_000 },
    { match: 'claude-3-5-haiku', tokens: 200_000 },
    { match: 'claude-3-opus', tokens: 200_000 },
    { match: 'claude-3-sonnet', tokens: 200_000 },
    { match: 'claude-3-haiku', tokens: 200_000 },
    { match: 'claude-2.1', tokens: 200_000 },
    { match: 'claude-2', tokens: 100_000 },
    { match: /claude/, tokens: 200_000, note: 'Claude (générique)' },

    { match: 'gpt-4.5', tokens: 128_000 },
    { match: 'gpt-4o-mini', tokens: 128_000 },
    { match: 'gpt-4o', tokens: 128_000 },
    { match: 'gpt-4-turbo', tokens: 128_000 },
    { match: 'gpt-4-32k', tokens: 32_768 },
    { match: 'gpt-4', tokens: 8_192 },
    { match: 'gpt-3.5-turbo-16k', tokens: 16_385 },
    { match: 'gpt-3.5', tokens: 16_385 },
    { match: 'o1-mini', tokens: 128_000 },
    { match: 'o1-preview', tokens: 128_000 },
    { match: 'o1', tokens: 200_000 },
    { match: 'o3-mini', tokens: 200_000 },
    { match: 'o3', tokens: 200_000 },

    { match: 'deepseek-r1', tokens: 128_000 },
    { match: 'deepseek-v3', tokens: 128_000 },
    { match: 'deepseek-v2.5', tokens: 128_000 },
    { match: 'deepseek-coder-v2', tokens: 128_000 },
    { match: 'deepseek-coder', tokens: 16_384 },
    { match: /deepseek/, tokens: 128_000 },

    { match: 'mistral-large', tokens: 131_072 },
    { match: 'mistral-small', tokens: 131_072 },
    { match: 'mistral-nemo', tokens: 131_072 },
    { match: 'ministral-8b', tokens: 131_072 },
    { match: 'ministral-3b', tokens: 131_072 },
    { match: 'codestral', tokens: 262_144 },
    { match: 'mixtral-8x22b', tokens: 65_536 },
    { match: 'mixtral-8x7b', tokens: 32_768 },
    { match: /mistral|mixtral|ministral/, tokens: 131_072 },

    { match: 'llama-3.3-70b', tokens: 131_072 },
    { match: 'llama-3.2-90b', tokens: 131_072 },
    { match: 'llama-3.2-11b', tokens: 131_072 },
    { match: 'llama-3.2-3b', tokens: 131_072 },
    { match: 'llama-3.2-1b', tokens: 131_072 },
    { match: 'llama-3.1-405b', tokens: 131_072 },
    { match: 'llama-3.1-70b', tokens: 131_072 },
    { match: 'llama-3.1-8b', tokens: 131_072 },
    { match: 'llama-3-70b', tokens: 8_192 },
    { match: 'llama-3-8b', tokens: 8_192 },
    { match: /llama-?3\.[12]/, tokens: 131_072 },
    { match: /llama/, tokens: 8_192 },

    { match: 'qwen2.5-coder-32b', tokens: 131_072 },
    { match: 'qwen2.5-72b', tokens: 131_072 },
    { match: 'qwen2.5-32b', tokens: 131_072 },
    { match: 'qwen2.5-7b', tokens: 131_072 },
    { match: /qwen2\.5|qwen-2\.5/, tokens: 131_072 },
    { match: /qwen/, tokens: 32_768 },

    { match: 'grok-3', tokens: 131_072 },
    { match: 'grok-2', tokens: 131_072 },
    { match: 'grok-1.5', tokens: 131_072 },
    { match: /grok/, tokens: 131_072 },

    { match: 'llama3-groq-70b', tokens: 8_192 },
    { match: 'llama3-groq-8b', tokens: 8_192 },
    { match: 'gemma2-9b-it', tokens: 8_192 },
    { match: 'command-r-plus', tokens: 128_000 },
    { match: 'command-r', tokens: 128_000 },
    { match: /command/, tokens: 128_000 },

    { match: /sonar/, tokens: 127_072 },
    { match: /perplexity/, tokens: 127_072 },

    { match: /fireworks/, tokens: 131_072 },
];

/**
 * Retourne la vraie limite de contexte (en tokens) pour un modèle donné.
 * La recherche se fait d'abord sur le nom exact (sous-chaîne),
 * puis sur les RegExp, dans l'ordre de déclaration (du plus spécifique au plus général).
 */
export function getCloudModelLimit(model: string, provider: string): number {
    const m = model.toLowerCase().trim();
    const p = provider.toLowerCase();

    for (const entry of MODEL_CONTEXT_LIMITS) {
        if (typeof entry.match === 'string') {
            if (m.includes(entry.match)) return entry.tokens;
        } else {
            if (entry.match.test(m)) return entry.tokens;
        }
    }

    switch (p) {
        case 'gemini': return 1_048_576;
        case 'anthropic': return 200_000;
        case 'openai': return 128_000;
        case 'deepseek': return 128_000;
        case 'groq': return 32_768;
        case 'mistral': return 131_072;
        case 'together': return 131_072;
        case 'openrouter': return 128_000;
        case 'cohere': return 128_000;
        case 'xai': return 131_072;
        case 'fireworks': return 131_072;
        case 'perplexity': return 127_072;
        default: return 128_000;
    }
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
    private _secretStore?: SecretKeyStore;
    private _secretStoreReady = false;
    private _modelConfigManager?: ModelConfigManager;

    constructor(modelConfigManager?: ModelConfigManager) {
        this.router = new ProviderRouter();
        this._modelConfigManager = modelConfigManager;
        this.router.registerProvider('http://localhost:11434', 'Ollama Local', 'local');
        const lmStudioUrl = this._getLmStudioUrl();
        this.router.registerProvider(lmStudioUrl, 'LM Studio', 'lmstudio');
        this._syncProvidersToRouter();
    }

    async initSecretStore(secrets: vscode.SecretStorage): Promise<number> {
        this._secretStore = new SecretKeyStore(secrets);
        const migrated = await this._secretStore.migrateFromSettings();
        this._secretStoreReady = true;
        await this._syncSecretKeysToRouter();
        if (migrated > 0) {
            console.log(`[Antigravity] ${migrated} clé(s) migrée(s) vers SecretStorage.`);
        }
        return migrated;
    }

    get secretStore(): SecretKeyStore | undefined {
        return this._secretStore;
    }

    private async _syncSecretKeysToRouter(): Promise<void> {
        if (!this._secretStore) return;
        const entries = await this._secretStore.getAllKeysWithSecrets();
        for (const entry of entries) {
            if (!entry.url) continue;
            this.router.registerProvider(entry.url, entry.name, this._detectProvider(entry.url), entry.key);
            if (entry.rateLimitedUntil && entry.rateLimitedUntil > Date.now()) {
                this.router.reportRateLimit(entry.url, entry.rateLimitedUntil - Date.now(), entry.key);
            }
        }
    }

    private _getConfig() { return vscode.workspace.getConfiguration('local-ai'); }
    private _getBaseUrl(): string { return this._getConfig().get<string>('ollamaUrl') || 'http://localhost:11434'; }
    private _getLmStudioUrl(): string { return this._getConfig().get<string>('lmStudioUrl') || 'http://localhost:1234/v1'; }

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

    async getApiKeysAsync(): Promise<ApiKeyEntry[]> {
        if (this._secretStore && this._secretStoreReady) {
            const entries = await this._secretStore.getAllKeysWithSecrets();
            return entries.map(e => ({
                key: e.key,
                name: e.name,
                url: e.url,
                platform: e.platform,
                rateLimitedUntil: e.rateLimitedUntil,
                addedAt: e.addedAt,
            }));
        }
        return this.getApiKeys();
    }

    private async _saveApiKeys(keys: ApiKeyEntry[]): Promise<void> {
        await this._getConfig().update('apiKeys', keys, vscode.ConfigurationTarget.Global);
    }

    async addApiKey(entry: Omit<ApiKeyEntry, 'addedAt'>): Promise<{ success: boolean; reason?: string }> {
        if (!entry.url) return { success: false, reason: 'Une URL est requise.' };

        if (this._secretStore && this._secretStoreReady) {
            const existing = await this._secretStore.findByUrlAndKey(entry.url, entry.key);
            if (existing) {
                return { success: false, reason: 'Ce provider avec cette clé est déjà configuré.' };
            }
            await this._secretStore.storeKey(entry.name, entry.url, entry.key, entry.platform);
            this.router.registerProvider(entry.url, entry.name, this._detectProvider(entry.url), entry.key);
            return { success: true };
        }

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
        if (this._secretStore && this._secretStoreReady) {
            const all = await this._secretStore.getAllKeysWithSecrets();
            const entry = all.find(k => k.key === keyValue && k.url === url);
            if (entry) {
                await this._secretStore.updateKeyMeta(entry.id, updates);
                await this._syncSecretKeysToRouter();
                return;
            }
        }
        const keys = this.getApiKeys();
        const idx = keys.findIndex(k => k.key === keyValue && k.url === url);
        if (idx === -1) return;
        keys[idx] = { ...keys[idx], ...updates };
        await this._saveApiKeys(keys);
        this._syncProvidersToRouter();
    }

    async deleteApiKey(keyValue: string, url: string): Promise<void> {
        if (this._secretStore && this._secretStoreReady) {
            const all = await this._secretStore.getAllKeysWithSecrets();
            const entry = all.find(k => k.key === keyValue && k.url === url);
            if (entry) {
                await this._secretStore.deleteKey(entry.id);
                this.router.unregisterProvider(url, keyValue);
                await this._syncSecretKeysToRouter();
                return;
            }
        }
        const keys = this.getApiKeys().filter(k => !(k.key === keyValue && k.url === url));
        await this._saveApiKeys(keys);
        this.router.unregisterProvider(url);
        this._syncProvidersToRouter();
    }

    async resetKeyCooldown(keyValue: string, url: string): Promise<void> {
        if (this._secretStore && this._secretStoreReady) {
            const all = await this._secretStore.getAllKeysWithSecrets();
            const entry = all.find(k => k.key === keyValue && k.url === url);
            if (entry) {
                await this._secretStore.resetKeyCooldown(entry.id);
                this.router.setAvailable(url, true, keyValue);
                this.router.liftSuspension(url, keyValue);
                return;
            }
        }
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

    async getApiKeyStatusesAsync(): Promise<ApiKeyStatus[]> {
        const now = Date.now();
        const keys = await this.getApiKeysAsync();
        return keys.map(entry => {
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

    getTokenBudget(model: string, targetUrl?: string, multiplier: number = 1, fixedMax?: number): TokenBudget {
        if (fixedMax) return { used: 0, max: fixedMax * 4, isCloud: this.isCloud(targetUrl) };
        if (this.isCloud(targetUrl) && this._detectProvider(targetUrl || '') !== 'lmstudio') {
            const provider = this._detectProvider(targetUrl || '');
            const limit = getCloudModelLimit(model, provider);
            return { used: 0, max: Math.floor(limit * multiplier * 4), isCloud: true };
        }
        return { used: 0, max: Math.floor(8192 * multiplier * 4), isCloud: false };
    }

    async getTokenBudgetAsync(model: string, targetUrl?: string, multiplier: number = 1, fixedMax?: number): Promise<TokenBudget> {
        if (fixedMax) return { used: 0, max: fixedMax * 4, isCloud: this.isCloud(targetUrl) };
        if (this.isCloud(targetUrl) && this._detectProvider(targetUrl || '') !== 'lmstudio') {
            const provider = this._detectProvider(targetUrl || '');
            const limit = getCloudModelLimit(model, provider);
            return { used: 0, max: Math.floor(limit * multiplier * 4), isCloud: true };
        }
        const url = targetUrl || this._getBaseUrl();
        if (this._modelConfigManager) {
            const config = await this._modelConfigManager.getConfig(model, url);
            return { used: 0, max: Math.floor(config.contextLimit * multiplier * 4), isCloud: false };
        }
        const tokens = await getLocalContextSize(model, url);
        return { used: 0, max: Math.floor(tokens * multiplier * 4), isCloud: false };
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
- Si l'utilisateur demande un "résumé" ou "synthèse", sois extrêmement bref (une seule phrase ou une liste de points courte).
- Si l'utilisateur demande de "générer des tests", fournis uniquement le code des tests dans un bloc [FILE] sans explications.
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
        taskType: TaskType = 'chat', preferredApiKey: string = '', signal?: AbortSignal,
        requireLocal: boolean = false
    ): Promise<string> {
        const model = modelOverride || this._getConfig().get<string>('defaultModel') || 'llama3';
        const fullPrompt = context ? `Contexte du projet:\n${context}\n\n---\nQuestion: ${prompt}` : prompt;
        const slot = await this.router.selectProvider(taskType, targetUrl, !!(images?.length), preferredApiKey, requireLocal);

        const isLocalProvider = slot.provider === 'local' || slot.provider === 'lmstudio';
        if (isLocalProvider) {
            const resolvedModel = await this._resolveLocalModel(model, slot.url, slot.provider);
            if (resolvedModel !== model) {
                vscode.window.showInformationMessage(
                    `💡 Modèle "${model}" non trouvé — utilisation de "${resolvedModel}" (le plus léger disponible)`
                );
            }
            return this._doRequest(slot, resolvedModel, fullPrompt, onUpdate, 0, images, taskType, signal);
        }

        return this._doRequest(slot, model, fullPrompt, onUpdate, 0, images, taskType, signal);
    }

    private async _resolveLocalModel(requestedModel: string, url: string, provider: string): Promise<string> {
        try {
            let installedModels: string[];
            if (provider === 'lmstudio') {
                installedModels = await listOpenAICompatModels(url);
            } else {
                installedModels = await listLocalModels(url);
            }

            if (installedModels.length === 0) return requestedModel;

            const requested = requestedModel.toLowerCase().replace(/:latest$/, '');
            const isInstalled = installedModels.some(m =>
                m.toLowerCase().replace(/:latest$/, '') === requested ||
                m.toLowerCase().startsWith(requested + ':')
            );

            if (isInstalled) return requestedModel;

            return this._pickLightestModel(installedModels);
        } catch {
            return requestedModel;
        }
    }

    private _pickLightestModel(models: string[]): string {
        const parseWeight = (name: string): number => {
            const n = name.toLowerCase();

            const sizeMatch = n.match(/[:\-_](\d+(?:\.\d+)?)\s*b/);
            const sizeB = sizeMatch ? parseFloat(sizeMatch[1]) : 7;
            let quantScore = 4;
            if (n.includes('q2')) quantScore = 2;
            else if (n.includes('q3')) quantScore = 3;
            else if (n.includes('q4')) quantScore = 4;
            else if (n.includes('q5')) quantScore = 5;
            else if (n.includes('q6')) quantScore = 6;
            else if (n.includes('q8')) quantScore = 8;
            else if (n.includes('fp16') || n.includes('f16')) quantScore = 16;

            return sizeB * 10 + quantScore;
        };

        const sorted = [...models].sort((a, b) => parseWeight(a) - parseWeight(b));
        console.log(`[OllamaClient] Modèles triés par poids: ${sorted.slice(0, 3).join(', ')} ...`);
        return sorted[0];
    }

    async generateResponse(
        prompt: string, context: string = '', modelOverride?: string, targetUrl?: string,
        images?: AttachedImage[], preferredApiKey: string = '', signal?: AbortSignal,
        requireLocal: boolean = false
    ): Promise<string> {
        let full = '';
        await this.generateStreamingResponse(prompt, context, c => { full += c; }, modelOverride, targetUrl, images, 'chat', preferredApiKey, signal, requireLocal);
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

            if (isLocalUrl(url) && this._detectProvider(url) !== 'lmstudio' && this._detectProvider(url) !== 'openai-compat' || this._detectProvider(url) === 'ollama-cloud') {
                result = await localStream(
                    { model, prompt: fullPrompt, systemPrompt, images, signal, baseUrl: url, apiKey },
                    onUpdate
                );

            } else if (isCloudUrl(url)) {
                result = await cloudStream(
                    { model, prompt: fullPrompt, systemPrompt, baseUrl: url, apiKey, images, signal },
                    onUpdate
                );
            } else {
                console.error(`[OllamaClient] URL non reconnue : ${url}`);
                throw new Error(`URL non reconnue : ${url}`);
            }

            const duration = Date.now() - t0;
            console.log(`[OllamaClient] Requête réussie sur ${url} en ${duration}ms (model: ${model})`);
            this.router.reportSuccess(url, duration, estimateTokens(result), apiKey);
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
                console.warn(`[OllamaClient] Erreur HTTP détectée sur ${url} : ${msg}. Tentative de failover.`);
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
        const provider = this._detectProvider(url);
        const { key } = this._getAvailableKey(url);

        if (provider === 'lmstudio' || provider === 'openai-compat' || provider === 'xai') {
            let finalUrl = url;
            if (provider === 'xai' && !url.endsWith('/v1')) {
                finalUrl = `${url.replace(/\/+$/, '')}/v1`;
            }
            return listOpenAICompatModels(finalUrl, key);
        }
        if (isLocalUrl(url) || provider === 'ollama-cloud') {
            return listLocalModels(url, key);
        }
        return listOpenAICompatModels(url, key);
    }

    async listAllModels(): Promise<{ name: string; isLocal: boolean; url: string; provider: string }[]> {
        const result: { name: string; isLocal: boolean; url: string; provider: string }[] = [];
        const seen = new Set<string>();

        const OLLAMA_URLS = [
            'http://localhost:11434',
            'http://127.0.0.1:11434',
        ];

        const configUrl = this._getBaseUrl().replace(/\/+$/, '');
        if (configUrl && !OLLAMA_URLS.includes(configUrl) && isLocalUrl(configUrl) && this._detectProvider(configUrl) !== 'lmstudio') {
            OLLAMA_URLS.push(configUrl);
        }

        for (const ollamaUrl of OLLAMA_URLS) {
            try {
                const localModels = await listLocalModels(ollamaUrl);
                if (localModels.length > 0) {
                    console.log(`[OllamaClient] ✓ Ollama trouvé sur ${ollamaUrl}: ${localModels.length} modèles`);
                    for (const m of localModels) {
                        const k = `${ollamaUrl}||${m}`;
                        if (!seen.has(k)) { seen.add(k); result.push({ name: m, isLocal: true, url: ollamaUrl, provider: 'local' }); }
                    }
                    break;
                }
            } catch (e) {
                console.warn(`[OllamaClient] Ollama inaccessible sur ${ollamaUrl}: ${e}`);
            }
        }

        const LMSTUDIO_URLS = [
            this._getLmStudioUrl(),
            'http://localhost:1234/v1',
            'http://127.0.0.1:1234/v1',
        ].filter((v, i, arr) => arr.indexOf(v) === i);

        for (const lmUrl of LMSTUDIO_URLS) {
            try {
                const lmModels = await listOpenAICompatModels(lmUrl);
                if (lmModels.length > 0) {
                    console.log(`[OllamaClient] ✓ LM Studio trouvé sur ${lmUrl}: ${lmModels.length} modèles`);
                    for (const m of lmModels) {
                        const k = `${lmUrl}||${m}`;
                        if (!seen.has(k)) { seen.add(k); result.push({ name: m, isLocal: true, url: lmUrl, provider: 'lmstudio' }); }
                    }
                    break;
                }
            } catch (e) {
                console.warn(`[OllamaClient] LM Studio inaccessible sur ${lmUrl}: ${e}`);
            }
        }

        for (const entry of await this.getApiKeysAsync()) {
            if (!entry.url) continue;
            const baseUrl = entry.url.replace(/\/+$/, '');
            if (isLocalUrl(baseUrl) && !entry.key) continue;
            const provider = this._detectProvider(baseUrl);
            let list: string[] = [];
            try {
                if (provider === 'gemini' && entry.key) {
                    list = await listGeminiModels(entry.key);
                } else if (provider === 'ollama-cloud' || (isLocalUrl(baseUrl) && provider !== 'lmstudio')) {
                    list = await listLocalModels(baseUrl, entry.key);
                } else {
                    let finalUrl = baseUrl;
                    if (provider === 'xai' && !baseUrl.endsWith('/v1')) {
                        finalUrl = `${baseUrl}/v1`;
                    }
                    list = await listOpenAICompatModels(finalUrl, entry.key);
                }
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
        const provider = this._detectProvider(url);
        const { key } = this._getAvailableKey(url);

        if (provider === 'lmstudio' || provider === 'openai-compat' || provider === 'xai') {
            let finalUrl = url;
            if (provider === 'xai' && !url.endsWith('/v1')) {
                finalUrl = `${url.replace(/\/+$/, '')}/v1`;
            }
            try { await listOpenAICompatModels(finalUrl, key); return true; }
            catch { return false; }
        }

        if (isLocalUrl(url) || provider === 'ollama-cloud') {
            return checkLocalConnection(url, key);
        }

        try { await listOpenAICompatModels(url, key); return true; }
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