import * as vscode from 'vscode';
import { ProviderRouter, TaskType, FREE_MODELS } from './providerRouter';

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

const LOCAL_LIMITS: Record<string, number> = {
    'llama3': 8000,
    'llama3.1': 8000,
    'llama3.2': 8000,
    'codellama': 8000,
    'mistral': 8000,
    'mixtral': 16000,
    'deepseek-coder': 8000,
    'qwen2.5-coder': 8000,
    'phi3': 4000,
    'phi4': 8000,
    'gemma': 4000,
    'gemma2': 8000,
    'llava': 8000,
    'bakllava': 8000,
    'moondream': 4000,
};

function getLocalMaxChars(model: string): number {
    const modelLower = model.toLowerCase();
    for (const [key, limit] of Object.entries(LOCAL_LIMITS)) {
        if (modelLower.includes(key)) return limit * 4;
    }
    return 8000 * 4;
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

const VISION_MODELS: Record<string, string[]> = {
    'gemini': ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'],
    'openai': ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    'openrouter': ['google/gemini-flash-1.5', 'openai/gpt-4o-mini', 'anthropic/claude-3-haiku'],
    'anthropic': ['claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    'local': ['llava', 'bakllava', 'llava-phi3', 'moondream', 'llava-llama3'],
};

function isVisionModel(model: string, provider: string): boolean {
    const m = model.toLowerCase();
    const visionList = VISION_MODELS[provider] || [];
    if (visionList.some(v => m.includes(v.toLowerCase()))) return true;
    return m.includes('vision') || m.includes('llava') || m.includes('4o') ||
        m.includes('gemini') || m.includes('claude-3') || m.includes('moondream');
}

export class OllamaClient {
    readonly router: ProviderRouter;

    constructor() {
        this.router = new ProviderRouter();
        this.router.registerProvider('http://localhost:11434', 'Ollama Local', 'local');
        this._syncProvidersToRouter();
    }

    private _getConfig() {
        return vscode.workspace.getConfiguration('local-ai');
    }

    private _getBaseUrl(): string {
        return this._getConfig().get<string>('ollamaUrl') || 'http://localhost:11434';
    }

    _syncProvidersToRouter() {
        for (const entry of this.getApiKeys()) {
            if (!entry.url) continue;
            const provider = this._detectProvider(entry.url);
            this.router.registerProvider(entry.url, entry.name, provider, entry.key);
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
        if (!entry.url) {
            return { success: false, reason: 'Une URL est requise.' };
        }
        const keys = this.getApiKeys();
        if (keys.find(k => k.url === entry.url && k.key === entry.key)) {
            return { success: false, reason: 'Ce provider avec cette clé est déjà configuré.' };
        }
        keys.push({ ...entry, addedAt: Date.now() });
        await this._saveApiKeys(keys);
        const provider = this._detectProvider(entry.url);
        this.router.registerProvider(entry.url, entry.name, provider, entry.key);
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
            if (!entry.key) {
                return { entry, status: 'no-key' as ApiKeyStatusCode, statusIcon: '🔴', statusLabel: 'Pas de clé' };
            }
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
        const exact = keys.find(k =>
            k.url && targetUrl.startsWith(k.url.replace(/\/+$/, '')) &&
            (!k.rateLimitedUntil || k.rateLimitedUntil < now)
        );
        if (exact) return { key: exact.key, entry: exact };
        const platformMatch = keys.find(k =>
            k.platform && targetUrl.includes(k.platform) &&
            (!k.rateLimitedUntil || k.rateLimitedUntil < now)
        );
        if (platformMatch) return { key: platformMatch.key, entry: platformMatch };
        const legacyKey = this._getConfig().get<string>('apiKey') || '';
        return { key: legacyKey };
    }

    private async _markKeyAsRateLimited(keyValue: string, url: string, cooldownMs = 60_000): Promise<void> {
        const keys = this.getApiKeys();
        let changed = false;
        const updated = keys.map(k => {
            if (k.key === keyValue && k.url === url) {
                changed = true;
                return { ...k, rateLimitedUntil: Date.now() + cooldownMs };
            }
            return k;
        });
        if (changed) {
            await this._saveApiKeys(updated);
            this.router.reportRateLimit(url, cooldownMs);
        }
    }

    isCloud(url?: string): boolean {
        const u = url || this._getBaseUrl();
        return !u.includes('localhost') && !u.includes('127.0.0.1');
    }

    getTokenBudget(model: string, targetUrl?: string): TokenBudget {
        const cloud = this.isCloud(targetUrl);
        if (cloud) {
            return { used: 0, max: 100000 * 4, isCloud: true };
        }
        const maxChars = getLocalMaxChars(model);
        return { used: 0, max: maxChars, isCloud: false };
    }

    buildContext(
        files: ContextFile[],
        history: string,
        model: string,
        targetUrl?: string
    ): { context: string; budget: TokenBudget } {
        const budget = this.getTokenBudget(model, targetUrl);
        const historyChars = history.length;
        let remaining = budget.max - historyChars - 500;
        const parts: string[] = [];
        const activeFiles = files.filter(f => f.isActive);
        const otherFiles = files.filter(f => !f.isActive);
        for (const f of [...activeFiles, ...otherFiles]) {
            if (remaining <= 0) break;
            const header = `[FICHIER${f.isActive ? ' ACTIF' : ''}: ${f.name}]\n`;
            const available = remaining - header.length;
            if (available <= 100) break;
            const truncated = f.content.length > available
                ? f.content.substring(0, available) + '\n[... tronqué ...]'
                : f.content;
            parts.push(header + truncated);
            remaining -= (header.length + truncated.length);
        }
        budget.used = budget.max - remaining;
        return { context: parts.join('\n\n'), budget };
    }

    modelSupportsVision(model: string, url: string): boolean {
        const provider = this._detectProvider(url);
        return isVisionModel(model, provider);
    }

    getBestVisionModel(url: string): string | null {
        const provider = this._detectProvider(url);
        const list = VISION_MODELS[provider];
        return list?.[0] ?? null;
    }

    async generateStreamingResponse(
        prompt: string,
        context: string,
        onUpdate: (chunk: string) => void,
        modelOverride?: string,
        targetUrl?: string,
        images?: AttachedImage[],
        taskType: TaskType = 'chat',
        preferredApiKey: string = '',
        signal?: AbortSignal
    ): Promise<string> {
        const hasImages = images && images.length > 0;
        const config = this._getConfig();
        const model = modelOverride || config.get<string>('defaultModel') || 'llama3';
        const fullPrompt = context
            ? `Contexte du projet:\n${context}\n\n---\nQuestion: ${prompt}`
            : prompt;

        let slot = await this.router.selectProvider(
            taskType,
            targetUrl,
            hasImages ?? false,
            preferredApiKey
        );

        return this._doRequestWithRetry(slot, model, fullPrompt, onUpdate, 0, images, taskType, signal);
    }

    async generateResponse(
        prompt: string,
        context: string = '',
        modelOverride?: string,
        targetUrl?: string,
        images?: AttachedImage[],
        preferredApiKey: string = '',
        signal?: AbortSignal
    ): Promise<string> {
        let full = '';
        await this.generateStreamingResponse(
            prompt, context, (c) => { full += c; },
            modelOverride, targetUrl, images, 'chat', preferredApiKey, signal
        );
        return full;
    }

    private async _doRequestWithRetry(
        slot: import('./providerRouter').SelectedSlot,
        model: string,
        fullPrompt: string,
        onUpdate: (chunk: string) => void,
        attempt: number = 0,
        images?: AttachedImage[],
        taskType: TaskType = 'chat',
        signal?: AbortSignal
    ): Promise<string> {
        const { url, apiKey, name: slotName } = slot;
        const isOpenAI = this._isOpenAI(url);
        const isGemini = this._isGemini(url);
        const systemPrompt = this._getSystemPrompt();
        const hasImages = images && images.length > 0;
        const t0 = Date.now();

        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (apiKey && !isGemini) headers['Authorization'] = `Bearer ${apiKey}`;
            if (url.includes('openrouter')) {
                headers['HTTP-Referer'] = 'https://github.com/microsoft/vscode';
                headers['X-Title'] = 'VSCode Antigravity';
            }

            let endpoint = isOpenAI ? `${url}/chat/completions` : `${url}/api/generate`;
            let reqBody: any;

            if (isGemini) {
                endpoint = `${url}/models/${model}:streamGenerateContent?key=${apiKey}`;
                const parts: any[] = [{ text: systemPrompt + '\n\n' + fullPrompt }];
                if (hasImages) {
                    for (const img of images!) {
                        parts.unshift({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
                    }
                }
                reqBody = { contents: [{ role: 'user', parts }] };

            } else if (isOpenAI) {
                let userContent: any;
                if (hasImages) {
                    userContent = [
                        ...images!.map(img => ({
                            type: 'image_url',
                            image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
                        })),
                        { type: 'text', text: fullPrompt }
                    ];
                } else {
                    userContent = fullPrompt;
                }
                reqBody = {
                    model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userContent }
                    ],
                    stream: true
                };

            } else {
                reqBody = {
                    model,
                    prompt: fullPrompt,
                    system: systemPrompt,
                    stream: true,
                    ...(hasImages && { images: images!.map(i => i.base64) })
                };
            }

            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(reqBody),
                signal
            });

            if (response.status === 429) {
                const retryAfterSec = parseInt(response.headers.get('retry-after') || '60', 10);
                const cooldownMs = (isNaN(retryAfterSec) ? 60 : retryAfterSec) * 1000;

                await this._markKeyAsRateLimited(apiKey, url, cooldownMs);
                this.router.reportRateLimit(url, cooldownMs, apiKey);

                if (attempt < 4) {
                    try {
                        const nextSlot = await this.router.selectProvider(taskType, url, hasImages ?? false, apiKey);
                        const isSameSlot = nextSlot.url === url && nextSlot.apiKey === apiKey;
                        if (!isSameSlot) {
                            const switchMsg = nextSlot.url === url
                                ? `🔄 Clé épuisée — bascule sur ${nextSlot.name} (même provider)`
                                : `🔄 Failover → ${nextSlot.name} (${this._detectProvider(nextSlot.url)})`;
                            vscode.window.showInformationMessage(switchMsg);
                            return this._doRequestWithRetry(nextSlot, model, fullPrompt, onUpdate, attempt + 1, images, taskType, signal);
                        }
                    } catch { }
                    await new Promise(r => setTimeout(r, 5000));
                    return this._doRequestWithRetry(slot, model, fullPrompt, onUpdate, attempt + 1, images, taskType, signal);
                }
                throw new Error('Tous les providers/clés sont en rate limit. Réessayez dans quelques minutes.');
            }

            if (!response.ok) {
                const errorText = await response.text();
                this.router.reportError(url, false, 60_000, apiKey);
                if (attempt < 2) {
                    try {
                        const nextSlot = await this.router.selectProvider(taskType, undefined, hasImages ?? false);
                        if (nextSlot.url !== url || nextSlot.apiKey !== apiKey) {
                            vscode.window.showWarningMessage(`⚠️ Erreur ${response.status} — bascule sur ${nextSlot.name}`);
                            return this._doRequestWithRetry(nextSlot, model, fullPrompt, onUpdate, attempt + 1, images, taskType, signal);
                        }
                    } catch { }
                }
                throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('Impossible de lire le flux de réponse.');

            const decoder = new TextDecoder();
            let fullResponse = '';
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    let cleanLine = line.trim();
                    if (!cleanLine) continue;

                    if (isGemini) {
                        if (cleanLine.startsWith(',')) cleanLine = cleanLine.slice(1).trim();
                        if (cleanLine.startsWith('[') || cleanLine.startsWith(']')) continue;
                        try {
                            const data = JSON.parse(cleanLine);
                            const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (content) { fullResponse += content; onUpdate(content); }
                        } catch { }
                    } else if (isOpenAI) {
                        if (cleanLine === 'data: [DONE]') continue;
                        if (cleanLine.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(cleanLine.slice(6));
                                const content = data.choices?.[0]?.delta?.content;
                                if (content) { fullResponse += content; onUpdate(content); }
                            } catch { }
                        }
                    } else {
                        try {
                            const data = JSON.parse(cleanLine);
                            if (data.response) { fullResponse += data.response; onUpdate(data.response); }
                            if (data.error) throw new Error(data.error);
                        } catch (e: any) {
                            if (e.message && !e.message.includes('JSON')) throw e;
                        }
                    }
                }
            }

            if (buffer.trim()) {
                if (isOpenAI && buffer.startsWith('data: ') && buffer !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(buffer.slice(6));
                        const content = data.choices?.[0]?.delta?.content;
                        if (content) { fullResponse += content; onUpdate(content); }
                    } catch { }
                } else if (!isOpenAI) {
                    try {
                        const data = JSON.parse(buffer);
                        if (data.response) { fullResponse += data.response; onUpdate(data.response); }
                    } catch { }
                }
            }

            this.router.reportSuccess(url, Date.now() - t0, estimateTokens(fullResponse), apiKey);
            return fullResponse;

        } catch (error: any) {
            const msg = error.message || String(error);
            this.router.reportError(url, false, 60_000, apiKey);
            if (msg.includes('fetch') || msg.includes('ECONNREFUSED') || msg.includes('NetworkError')) {
                vscode.window.showErrorMessage(`Serveur inaccessible sur ${url}`);
            } else {
                vscode.window.showErrorMessage(`Erreur IA: ${msg}`);
            }
            return '';
        }
    }

    async detectBestFreeModel(preferVision: boolean = false): Promise<{ url: string; model: string; provider: string } | null> {
        const all = await this.listAllModels();

        if (!preferVision) {
            const local = all.find(m => m.isLocal);
            if (local) return { url: local.url, model: local.name, provider: 'local' };
        }

        if (preferVision) {
            const localVision = all.find(m => m.isLocal && isVisionModel(m.name, 'local'));
            if (localVision) return { url: localVision.url, model: localVision.name, provider: 'local' };
        }

        for (const entry of this.getApiKeys()) {
            if (!this._isGemini(entry.url)) continue;
            const geminiModels = FREE_MODELS['gemini'];
            const target = preferVision ? geminiModels[0] : geminiModels[0];
            if (target) return { url: entry.url, model: target, provider: 'gemini' };
        }

        for (const entry of this.getApiKeys()) {
            if (!entry.url.includes('openrouter')) continue;
            const freeModel = all.find(m => m.url === entry.url);
            if (freeModel) return { url: entry.url, model: freeModel.name, provider: 'openrouter' };
        }

        for (const entry of this.getApiKeys()) {
            if (!entry.url.includes('groq')) continue;
            const groqModel = FREE_MODELS['groq']?.[0];
            if (groqModel) return { url: entry.url, model: groqModel, provider: 'groq' };
        }

        return null;
    }

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
Toujours utiliser les blocs SEARCH/REPLACE avec le fichier cible.

\`\`\`typescript
[FILE: nom_du_fichier.ts]
<<<< SEARCH
code_exact_existant
====
nouveau_code
>>>>
\`\`\`

Règles :
1. SEARCH doit être un copié-collé STRICT.
2. Inclure 2 lignes de contexte avant et après.
3. Si tu crées un nouveau fichier : [CREATE_FILE: chemin] suivi du contenu complet.`;
    }

    private _isOpenAI(url: string): boolean {
        return url.includes('together') || url.includes('openrouter') || url.endsWith('/v1');
    }

    _detectProvider(url: string): string {
        const u = (url || '').toLowerCase();
        if (!u || u.includes('localhost') || u.includes('127.0.0.1')) return 'local';
        if (u.includes('generativelanguage.googleapis.com')) return 'gemini';
        if (u.includes('openai.com')) return 'openai';
        if (u.includes('openrouter')) return 'openrouter';
        if (u.includes('together')) return 'together';
        if (u.includes('mistral')) return 'mistral';
        if (u.includes('groq')) return 'groq';
        if (u.includes('anthropic') || u.includes('claude')) return 'anthropic';
        return 'ollama-cloud';
    }

    private _isGemini(url: string): boolean {
        return url.includes('generativelanguage.googleapis.com');
    }

    private async _listGeminiModels(apiKey: string): Promise<string[]> {
        try {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
            const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return [];
            const data: any = await res.json();
            return (data?.models || [])
                .map((m: any) => (m.name as string).replace('models/', ''))
                .filter((n: string) => n.includes('gemini'));
        } catch { return []; }
    }

    async listModels(): Promise<string[]> {
        const url = this._getBaseUrl();
        const { key: apiKey } = this._getAvailableKey(url);
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        try {
            const isOpenAI = this._isOpenAI(url);
            const endpoint = isOpenAI ? `${url}/models` : `${url}/api/tags`;
            const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(5000) });
            if (!response.ok) return [];
            const data: any = await response.json();
            return isOpenAI
                ? (data?.data || []).map((m: any) => m.id).filter(Boolean)
                : (data?.models || []).map((m: any) => m.name).filter(Boolean);
        } catch { return []; }
    }

    async listAllModels(): Promise<{ name: string; isLocal: boolean; url: string; provider: string }[]> {
        const result: { name: string; isLocal: boolean; url: string; provider: string }[] = [];
        const seen = new Set<string>();

        const LOCAL_URL = 'http://localhost:11434';
        try {
            const res = await fetch(`${LOCAL_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) {
                const data: any = await res.json();
                for (const m of (data?.models || []).map((x: any) => x.name).filter(Boolean)) {
                    const key = `${LOCAL_URL}||${m}`;
                    if (!seen.has(key)) { seen.add(key); result.push({ name: m, isLocal: true, url: LOCAL_URL, provider: 'local' }); }
                }
            }
        } catch { }

        const configuredUrl = this._getBaseUrl().replace(/\/+$/, '');
        if (configuredUrl !== LOCAL_URL && configuredUrl !== 'http://127.0.0.1:11434') {
            try {
                const isOpenAI = this._isOpenAI(configuredUrl);
                const endpoint = isOpenAI ? `${configuredUrl}/models` : `${configuredUrl}/api/tags`;
                const { key } = this._getAvailableKey(configuredUrl);
                const headers: Record<string, string> = {};
                if (key) headers['Authorization'] = `Bearer ${key}`;
                const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(4000) });
                if (res.ok) {
                    const data: any = await res.json();
                    const list: string[] = isOpenAI
                        ? (data?.data || []).map((m: any) => m.id as string).filter(Boolean)
                        : (data?.models || []).map((m: any) => (m.name ?? m.id) as string).filter(Boolean);
                    for (const m of list) {
                        const k = `${configuredUrl}||${m}`;
                        if (!seen.has(k)) { seen.add(k); result.push({ name: m, isLocal: false, url: configuredUrl, provider: this._detectProvider(configuredUrl) }); }
                    }
                }
            } catch { }
        }

        for (const entry of this.getApiKeys()) {
            if (!entry.url) continue;
            const baseUrl = entry.url.replace(/\/+$/, '');
            const alreadyDoneAsLocal = (baseUrl === LOCAL_URL || baseUrl === 'http://127.0.0.1:11434') && !entry.key;
            if (alreadyDoneAsLocal) continue;
            const provider = this._detectProvider(baseUrl);
            try {
                let list: string[] = [];
                if (provider === 'gemini' && entry.key) {
                    list = await this._listGeminiModels(entry.key);
                } else {
                    const isOpenAI = this._isOpenAI(baseUrl);
                    const endpoint = isOpenAI ? `${baseUrl}/models` : `${baseUrl}/api/tags`;
                    const fetchHeaders: Record<string, string> = {};
                    if (entry.key) fetchHeaders['Authorization'] = `Bearer ${entry.key}`;
                    const res = await fetch(endpoint, { headers: fetchHeaders, signal: AbortSignal.timeout(4000) });
                    if (res.ok) {
                        const data: any = await res.json();
                        list = isOpenAI
                            ? (data?.data || []).map((m: any) => m.id as string).filter(Boolean)
                            : (data?.models || []).map((m: any) => (m.name ?? m.id) as string).filter(Boolean);
                    }
                }
                const filteredList = provider === 'openrouter' ? list.filter((m: string) => m.endsWith(':free')) : list;
                for (const m of filteredList) {
                    const k = `${baseUrl}||${m}`;
                    const isLocal = !entry.key && (baseUrl === LOCAL_URL || baseUrl === 'http://127.0.0.1:11434');
                    if (!seen.has(k)) { seen.add(k); result.push({ name: m, isLocal, url: baseUrl, provider: isLocal ? 'local' : provider }); }
                }
            } catch { }
        }

        return result;
    }

    async checkConnection(): Promise<boolean> {
        const url = this._getBaseUrl();
        const { key: apiKey } = this._getAvailableKey(url);
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        try {
            const isOpenAI = this._isOpenAI(url);
            const endpoint = isOpenAI ? `${url}/models` : `${url}/api/tags`;
            const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(3000) });
            return response.ok;
        } catch { return false; }
    }

    dispose() {
        this.router.dispose();
    }
}