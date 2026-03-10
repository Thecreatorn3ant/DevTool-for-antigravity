import * as vscode from 'vscode';

export interface ModelConfig {
    name: string;
    displayName: string;
    contextLimit: number;
    provider: 'local' | 'cloud' | 'lmstudio';
    baseUrl?: string;
    capabilities: {
        vision: boolean;
        functionCalling: boolean;
        streaming: boolean;
    };
    costPerToken?: number;
    userOverride?: boolean;
}

/**
 * Gestionnaire de configuration des modèles avec détection automatique
 * et support pour les modèles récents avec contextes étendus
 */
export class ModelConfigManager {
    private _configs: Map<string, ModelConfig> = new Map();
    private _context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
        this._loadConfigs();
        this._initializeDefaultConfigs();
    }

    /**
     * Détecte automatiquement la limite de contexte pour un modèle
     */
    async detectContextLimit(modelName: string, baseUrl: string, apiKey?: string): Promise<number> {
        const name = modelName.toLowerCase();

        // 1. Vérifier si une config utilisateur existe
        const userConfig = this._configs.get(modelName);
        if (userConfig?.userOverride) {
            return userConfig.contextLimit;
        }

        // 2. Essayer de récupérer via l'API Ollama
        if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
            const ollamaLimit = await this._getOllamaContextLimit(modelName, baseUrl);
            if (ollamaLimit > 0) return ollamaLimit;
        }

        // 3. Détection intelligente par patterns de noms
        return this._detectByModelName(name);
    }

    private async _getOllamaContextLimit(model: string, baseUrl: string): Promise<number> {
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
                    console.log(`[ModelConfig] Détecté ${numCtx} tokens pour ${model} via API Ollama`);
                    return numCtx;
                }
            }
        } catch (e: any) {
            console.warn(`[ModelConfig] Erreur API Ollama pour ${model}: ${e.message}`);
        }
        return 0;
    }

    private _detectByModelName(name: string): number {
        // Modèles avec contexte ultra-long (1M+ tokens)
        if (name.includes('gemini-2.0-flash-thinking') || 
            name.includes('gemini-2.0-flash-exp') ||
            name.includes('gemini-exp-1206')) {
            return 1_000_000;
        }

        if (name.includes('deepseek-v3') || 
            name.includes('deepseek-r1') ||
            name.includes('deepseek-coder-v2')) {
            return 131_072;
        }

        // Claude via Ollama (bjoernb/claude-opus-4.5:latest)
        if (name.includes('claude-opus-4') || name.includes('claude-sonnet-4')) {
            return 200_000;
        }
        if (name.includes('claude-3.5') || name.includes('claude-3-5')) {
            return 200_000;
        }
        if (name.includes('claude')) {
            return 100_000;
        }

        // Gemini Flash 2.0 et 1.5 Pro
        if (name.includes('gemini-2.0-flash') || name.includes('gemini-flash-2')) {
            return 1_000_000;
        }
        if (name.includes('gemini-1.5-pro') || name.includes('gemini-pro-1.5')) {
            return 1_000_000;
        }
        if (name.includes('gemini-1.5-flash') || name.includes('gemini-flash-1.5')) {
            return 1_000_000;
        }

        // Llama 3.3, 3.2, 3.1
        if (name.includes('llama-3.3') || name.includes('llama3.3')) {
            return 131_072;
        }
        if (name.includes('llama-3.2') || name.includes('llama3.2')) {
            return 131_072;
        }
        if (name.includes('llama-3.1') || name.includes('llama3.1')) {
            return 131_072;
        }

        // Qwen 2.5 Coder (contexte massif)
        if (name.includes('qwen2.5-coder') || name.includes('qwen-2.5-coder')) {
            return 131_072;
        }
        if (name.includes('qwen2.5') || name.includes('qwen-2.5')) {
            return 131_072;
        }

        // Ministral et Mistral Nemo
        if (name.includes('ministral')) {
            return 131_072;
        }
        if (name.includes('mistral-nemo') || name.includes('mistral-small-3')) {
            return 131_072;
        }
        if (name.includes('mixtral')) {
            return 45_000;
        }
        if (name.includes('mistral')) {
            return 32_768;
        }

        // Command-R et Granite
        if (name.includes('command-r')) {
            return 131_072;
        }
        if (name.includes('granite3')) {
            return 131_072;
        }

        // Phi 4
        if (name.includes('phi-4') || name.includes('phi4')) {
            return 16_384;
        }
        if (name.includes('phi-3.5') || name.includes('phi3.5')) {
            return 16_384;
        }

        // Gemma 3
        if (name.includes('gemma3')) {
            return 131_072;
        }
        if (name.includes('gemma2')) {
            return 8_192;
        }

        // CodeLlama
        if (name.includes('codellama') || name.includes('code-llama')) {
            return 16_384;
        }

        // StarCoder2
        if (name.includes('starcoder2') || name.includes('starcoder-2')) {
            return 16_384;
        }

        // Modèles vision
        if (name.includes('llava-llama3')) {
            return 131_072;
        }
        if (name.includes('llava')) {
            return 4_096;
        }

        // Valeur par défaut conservative
        console.warn(`[ModelConfig] Modèle inconnu "${name}", utilisation de 8192 tokens par défaut`);
        return 8_192;
    }

    /**
     * Permet à l'utilisateur de configurer manuellement un modèle
     */
    async configureModel(modelName: string): Promise<void> {
        const currentConfig = this._configs.get(modelName) || {
            name: modelName,
            displayName: modelName,
            contextLimit: 8192,
            provider: 'local' as const,
            capabilities: { vision: false, functionCalling: false, streaming: true },
        };

        const contextInput = await vscode.window.showInputBox({
            prompt: `Limite de contexte pour ${modelName} (en tokens)`,
            value: currentConfig.contextLimit.toString(),
            placeHolder: '8192',
            validateInput: (value) => {
                const num = parseInt(value);
                if (isNaN(num) || num <= 0) return 'Nombre invalide';
                if (num > 2_000_000) return 'Limite trop élevée (max 2M)';
                return null;
            }
        });

        if (!contextInput) return;

        const hasVision = await vscode.window.showQuickPick(['Oui', 'Non'], {
            placeHolder: 'Le modèle supporte-t-il la vision (images) ?'
        });

        const config: ModelConfig = {
            ...currentConfig,
            contextLimit: parseInt(contextInput),
            capabilities: {
                ...currentConfig.capabilities,
                vision: hasVision === 'Oui',
            },
            userOverride: true,
        };

        this._configs.set(modelName, config);
        await this._saveConfigs();

        vscode.window.showInformationMessage(
            `✅ Configuration sauvegardée pour ${modelName}: ${config.contextLimit} tokens`
        );
    }

    /**
     * Obtient la config d'un modèle (détection auto si inexistante)
     */
    async getConfig(modelName: string, baseUrl: string, apiKey?: string): Promise<ModelConfig> {
        let config = this._configs.get(modelName);
        
        if (!config) {
            const contextLimit = await this.detectContextLimit(modelName, baseUrl, apiKey);
            config = {
                name: modelName,
                displayName: modelName,
                contextLimit,
                provider: this._detectProvider(baseUrl),
                capabilities: this._detectCapabilities(modelName),
            };
            this._configs.set(modelName, config);
        }

        return config;
    }

    getMaxChars(modelName: string): number {
        const config = this._configs.get(modelName);
        if (!config) return 32_000; // fallback
        // Ratio conservateur : 1 token ≈ 4 chars
        return config.contextLimit * 4;
    }

    private _detectProvider(baseUrl: string): 'local' | 'cloud' | 'lmstudio' {
        const url = baseUrl.toLowerCase();
        if (url.includes('localhost') || url.includes('127.0.0.1')) {
            if (url.includes(':1234')) return 'lmstudio';
            return 'local';
        }
        return 'cloud';
    }

    private _detectCapabilities(modelName: string): ModelConfig['capabilities'] {
        const name = modelName.toLowerCase();
        return {
            vision: name.includes('vision') || 
                    name.includes('llava') || 
                    name.includes('gemini') ||
                    name.includes('claude') ||
                    name.includes('gpt-4'),
            functionCalling: name.includes('gpt-4') || 
                            name.includes('claude') ||
                            name.includes('gemini') ||
                            name.includes('mistral'),
            streaming: true, // Presque tous les modèles supportent le streaming
        };
    }

    private _initializeDefaultConfigs(): void {
        // Pré-charger les configs pour les modèles populaires
        const defaults: Array<[string, number]> = [
            ['deepseek-r1:latest', 131_072],
            ['deepseek-v3:latest', 131_072],
            ['deepseek-coder-v2:latest', 131_072],
            ['qwen2.5-coder:latest', 131_072],
            ['llama3.3:latest', 131_072],
            ['gemini-2.0-flash-exp', 1_000_000],
            ['gemini-1.5-pro', 1_000_000],
            ['claude-opus-4.5:latest', 200_000],
        ];

        for (const [name, limit] of defaults) {
            if (!this._configs.has(name)) {
                this._configs.set(name, {
                    name,
                    displayName: name,
                    contextLimit: limit,
                    provider: 'local',
                    capabilities: this._detectCapabilities(name),
                });
            }
        }
    }

    private async _loadConfigs(): Promise<void> {
        const stored = this._context.globalState.get<Record<string, ModelConfig>>('modelConfigs');
        if (stored) {
            for (const [key, config] of Object.entries(stored)) {
                this._configs.set(key, config);
            }
        }
    }

    private async _saveConfigs(): Promise<void> {
        const obj: Record<string, ModelConfig> = {};
        for (const [key, config] of this._configs) {
            if (config.userOverride) {
                obj[key] = config;
            }
        }
        await this._context.globalState.update('modelConfigs', obj);
    }

    getAllConfigs(): ModelConfig[] {
        return Array.from(this._configs.values());
    }

    async resetConfig(modelName: string): Promise<void> {
        this._configs.delete(modelName);
        await this._saveConfigs();
        vscode.window.showInformationMessage(`Configuration réinitialisée pour ${modelName}`);
    }
}
