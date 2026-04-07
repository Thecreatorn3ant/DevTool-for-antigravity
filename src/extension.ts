import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';
import { ChatViewProvider } from './chatViewProvider';
import { FileContextManager } from './fileContextManager';
import { InlineCompletionProvider } from './inlineCompletionProvider';
import { CommitManager } from './commitManager';
import { ModelConfigManager } from './modelConfigManager';
import { ChatSessionManager } from './chatSessionManager';
import { I18nManager, Language } from './i18n';

export function activate(context: vscode.ExtensionContext) {
    console.log('[Antigravity] Extension activée');

    const modelConfigManager = new ModelConfigManager(context);
    const sessionManager = new ChatSessionManager(context);
    const i18n = new I18nManager(context);

    const ollamaClient = new OllamaClient(modelConfigManager);
    ollamaClient.initSecretStore(context.secrets).then(migrated => {
        if (migrated > 0) {
            vscode.window.showInformationMessage(`✅ ${migrated} clé(s) API sécurisée(s) avec succès.`);
        }
    });

    const fileCtxManager = new FileContextManager(context);
    const commitManager = new CommitManager(ollamaClient, fileCtxManager);
    const chatProvider = new ChatViewProvider(
        context,
        ollamaClient,
        fileCtxManager,
        sessionManager,
        commitManager,
        i18n
    );
    const inlineCompletionProvider = new InlineCompletionProvider(ollamaClient);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.openChat', () => {
            vscode.commands.executeCommand('local-ai.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.sendSelectionToChat', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('Aucun éditeur actif.'); return; }
            const selectedText = editor.document.getText(editor.selection);
            if (!selectedText) { vscode.window.showWarningMessage('Aucun texte sélectionné.'); return; }
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.sendMessageFromEditor(`Explique ce code :\n\`\`\`\n${selectedText}\n\`\`\``);
            }, 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.explainFile', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('Aucun fichier actif.'); return; }
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.sendMessageFromEditor('Explique le fichier actif et son rôle dans le projet.');
            }, 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.reviewDiff', async () => {
            const diff = await fileCtxManager.getGitDiff(false);
            if (!diff) {
                vscode.window.showWarningMessage('Aucun diff Git trouvé. Assurez-vous d\'avoir des modifications non commitées.');
                return;
            }
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.sendMessageFromEditor(
                    `Revois ce diff Git et identifie les bugs, problèmes de sécurité, ou oublis :\n\`\`\`diff\n${diff.substring(0, 8000)}\n\`\`\``
                );
            }, 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.generateCommitMessage', async () => {
            await commitManager.generateAndShowCommitUI();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.generateTests', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('Aucun fichier actif.'); return; }
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.sendMessageFromEditor(
                    'Génère les tests unitaires complets pour le fichier actif. Crée un fichier *.test.ts (ou .spec.ts) avec des cas de test réalistes couvrant les cas normaux et les cas limites.'
                );
            }, 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.analyzeError', async () => {
            const errorText = await vscode.window.showInputBox({
                prompt: 'Collez votre message d\'erreur ou stack trace',
                placeHolder: 'TypeError: Cannot read property \'x\' of undefined...',
                ignoreFocusOut: true,
            });
            if (!errorText) return;

            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.analyzeError(errorText);
            }, 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.updateProjectSummary', () => {
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.sendMessageFromEditor(
                    'Génère un résumé concis de ce projet (max 300 mots) : technos utilisées, architecture, rôle des dossiers principaux. Commence par [PROJECT_SUMMARY] et termine par [/PROJECT_SUMMARY].'
                );
            }, 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.thinkMode', () => {
            vscode.commands.executeCommand('local-ai.chatView.focus');
            chatProvider.activateThinkMode();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.lspDiagnostics', () => {
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => chatProvider.triggerLspAnalysis('workspace'), 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.runAgent', async () => {
            const goal = await vscode.window.showInputBox({
                prompt: 'Objectif de l\'agent autonome',
                placeHolder: 'ex: Corrige toutes les erreurs TypeScript du projet',
                ignoreFocusOut: true,
            });
            if (!goal) return;
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => chatProvider.runAgentFromCommand(goal), 300);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.resetChat', async () => {
            const result = await sessionManager.promptForReset();
            if (result.reset) {
                vscode.commands.executeCommand('local-ai.chatView.focus');
                await chatProvider.resetChat(result.template);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.configureModel', async () => {
            const model = await vscode.window.showInputBox({
                prompt: 'Nom du modèle à configurer (ex: deepseek-r1:latest)',
                placeHolder: 'deepseek-r1:latest',
                validateInput: (value) => {
                    return value.length > 0 ? null : 'Le nom du modèle ne peut pas être vide';
                }
            });
            if (model) {
                await modelConfigManager.configureModel(model);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.exportSession', async () => {
            await sessionManager.exportSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.importSession', async () => {
            await sessionManager.importSession();
            vscode.commands.executeCommand('local-ai.chatView.focus');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.createTemplate', async () => {
            await sessionManager.createCustomTemplate();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.showModelInfo', async () => {
            const config = vscode.workspace.getConfiguration('local-ai');
            const model = config.get<string>('defaultModel', 'llama3');
            const url = config.get<string>('ollamaUrl', 'http://localhost:11434');

            const modelConfig = await modelConfigManager.getConfig(model, url);

            const info = [
                `📊 Informations du Modèle`,
                ``,
                `Modèle : ${modelConfig.displayName}`,
                `Limite contexte : ${modelConfig.contextLimit.toLocaleString()} tokens`,
                `Max caractères : ${modelConfigManager.getMaxChars(model).toLocaleString()}`,
                `Vision : ${modelConfig.capabilities.vision ? '✅ Oui' : '❌ Non'}`,
                `Function Calling : ${modelConfig.capabilities.functionCalling ? '✅ Oui' : '❌ Non'}`,
                `Streaming : ${modelConfig.capabilities.streaming ? '✅ Oui' : '❌ Non'}`,
                `Provider : ${modelConfig.provider}`,
                ``,
                `${modelConfig.userOverride ? '⚙️ Configuration manuelle active' : '🤖 Détection automatique'}`,
            ].join('\n');

            vscode.window.showInformationMessage(info, { modal: true });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.resetModelConfig', async () => {
            const model = await vscode.window.showInputBox({
                prompt: 'Nom du modèle à réinitialiser',
                placeHolder: 'deepseek-r1:latest'
            });
            if (model) {
                await modelConfigManager.resetConfig(model);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { pattern: '**' },
            inlineCompletionProvider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.toggleInlineCompletion', () => {
            const enabled = inlineCompletionProvider.toggle();
            vscode.window.showInformationMessage(
                `🚀 Complétion en ligne : ${enabled ? 'Activée' : 'Désactivée'}`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.addRelatedFiles', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            const related = await fileCtxManager.getRelatedFiles(editor.document, 8000);
            if (related.length === 0) {
                vscode.window.showInformationMessage('Aucun fichier lié détecté via les imports.');
                return;
            }
            chatProvider.addFilesToContext(related);
            vscode.window.showInformationMessage(
                `${related.length} fichier(s) ajouté(s) au contexte : ${related.map(f => f.name).join(', ')}`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('local-ai.setLanguage', async () => {
            const result = await vscode.window.showQuickPick([
                { label: 'Français', value: 'fr' },
                { label: 'English', value: 'en' }
            ], { placeHolder: 'Sélectionnez votre langue / Select your language' });

            if (result) {
                await i18n.setLanguage(result.value as Language);
                vscode.window.showInformationMessage(
                    result.value === 'fr'
                        ? 'Langue changée en Français (Redémarrez le chat si nécessaire)'
                        : 'Language changed to English (Restart chat if necessary)'
                );
            }
        })
    );

    ollamaClient.checkConnection().then(connected => {
        if (!connected) {
            vscode.window.showWarningMessage(
                'Antigravity: Ollama semble inaccessible. Assurez-vous qu\'Ollama est lancé.',
                'OK'
            );
        }
    });
}

export function deactivate() {
    console.log('[Antigravity] Extension désactivée');
}