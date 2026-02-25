import * as vscode from 'vscode';

export type TaskType = 'chat' | 'code' | 'vision' | 'commit' | 'agent';

export type RateLimitTier = 'session' | 'weekly' | 'suspended';

interface ProviderQuotaProfile {
    sessionThresholdMs: number;
    suspensionThresholdMs: number;
    quotaDescription: string;
}

const QUOTA_PROFILES: Record<string, ProviderQuotaProfile> = {
    'ollama-cloud': {
        sessionThresholdMs: 5 * 60 * 60 * 1000,
        suspensionThresholdMs: 4 * 24 * 60 * 60 * 1000,
        quotaDescription: 'Session (~5h) + quota hebdomadaire',
    },
    'gemini': {
        sessionThresholdMs: 60 * 60 * 1000,
        suspensionThresholdMs: 24 * 60 * 60 * 1000,
        quotaDescription: 'Quota journalier',
    },
    'groq': {
        sessionThresholdMs: 60 * 60 * 1000,
        suspensionThresholdMs: 24 * 60 * 60 * 1000,
        quotaDescription: 'Quota journalier',
    },
    'openrouter': {
        sessionThresholdMs: 30 * 60 * 1000,
        suspensionThresholdMs: 24 * 60 * 60 * 1000,
        quotaDescription: 'Quota journalier / crédits',
    },
    '_default': {
        sessionThresholdMs: 60 * 60 * 1000,
        suspensionThresholdMs: 24 * 60 * 60 * 1000,
        quotaDescription: 'Quota journalier',
    },
};

function getQuotaProfile(provider: string): ProviderQuotaProfile {
    return QUOTA_PROFILES[provider] ?? QUOTA_PROFILES['_default'];
}

function classifyRateLimit(provider: string, cooldownMs: number): RateLimitTier {
    const profile = getQuotaProfile(provider);
    if (cooldownMs >= profile.suspensionThresholdMs) return 'suspended';
    if (cooldownMs >= profile.sessionThresholdMs) return 'weekly';
    return 'session';
}

const FAILOVER_PRIORITY: string[] = ['local', 'openrouter', 'groq', 'mistral', 'together', 'openai', 'anthropic', 'ollama-cloud'];

export interface ProviderCapabilities {
    vision: boolean;
    streaming: boolean;
    maxContextK: number;
    freeDefault: boolean;
}

export interface ProviderHealth {
    url: string;
    apiKey: string;
    keyHint: string;
    name: string;
    provider: string;
    available: boolean;
    suspended: boolean;
    rateLimitTier: RateLimitTier;
    sessionHits: number;
    latencyMs: number;
    errorRate: number;
    rateLimitedUntil: number;
    lastChecked: number;
    totalRequests: number;
    totalErrors: number;
    totalTokens: number;
    capabilities: ProviderCapabilities;
}

export interface RouterStats {
    providers: ProviderHealth[];
    totalRequests: number;
    totalFailovers: number;
    totalSuspensions: number;
    queueLength: number;
    lastUpdated: number;
    forcedLocalActive: boolean;
}

export interface QueuedRequest {
    id: string;
    task: TaskType;
    resolve: (slot: SelectedSlot) => void;
    reject: (err: Error) => void;
    createdAt: number;
    timeoutMs: number;
}

export interface SelectedSlot {
    url: string;
    apiKey: string;
    name: string;
    provider: string;
}

export interface ProviderSuspendedEvent {
    url: string;
    name: string;
    provider: string;
    tier: RateLimitTier;
    rateLimitedUntil: number;
    cooldownHours: number;
    sessionHits: number;
    quotaDescription: string;
    exhaustedKeys: string[];
    remainingKeys: string[];
    failoverUrl: string | null;
    failoverName: string | null;
}

const PROVIDER_CAPS: Record<string, ProviderCapabilities> = {
    'local': { vision: true, streaming: true, maxContextK: 32, freeDefault: true },
    'gemini': { vision: true, streaming: true, maxContextK: 128, freeDefault: true },
    'openai': { vision: true, streaming: true, maxContextK: 128, freeDefault: false },
    'openrouter': { vision: true, streaming: true, maxContextK: 128, freeDefault: true },
    'together': { vision: false, streaming: true, maxContextK: 32, freeDefault: false },
    'mistral': { vision: false, streaming: true, maxContextK: 32, freeDefault: false },
    'groq': { vision: false, streaming: true, maxContextK: 32, freeDefault: false },
    'anthropic': { vision: true, streaming: true, maxContextK: 200, freeDefault: false },
    'ollama-cloud': { vision: true, streaming: true, maxContextK: 32, freeDefault: false },
};

export const FREE_MODELS: Record<string, string[]> = {
    'gemini': ['gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-2.0-flash'],
    'openrouter': [],
    'groq': ['llama-3.1-8b-instant', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
    'local': [],
};

export class ProviderRouter {
    private _health = new Map<string, ProviderHealth>();
    private _fullKeys = new Map<string, string>();
    private _queue: QueuedRequest[] = [];
    private _queueTimer?: NodeJS.Timeout;
    private _forcedLocalActive = false;
    private _stats: RouterStats = {
        providers: [],
        totalRequests: 0,
        totalFailovers: 0,
        totalSuspensions: 0,
        queueLength: 0,
        lastUpdated: Date.now(),
        forcedLocalActive: false,
    };

    private _onStatsChanged?: (stats: RouterStats) => void;
    private _onProviderSuspended?: (event: ProviderSuspendedEvent) => void;

    registerProvider(url: string, name: string, provider: string, apiKey: string = '') {
        const slot = this._slotKey(url, apiKey);
        this._fullKeys.set(slot, apiKey);
        if (!this._health.has(slot)) {
            this._health.set(slot, {
                url,
                apiKey,
                keyHint: this._keyHint(apiKey),
                name,
                provider,
                available: true,
                suspended: false,
                rateLimitTier: 'session',
                sessionHits: 0,
                latencyMs: 0,
                errorRate: 0,
                rateLimitedUntil: 0,
                lastChecked: 0,
                totalRequests: 0,
                totalErrors: 0,
                totalTokens: 0,
                capabilities: PROVIDER_CAPS[provider] ?? PROVIDER_CAPS['ollama-cloud'],
            });
        }
        this._syncStats();
    }

    unregisterProvider(url: string, apiKey: string = '') {
        const slot = this._slotKey(url, apiKey);
        this._health.delete(slot);
        this._fullKeys.delete(slot);
        this._health.delete(this._urlKey(url));
        this._syncStats();
    }

    async selectProvider(
        task: TaskType,
        preferredUrl?: string,
        requireVision: boolean = false,
        preferredApiKey: string = ''
    ): Promise<SelectedSlot> {
        this._stats.totalRequests++;

        if (this._forcedLocalActive) {
            const local = this._findLocalProvider();
            if (local) return this._slotToSelected(local);
        }

        const now = Date.now();
        const allSlots = Array.from(this._health.values());
        const available = allSlots.filter(h =>
            !h.suspended &&
            h.rateLimitedUntil <= now &&
            h.available &&
            (!requireVision || h.capabilities.vision)
        );

        if (available.length === 0) {
            return this._enqueueRequest(task, requireVision);
        }

        if (preferredUrl) {
            const prefSlot = this._slotKey(preferredUrl, preferredApiKey);
            const exact = available.find(h => this._slotKey(h.url, this._fullKeys.get(this._slotKey(h.url, h.apiKey)) ?? '') === prefSlot);
            if (exact) return this._slotToSelected(exact);

            const preferredProvider = allSlots.find(h =>
                this._urlKey(h.url) === this._urlKey(preferredUrl)
            )?.provider;

            if (preferredProvider) {
                const sameType = available
                    .filter(h => h.provider === preferredProvider)
                    .sort((a, b) => this._score(b, task) - this._score(a, task));

                if (sameType.length > 0) {
                    this._stats.totalFailovers++;
                    return this._slotToSelected(sameType[0]);
                }
            }

            this._stats.totalFailovers++;
        }

        const best = available.sort((a, b) => this._score(b, task) - this._score(a, task))[0];
        return this._slotToSelected(best);
    }

    private _slotToSelected(h: ProviderHealth): SelectedSlot {
        return {
            url: h.url,
            apiKey: h.apiKey,
            name: h.name,
            provider: h.provider,
        };
    }

    private _score(h: ProviderHealth, task: TaskType): number {
        let score = 100;
        score -= Math.min(30, h.latencyMs / 100);
        score -= h.errorRate * 40;
        if (h.provider === 'local') score += 20;
        if (task === 'agent' && h.capabilities.maxContextK >= 100) score += 15;
        if (task === 'vision' && h.capabilities.vision) score += 25;
        if (h.capabilities.freeDefault) score += 10;
        return score;
    }


    reportSuccess(url: string, latencyMs: number, tokensUsed: number = 0, apiKey: string = '') {
        const h = this._health.get(this._slotKey(url, apiKey));
        if (!h) return;
        h.latencyMs = Math.round((h.latencyMs * 0.8) + (latencyMs * 0.2));
        h.totalRequests++;
        h.totalTokens += tokensUsed;
        h.available = true;
        h.lastChecked = Date.now();
        h.errorRate = Math.max(0, h.errorRate - 0.05);
        this._syncStats();
        this._drainQueue();
    }

    reportError(url: string, isRateLimit: boolean = false, cooldownMs: number = 60_000, apiKey: string = '') {
        const h = this._health.get(this._slotKey(url, apiKey));
        if (!h) return;
        h.totalRequests++;
        h.totalErrors++;
        h.errorRate = Math.min(1, h.errorRate + 0.2);
        h.lastChecked = Date.now();

        if (isRateLimit) {
            h.rateLimitedUntil = Date.now() + cooldownMs;
            h.available = true;
            this._checkRateLimitTier(h, cooldownMs);
        } else if (h.errorRate > 0.6) {
            h.available = false;
        }

        this._stats.totalFailovers++;
        this._syncStats();
    }

    reportRateLimit(url: string, retryAfterMs?: number, apiKey: string = '') {
        this.reportError(url, true, retryAfterMs ?? 60_000, apiKey);
    }

    setAvailable(url: string, available: boolean, apiKey: string = '') {
        const h = this._health.get(this._slotKey(url, apiKey));
        if (h) {
            h.available = available;
            if (available) {
                h.suspended = false;
                h.rateLimitTier = 'session';
            }
            this._syncStats();
        }
    }

    private _checkRateLimitTier(h: ProviderHealth, cooldownMs: number) {
        const tier = classifyRateLimit(h.provider, cooldownMs);
        const profile = getQuotaProfile(h.provider);
        h.rateLimitTier = tier;

        if (tier === 'session') {
            h.sessionHits++;
            return;
        }

        if (h.suspended && tier === 'suspended') return;

        if (tier === 'suspended') {
            h.suspended = true;
            this._stats.totalSuspensions++;
        }

        const now = Date.now();
        const allSlots = Array.from(this._health.values());

        const siblings = allSlots.filter(s =>
            s.provider === h.provider &&
            this._slotKey(s.url, s.apiKey) !== this._slotKey(h.url, h.apiKey)
        );

        const availableSiblings = siblings.filter(s =>
            !s.suspended &&
            s.rateLimitedUntil <= now &&
            s.available
        );

        if (availableSiblings.length > 0) {
            return;
        }

        const exhaustedKeys = siblings
            .filter(s => s.rateLimitedUntil > now || s.suspended)
            .map(s => `${s.name} (${s.apiKey})`);
        exhaustedKeys.unshift(`${h.name} (${h.apiKey})`);

        const remainingKeys: string[] = [];

        const failover = this._findBestFailover(h.provider);
        const cooldownHours = Math.ceil(cooldownMs / (60 * 60 * 1000));

        const event: ProviderSuspendedEvent = {
            url: h.url,
            name: h.name,
            provider: h.provider,
            tier,
            rateLimitedUntil: h.rateLimitedUntil,
            cooldownHours,
            sessionHits: h.sessionHits,
            quotaDescription: profile.quotaDescription,
            exhaustedKeys,
            remainingKeys,
            failoverUrl: failover?.url ?? null,
            failoverName: failover?.name ?? null,
        };

        this._onProviderSuspended?.(event);
        this._syncStats();
    }

    liftSuspension(url: string, apiKey: string = '') {
        const h = this._health.get(this._slotKey(url, apiKey));
        if (!h) return;
        h.suspended = false;
        h.rateLimitTier = 'session';
        h.rateLimitedUntil = 0;
        h.sessionHits = 0;
        h.available = true;
        h.errorRate = Math.max(0, h.errorRate - 0.3);
        this._syncStats();
        this._drainQueue();
    }

    isSuspended(url: string, apiKey: string = ''): boolean {
        const h = this._health.get(this._slotKey(url, apiKey));
        return h?.suspended ?? false;
    }

    getVisibleProviders(): ProviderHealth[] {
        return Array.from(this._health.values()).filter(h => !h.suspended);
    }

    getSuspendedProviders(): ProviderHealth[] {
        const now = Date.now();
        return Array.from(this._health.values()).filter(h =>
            h.suspended || h.rateLimitedUntil > now
        );
    }

    getProviderKeyStats(providerType: string): { total: number; available: number; exhausted: number } {
        const now = Date.now();
        const slots = Array.from(this._health.values()).filter(h => h.provider === providerType);
        const available = slots.filter(h => !h.suspended && h.rateLimitedUntil <= now && h.available);
        return {
            total: slots.length,
            available: available.length,
            exhausted: slots.length - available.length,
        };
    }

    forceLocal(active: boolean = true): { success: boolean; message: string } {
        const local = this._findLocalProvider();

        if (active && !local) {
            return {
                success: false,
                message: 'Aucune instance Ollama locale enregistrée. Lancez Ollama sur http://localhost:11434.',
            };
        }

        this._forcedLocalActive = active;
        this._stats.forcedLocalActive = active;
        this._syncStats();

        return {
            success: true,
            message: active
                ? `⚡ Mode local forcé — tout le trafic est routé vers ${local!.name}.`
                : '☁️ Mode local désactivé — routage automatique rétabli.',
        };
    }

    isForcedLocal(): boolean {
        return this._forcedLocalActive;
    }

    triggerFailover(url: string, cooldownMs = 4 * 24 * 60 * 60 * 1000, apiKey: string = ''): ProviderHealth | null {
        const h = this._health.get(this._slotKey(url, apiKey));
        if (!h) return null;
        h.rateLimitedUntil = Date.now() + cooldownMs;
        this._checkRateLimitTier(h, cooldownMs);
        return this._findBestFailover(h.provider);
    }

    private _findLocalProvider(): ProviderHealth | undefined {
        return Array.from(this._health.values()).find(h => h.provider === 'local');
    }

    private _findBestFailover(excludeProvider: string): ProviderHealth | null {
        const now = Date.now();
        const available = Array.from(this._health.values()).filter(h =>
            !h.suspended &&
            h.available &&
            h.rateLimitedUntil <= now &&
            h.provider !== excludeProvider
        );

        for (const priority of FAILOVER_PRIORITY) {
            const match = available.find(h => h.provider === priority);
            if (match) return match;
        }

        if (available.length > 0) {
            return available.sort((a, b) => this._score(b, 'chat') - this._score(a, 'chat'))[0];
        }

        return null;
    }


    getBestFreeModel(providerKey: string): string | null {
        const models = FREE_MODELS[providerKey];
        if (!models || models.length === 0) return null;
        return models[0];
    }

    getCapabilities(url: string): ProviderCapabilities | null {
        const h = this._health.get(this._urlKey(url));
        return h?.capabilities ?? null;
    }

    supportsVision(url: string): boolean {
        return this.getCapabilities(url)?.vision ?? false;
    }

    onStatsChanged(cb: (stats: RouterStats) => void) {
        this._onStatsChanged = cb;
    }

    onProviderSuspended(cb: (event: ProviderSuspendedEvent) => void) {
        this._onProviderSuspended = cb;
    }

    getStats(): RouterStats {
        return { ...this._stats };
    }

    getProviderHealth(url: string, apiKey: string = ''): ProviderHealth | undefined {
        return this._health.get(this._slotKey(url, apiKey));
    }

    getAllHealth(): ProviderHealth[] {
        return Array.from(this._health.values());
    }

    getCooldownSummary(): string {
        const now = Date.now();
        const cooled = Array.from(this._health.values())
            .filter(h => h.rateLimitedUntil > now)
            .map(h => {
                const remainMs = h.rateLimitedUntil - now;
                const time = remainMs >= 24 * 3_600_000
                    ? `${Math.ceil(remainMs / (24 * 3_600_000))}j`
                    : remainMs >= 3_600_000
                        ? `${Math.ceil(remainMs / 3_600_000)}h`
                        : `${Math.ceil(remainMs / 1000)}s`;
                const tierLabel =
                    h.rateLimitTier === 'suspended' ? '🔴 suspendu' :
                        h.rateLimitTier === 'weekly' ? '🟠 quota semaine' :
                            '🟡 session';
                return `${h.name}: ${time} (${tierLabel})`;
            });
        return cooled.length > 0 ? cooled.join(', ') : 'Aucun cooldown actif';
    }

    private _enqueueRequest(task: TaskType, requireVision: boolean): Promise<SelectedSlot> {
        return new Promise((resolve, reject) => {
            const id = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const entry: QueuedRequest = {
                id, task, resolve, reject,
                createdAt: Date.now(),
                timeoutMs: 120_000,
            };
            this._queue.push(entry);
            this._stats.queueLength = this._queue.length;
            this._syncStats();

            setTimeout(() => {
                const idx = this._queue.findIndex(q => q.id === id);
                if (idx >= 0) {
                    this._queue.splice(idx, 1);
                    this._stats.queueLength = this._queue.length;
                    this._syncStats();
                    reject(new Error('Tous les providers sont indisponibles. Réessayez dans quelques instants.'));
                }
            }, entry.timeoutMs);

            if (!this._queueTimer) {
                this._queueTimer = setInterval(() => this._drainQueue(), 5_000);
            }
        });
    }

    private _drainQueue() {
        if (this._queue.length === 0) {
            if (this._queueTimer) { clearInterval(this._queueTimer); this._queueTimer = undefined; }
            return;
        }
        const now = Date.now();
        const available = Array.from(this._health.values())
            .filter(h => h.available && !h.suspended && h.rateLimitedUntil <= now);

        if (available.length === 0) return;

        const best = available.sort((a, b) => this._score(b, 'chat') - this._score(a, 'chat'))[0];
        const next = this._queue.shift();
        if (next) {
            this._stats.queueLength = this._queue.length;
            this._syncStats();
            next.resolve(this._slotToSelected(best));
        }
    }

    async pingProvider(url: string, apiKey: string = ''): Promise<{ ok: boolean; latencyMs: number }> {
        const t0 = Date.now();
        const isOpenAI = url.includes('together') || url.includes('openrouter') || url.endsWith('/v1');
        const isGemini = url.includes('generativelanguage.googleapis.com');
        let endpoint = isOpenAI ? `${url}/models` : `${url}/api/tags`;
        if (isGemini && apiKey) endpoint = `${url}/models?key=${apiKey}`;
        try {
            const headers: Record<string, string> = {};
            if (apiKey && !isGemini) headers['Authorization'] = `Bearer ${apiKey}`;
            const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(4000) });
            const latencyMs = Date.now() - t0;
            const h = this._health.get(this._slotKey(url, apiKey));
            if (h) {
                h.latencyMs = latencyMs;
                if (res.ok) {
                    h.suspended = false;
                    h.rateLimitedUntil = 0;
                    h.available = true;
                    h.rateLimitTier = 'session';
                } else {
                    h.available = false;
                }
                h.lastChecked = Date.now();
                this._syncStats();
            }
            return { ok: res.ok, latencyMs };
        } catch {
            const h = this._health.get(this._slotKey(url, apiKey));
            if (h) { h.available = false; h.lastChecked = Date.now(); this._syncStats(); }
            return { ok: false, latencyMs: Date.now() - t0 };
        }
    }

    private _slotKey(url: string, apiKey: string = ''): string {
        const normalUrl = (url || '').replace(/\/+$/, '').toLowerCase();
        const keyFragment = apiKey ? apiKey.substring(0, 8).toLowerCase() : '';
        return keyFragment ? `${normalUrl}||${keyFragment}` : normalUrl;
    }

    private _keyHint(apiKey: string): string {
        if (!apiKey) return '';
        return apiKey.length > 8
            ? `${apiKey.substring(0, 4)}…${apiKey.slice(-4)}`
            : `${apiKey.substring(0, 4)}…`;
    }

    private _urlKey(url: string): string {
        return (url || '').replace(/\/+$/, '').toLowerCase();
    }

    private _syncStats() {
        this._stats.providers = Array.from(this._health.values()).map(h => ({
            ...h,
            apiKey: h.keyHint
        }));
        this._stats.queueLength = this._queue.length;
        this._stats.lastUpdated = Date.now();
        this._stats.forcedLocalActive = this._forcedLocalActive;
        this._onStatsChanged?.(this.getStats());
    }

    dispose() {
        if (this._queueTimer) clearInterval(this._queueTimer);
        this._queue.forEach(q => q.reject(new Error('Router disposed')));
        this._queue = [];
    }
}