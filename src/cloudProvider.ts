import { AttachedImage } from './ollamaClient';

export type CloudProviderType =
    | 'openai-compat'
    | 'gemini'
    | 'unknown';

export function detectProviderName(url: string): string {
    const u = url.toLowerCase();
    if (u.includes('localhost') || u.includes('127.0.0.1')) return 'local';
    if (u.includes('generativelanguage.googleapis.com'))    return 'gemini';
    if (u.includes('openai.com'))                           return 'openai';
    if (u.includes('openrouter.ai'))                        return 'openrouter';
    if (u.includes('together.xyz') || u.includes('together.ai')) return 'together';
    if (u.includes('mistral.ai'))                           return 'mistral';
    if (u.includes('groq.com'))                             return 'groq';
    if (u.includes('anthropic.com') || u.includes('claude.ai')) return 'anthropic';
    if (u.includes('api.ollama.com') || u.includes('ollama.ai')) return 'ollama-cloud';
    return 'cloud';
}

export function detectCloudType(url: string): CloudProviderType {
    const u = url.toLowerCase();
    if (u.includes('generativelanguage.googleapis.com')) return 'gemini';
    if (!u.includes('localhost') && !u.includes('127.0.0.1')) return 'openai-compat';
    return 'unknown';
}

export function isCloudUrl(url: string): boolean {
    const u = (url || '').toLowerCase();
    return !!u && !u.includes('localhost') && !u.includes('127.0.0.1');
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
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

export async function listOpenAICompatModels(baseUrl: string, apiKey?: string): Promise<string[]> {
    try {
        const url = baseUrl.replace(/\/+$/, '');
        const endpoint = `${url}/models`;
        const headers: Record<string, string> = {};
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        if (url.includes('openrouter')) {
            headers['HTTP-Referer'] = 'https://github.com/microsoft/vscode';
            headers['X-Title'] = 'VSCode Antigravity';
        }
        const res = await fetch(endpoint, { headers, signal: AbortSignal.timeout(5000) });
        if (!res.ok) return [];
        const data: any = await res.json();
        const all: string[] = (data?.data || []).map((m: any) => m.id as string).filter(Boolean);
        if (url.includes('openrouter')) return all.filter(m => m.endsWith(':free'));
        return all;
    } catch { return []; }
}

export interface CloudRequestOptions {
    model: string;
    prompt: string;
    systemPrompt: string;
    baseUrl: string;
    apiKey: string;
    images?: AttachedImage[];
    signal?: AbortSignal;
}

export async function openAICompatStream(
    opts: CloudRequestOptions,
    onChunk: (text: string) => void
): Promise<string> {
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const endpoint = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${opts.apiKey}`,
    };

    if (baseUrl.includes('openrouter')) {
        headers['HTTP-Referer'] = 'https://github.com/microsoft/vscode';
        headers['X-Title'] = 'VSCode Antigravity';
    }

    let userContent: any;
    if (opts.images && opts.images.length > 0) {
        userContent = [
            ...opts.images.map(img => ({
                type: 'image_url',
                image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
            })),
            { type: 'text', text: opts.prompt }
        ];
    } else {
        userContent = opts.prompt;
    }

    const reqBody = {
        model: opts.model,
        messages: [
            { role: 'system', content: opts.systemPrompt },
            { role: 'user',   content: userContent },
        ],
        stream: true,
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal: opts.signal,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`HTTP ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Impossible de lire le flux SSE.');

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
            if (!clean || clean === 'data: [DONE]') continue;
            if (clean.startsWith('data: ')) {
                try {
                    const data = JSON.parse(clean.slice(6));
                    const chunk = data.choices?.[0]?.delta?.content;
                    if (chunk) { fullResponse += chunk; onChunk(chunk); }
                } catch { }
            }
        }
    }

    if (buffer.trim() && buffer.startsWith('data: ') && buffer !== 'data: [DONE]') {
        try {
            const data = JSON.parse(buffer.slice(6));
            const chunk = data.choices?.[0]?.delta?.content;
            if (chunk) { fullResponse += chunk; onChunk(chunk); }
        } catch { }
    }

    return fullResponse;
}

export async function geminiStream(
    opts: CloudRequestOptions,
    onChunk: (text: string) => void
): Promise<string> {
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const endpoint = `${baseUrl}/models/${opts.model}:streamGenerateContent?key=${opts.apiKey}`;

    const parts: any[] = [];

    if (opts.images && opts.images.length > 0) {
        for (const img of opts.images) {
            parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
        }
    }

    parts.push({ text: `${opts.systemPrompt}\n\n${opts.prompt}` });

    const reqBody = {
        contents: [{ role: 'user', parts }],
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: opts.signal,
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(`Gemini HTTP ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Impossible de lire le flux Gemini.');

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
            let clean = line.trim();
            if (!clean) continue;
            if (clean.startsWith(',')) clean = clean.slice(1).trim();
            if (clean.startsWith('[') || clean.startsWith(']')) continue;
            try {
                const data = JSON.parse(clean);
                const chunk = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (chunk) { fullResponse += chunk; onChunk(chunk); }
            } catch { }
        }
    }

    return fullResponse;
}

export async function cloudStream(
    opts: CloudRequestOptions,
    onChunk: (text: string) => void
): Promise<string> {
    const type = detectCloudType(opts.baseUrl);

    if (type === 'gemini') {
        return geminiStream(opts, onChunk);
    } else if (type === 'openai-compat') {
        return openAICompatStream(opts, onChunk);
    } else {
        throw new Error(`Provider cloud non reconnu pour l'URL : ${opts.baseUrl}`);
    }
}
