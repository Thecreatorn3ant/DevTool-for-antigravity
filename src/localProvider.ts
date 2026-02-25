import * as vscode from 'vscode';
import { AttachedImage, estimateTokens } from './ollamaClient';

export const LOCAL_OLLAMA_URLS = [
    'http://localhost:11434',
    'http://127.0.0.1:11434',
];

export function isLocalUrl(url: string): boolean {
    const u = (url || '').toLowerCase().replace(/\/+$/, '');
    return u.includes('localhost') || u.includes('127.0.0.1');
}

const LOCAL_CTX: Record<string, number> = {
    'llama3.3': 131072,
    'llama3.2': 131072,
    'llama3.1': 131072,
    'llama3': 8192,
    'ministral': 131072,
    'mistral-small': 32768,
    'mistral-nemo': 131072,
    'mistral': 32768,
    'mixtral': 45000,
    'deepseek-r1': 131072,
    'deepseek-v3': 131072,
    'deepseek-coder-v2': 131072,
    'deepseek-coder': 16384,
    'qwen2.5-coder': 131072,
    'qwen2.5': 131072,
    'qwen2': 32768,
    'qwen': 8192,
    'codellama': 16384,
    'phi4': 16384,
    'phi3.5': 16384,
    'phi3': 4096,
    'phi': 2048,
    'gemma3': 131072,
    'gemma2': 8192,
    'gemma': 8192,
    'llava-llama3': 131072,
    'llava-phi3': 4096,
    'llava': 4096,
    'bakllava': 4096,
    'moondream': 2048,
    'command-r': 131072,
    'granite3': 131072,
    'starcoder2': 16384,
    'starcoder': 8192,
    'openchat': 8192,
    'vicuna': 4096,
};

const _ctxCache = new Map<string, number>();

export async function getLocalContextSize(model: string, baseUrl: string = 'http://localhost:11434'): Promise<number> {
    const cacheKey = `${baseUrl}||${model}`;
    if (_ctxCache.has(cacheKey)) return _ctxCache.get(cacheKey)!;

    try {
        const res = await fetch(`${baseUrl}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: model }),
            signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
            const data: any = await res.json();
            const numCtx: number | undefined =
                data?.model_info?.['llm.context_length'] ??
                data?.parameters?.num_ctx ??
                data?.details?.context_length;
            if (numCtx && numCtx > 0) {
                _ctxCache.set(cacheKey, numCtx);
                return numCtx;
            }
        }
    } catch { /* Ollama inaccessible → fallback */ }

    const m = model.toLowerCase();
    const sorted = Object.entries(LOCAL_CTX).sort((a, b) => b[0].length - a[0].length);
    for (const [key, limit] of sorted) {
        if (m.includes(key)) {
            _ctxCache.set(cacheKey, limit);
            return limit;
        }
    }
    return 8192;
}

export async function getLocalMaxChars(model: string, baseUrl?: string): Promise<number> {
    const tokens = await getLocalContextSize(model, baseUrl ?? 'http://localhost:11434');
    return tokens * 4;
}

export interface LocalRequestOptions {
    model: string;
    prompt: string;
    systemPrompt: string;
    images?: AttachedImage[];
    signal?: AbortSignal;
    baseUrl?: string;
    apiKey?: string;
}

export async function localStream(
    opts: LocalRequestOptions,
    onChunk: (text: string) => void
): Promise<string> {
    const baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    const endpoint = `${baseUrl}/api/generate`;

    const reqBody: any = {
        model: opts.model,
        prompt: opts.prompt,
        system: opts.systemPrompt,
        stream: true,
    };
    if (opts.images && opts.images.length > 0) {
        reqBody.images = opts.images.map(i => i.base64);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: opts.signal,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`Ollama local HTTP ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Impossible de lire le flux Ollama.');

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
            const clean = line.trim();
            if (!clean) continue;
            try {
                const data = JSON.parse(clean);
                if (data.error) throw new Error(`Ollama: ${data.error}`);
                if (data.response) {
                    fullResponse += data.response;
                    onChunk(data.response);
                }
            } catch (e: any) {
                if (e.message && !e.message.includes('JSON')) throw e;
            }
        }
    }

    if (buffer.trim()) {
        try {
            const data = JSON.parse(buffer);
            if (data.response) { fullResponse += data.response; onChunk(data.response); }
        } catch { }
    }

    return fullResponse;
}

export async function listLocalModels(baseUrl: string = 'http://localhost:11434', apiKey?: string): Promise<string[]> {
    try {
        const url = baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`;
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const finalUrl = `${url.replace(/\/+$/, '')}/api/tags`;
        console.log(`[Ollama] ListModels: ${finalUrl} (auth: ${!!apiKey})`);
        const res = await fetch(finalUrl, { headers, signal: AbortSignal.timeout(5000) });
        if (!res.ok) {
            console.error(`[Ollama] ListModels Failed: ${res.status} ${res.statusText}`);
            return [];
        }
        const data: any = await res.json();
        const models = (data?.models || []).map((m: any) => m.name as string).filter(Boolean);
        console.log(`[Ollama] ListModels Success: found ${models.length} models`);
        return models;
    } catch (e: any) {
        console.error(`[Ollama] ListModels Error: ${e.message}`);
        return [];
    }
}

export async function checkLocalConnection(baseUrl: string = 'http://localhost:11434', apiKey?: string): Promise<boolean> {
    try {
        const url = baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`;
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        const res = await fetch(`${url.replace(/\/+$/, '')}/api/tags`, { headers, signal: AbortSignal.timeout(5000) });
        return res.ok;
    } catch { return false; }
}
