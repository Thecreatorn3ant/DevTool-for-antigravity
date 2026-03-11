import * as vscode from 'vscode';

const KEY_PREFIX = 'antigravity-apikey-';
const KEY_INDEX = 'antigravity-key-index';

export interface SecretKeyMeta {
    id: string;
    name: string;
    url: string;
    platform?: string;
    addedAt?: number;
    rateLimitedUntil?: number;
}

export class SecretKeyStore {
    constructor(private readonly _secrets: vscode.SecretStorage) { }

    private _generateId(): string {
        return `key_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    async getKeyIndex(): Promise<SecretKeyMeta[]> {
        const raw = await this._secrets.get(KEY_INDEX);
        if (!raw) return [];
        try {
            return JSON.parse(raw) as SecretKeyMeta[];
        } catch {
            return [];
        }
    }

    private async _saveKeyIndex(index: SecretKeyMeta[]): Promise<void> {
        await this._secrets.store(KEY_INDEX, JSON.stringify(index));
    }

    async storeKey(name: string, url: string, key: string, platform?: string): Promise<SecretKeyMeta> {
        const id = this._generateId();
        const meta: SecretKeyMeta = {
            id,
            name,
            url,
            platform,
            addedAt: Date.now(),
        };

        await this._secrets.store(`${KEY_PREFIX}${id}`, key);

        const index = await this.getKeyIndex();
        index.push(meta);
        await this._saveKeyIndex(index);

        return meta;
    }

    async getKey(id: string): Promise<string> {
        return (await this._secrets.get(`${KEY_PREFIX}${id}`)) ?? '';
    }

    async getAllKeysWithSecrets(): Promise<Array<SecretKeyMeta & { key: string }>> {
        const index = await this.getKeyIndex();
        const result: Array<SecretKeyMeta & { key: string }> = [];
        for (const meta of index) {
            const key = await this.getKey(meta.id);
            result.push({ ...meta, key });
        }
        return result;
    }

    async updateKeyMeta(id: string, updates: Partial<Omit<SecretKeyMeta, 'id' | 'addedAt'>>): Promise<void> {
        const index = await this.getKeyIndex();
        const entry = index.find(k => k.id === id);
        if (!entry) return;
        if (updates.name !== undefined) entry.name = updates.name;
        if (updates.url !== undefined) entry.url = updates.url;
        if (updates.platform !== undefined) entry.platform = updates.platform;
        if (updates.rateLimitedUntil !== undefined) entry.rateLimitedUntil = updates.rateLimitedUntil;
        await this._saveKeyIndex(index);
    }

    async updateKeySecret(id: string, newKey: string): Promise<void> {
        await this._secrets.store(`${KEY_PREFIX}${id}`, newKey);
    }

    async deleteKey(id: string): Promise<void> {
        await this._secrets.delete(`${KEY_PREFIX}${id}`);
        const index = await this.getKeyIndex();
        const filtered = index.filter(k => k.id !== id);
        await this._saveKeyIndex(filtered);
    }

    async findByUrlAndKey(url: string, keyValue: string): Promise<SecretKeyMeta | null> {
        const all = await this.getAllKeysWithSecrets();
        return all.find(k => k.url === url && k.key === keyValue) ?? null;
    }

    async migrateFromSettings(): Promise<number> {
        const config = vscode.workspace.getConfiguration('local-ai');
        const oldKeys: any[] = config.get<any[]>('apiKeys') ?? [];
        const oldSingleKey = config.get<string>('apiKey') ?? '';
        const oldUrl = config.get<string>('ollamaUrl') ?? '';

        let migrated = 0;
        const existingIndex = await this.getKeyIndex();

        for (const old of oldKeys) {
            if (!old || !old.key) continue;
            const url = old.url || old.platform || '';
            if (!url) continue;

            const exists = existingIndex.find(
                k => k.url === url && k.name === (old.label || old.name || 'Migrated')
            );
            if (exists) continue;

            await this.storeKey(
                old.label || old.name || `Provider ${migrated + 1}`,
                url,
                old.key,
                old.platform
            );
            migrated++;
        }

        if (oldSingleKey && oldUrl && !oldUrl.includes('localhost') && !oldUrl.includes('127.0.0.1')) {
            const exists = existingIndex.find(k => k.url === oldUrl);
            if (!exists) {
                await this.storeKey('Migrated API Key', oldUrl, oldSingleKey);
                migrated++;
            }
        }

        if (migrated > 0) {
            console.log(`[Antigravity] SecretKeyStore: migrated ${migrated} key(s) from settings.json`);
        }

        return migrated;
    }

    async resetKeyCooldown(id: string): Promise<void> {
        await this.updateKeyMeta(id, { rateLimitedUntil: 0 });
    }
}
