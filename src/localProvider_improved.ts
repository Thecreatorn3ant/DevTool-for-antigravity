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

/**
 * BASE DE DONNÉES AMÉLIORÉE DES CONTEXTES
 * Mis à jour avec les modèles récents (Mars 2026)
 */
const LOCAL_CTX: Record<string, number> = {
    // ========== MODÈLES ULTRA-LONG CONTEXT (1M+ tokens) ==========
    'gemini-2.0-flash-thinking': 1_000_000,
    'gemini-2.0-flash-exp': 1_000_000,
    'gemini-2.0-flash': 1_000_000,
    'gemini-flash-2': 1_000_000,
    'gemini-1.5-pro': 1_000_000,
    'gemini-pro-1.5': 1_000_000,
    'gemini-1.5-flash': 1_000_000,
    'gemini-flash-1.5': 1_000_000,
    'gemini-exp-1206': 1_000_000,

    // ========== DEEPSEEK (131k) ==========
    'deepseek-r1': 131_072,
    'deepseek-v3': 131_072,
    'deepseek-coder-v2': 131_072,
    'deepseek-v2.5': 131_072,
    'deepseek-coder': 16_384,  // v1 plus ancien

    // ========== LLAMA 3.x (131k) ==========
    'llama-3.3': 131_072,
    'llama3.3': 131_072,
    'llama-3.2': 131_072,
    'llama3.2': 131_072,
    'llama-3.1': 131_072,
    'llama3.1': 131_072,
    'llama-3': 8_192,    // v3.0 baseline
    'llama3': 8_192,

    // ========== QWEN 2.5 (131k) ==========
    'qwen2.5-coder': 131_072,
    'qwen-2.5-coder': 131_072,
    'qwen2.5': 131_072,
    'qwen-2.5': 131_072,
    'qwen2': 32_768,
    'qwen': 8_192,

    // ========== MISTRAL FAMILY ==========
    'ministral': 131_072,
    'mistral-small-3': 131_072,
    'mistral-small': 32_768,
    'mistral-nemo': 131_072,
    'mistral': 32_768,
    'mixtral': 45_000,

    // ========== CLAUDE (via Ollama, ex: bjoernb/claude-opus-4.5:latest) ==========
    'claude-opus-4': 200_000,
    'claude-sonnet-4': 200_000,
    'claude-3.5': 200_000,
    'claude-3-5': 200_000,
    'claude': 100_000,  // fallback générique

    // ========== COMMAND-R & GRANITE ==========
    'command-r': 131_072,
    'granite3': 131_072,
    'granite-3': 131_072,

    // ========== PHI FAMILY ==========
    'phi-4': 16_384,
    'phi4': 16_384,
    'phi-3.5': 16_384,
    'phi3.5': 16_384,
    'phi-3': 4_096,
    'phi3': 4_096,
    'phi': 2_048,

    // ========== GEMMA FAMILY ==========
    'gemma3': 131_072,
    'gemma-3': 131_072,
    'gemma2': 8_192,
    'gemma': 8_192,

    // ========== CODING MODELS ==========
    'codellama': 16_384,
    'code-llama': 16_384,
    'starcoder2': 16_384,
    'starcoder-2': 16_384,
    'starcoder': 8_192,

    // ========== VISION MODELS ==========
    'llava-llama3': 131_072,
    'llava-phi3': 4_096,
    'llava': 4_096,
    'bakllava': 4_096,
    'moondream': 2_048,

    // ========== AUTRES ==========
    'openchat': 8_192,
    'vicuna': 4_096,
};

const _ctxCache = new Map<string, number>();

/**
 * DÉTECTION INTELLIGENTE PAR NOM DE MODÈLE
 * Gère les patterns complexes et les variantes de nommage
 */
function detectContextByName(modelName: string): number {
    const name = modelName.toLowerCase();

    // 1. ULTRA-LONG CONTEXT (1M+)
    if (name.includes('gemini-2.0-flash') || 
        name.includes('gemini-flash-2') ||
        name.includes('gemini-exp-1206')) {
        console.log(`[LocalProvider] Détecté Gemini 2.0 Flash → 1M tokens`);
        return 1_000_000;
    }

    if (name.includes('gemini-1.5-pro') || 
        name.includes('gemini-pro-1.5') ||
        name.includes('gemini-1.5-flash') ||
        name.includes('gemini-flash-1.5')) {
        console.log(`[LocalProvider] Détecté Gemini 1.5 → 1M tokens`);
        return 1_000_000;
    }

    // 2. DEEPSEEK R1/V3 (131k)
    if (name.includes('deepseek-r1') || 
        name.includes('deepseek-v3') ||
        name.includes('deepseek-coder-v2')) {
        console.log(`[LocalProvider] Détecté DeepSeek R1/V3 → 131k tokens`);
        return 131_072;
    }

    // 3. CLAUDE (200k)
    if (name.includes('claude-opus-4') || 
        name.includes('claude-sonnet-4')) {
        console.log(`[LocalProvider] Détecté Claude 4 → 200k tokens`);
        return 200_000;
    }

    if (name.includes('claude-3.5') || name.includes('claude-3-5')) {
        console.log(`[LocalProvider] Détecté Claude 3.5 → 200k tokens`);
        return 200_000;
    }

    if (name.includes('claude')) {
        console.log(`[LocalProvider] Détecté Claude générique → 100k tokens`);
        return 100_000;
    }

    // 4. LLAMA 3.3/3.2/3.1 (131k)
    if (name.includes('llama-3.3') || name.includes('llama3.3')) {
        return 131_072;
    }
    if (name.includes('llama-3.2') || name.includes('llama3.2')) {
        return 131_072;
    }
    if (name.includes('llama-3.1') || name.includes('llama3.1')) {
        return 131_072;
    }

    // 5. QWEN 2.5 CODER (131k)
    if (name.includes('qwen2.5-coder') || name.includes('qwen-2.5-coder')) {
        return 131_072;
    }
    if (name.includes('qwen2.5') || name.includes('qwen-2.5')) {
        return 131_072;
    }

    // 6. MISTRAL FAMILY
    if (name.includes('ministral')) {
        return 131_072;
    }
    if (name.includes('mistral-nemo') || name.includes('mistral-small-3')) {
        return 131_072;
    }
    if (name.includes('mixtral')) {
        return 45_000;
    }

    // 7. COMMAND-R & GRANITE
    if (name.includes('command-r')) {
        return 131_072;
    }
    if (name.includes('granite3') || name.includes('granite-3')) {
        return 131_072;
    }

    // 8. GEMMA 3
    if (name.includes('gemma3') || name.includes('gemma-3')) {
        return 131_072;
    }

    // 9. PHI 4
    if (name.includes('phi-4') || name.includes('phi4')) {
        return 16_384;
    }
    if (name.includes('phi-3.5') || name.includes('phi3.5')) {
        return 16_384;
    }

    // 10. CODING MODELS
    if (name.includes('codellama') || name.includes('code-llama')) {
        return 16_384;
    }
    if (name.includes('starcoder2') || name.includes('starcoder-2')) {
        return 16_384;
    }

    // 11. VISION MODELS
    if (name.includes('llava-llama3')) {
        return 131_072;
    }
    if (name.includes('llava')) {
        return 4_096;
    }

    // 12. FALLBACK - Recherche dans la base complète
    const sorted = Object.entries(LOCAL_CTX).sort((a, b) => b[0].length - a[0].length);
    for (const [key, limit] of sorted) {
        if (name.includes(key)) {
            console.log(`[LocalProvider] Fallback match "${key}" → ${limit} tokens`);
            return limit;
        }
    }

    // 13. ULTIME FALLBACK
    console.warn(`[LocalProvider] ⚠️ Modèle inconnu "${modelName}" → 8k tokens par défaut`);
    return 8_192;
}

/**
 * RÉCUPÉRATION AMÉLIORÉE DU CONTEXTE
 * 1. Cache → 2. API Ollama → 3. Détection par nom
 */
export async function getLocalContextSize(model: string, baseUrl: string = 'http://localhost:11434'): Promise<number> {
    const cacheKey = `${baseUrl}||${model}`;
    
    // 1. Vérifier le cache
    if (_ctxCache.has(cacheKey)) {
        return _ctxCache.get(cacheKey)!;
    }

    // 2. Essayer via API Ollama
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
                console.log(`[LocalProvider] ✓ API Ollama: ${model} → ${numCtx} tokens`);
                _ctxCache.set(cacheKey, numCtx);
                return numCtx;
            }
        }
    } catch (e: any) {
        console.warn(`[LocalProvider] API Ollama inaccessible: ${e.message}`);
    }

    // 3. Détection par nom
    const detected = detectContextByName(model);
    _ctxCache.set(cacheKey, detected);
    return detected;
}

export async function getLocalMaxChars(model: string, baseUrl?: string): Promise<number> {
    const tokens = await getLocalContextSize(model, baseUrl ?? 'http://localhost:11434');
    // Ratio conservateur : 1 token ≈ 4 chars
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
