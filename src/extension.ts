import * as vscode from 'vscode';
import { OllamaClient } from './ollamaClient';
import { ChatViewProvider } from './chatViewProvider';
import { FileContextManager } from './fileContextManager';

export function activate(context: vscode.ExtensionContext) {
    console.log('[Antigravity] Extension activée');

    const ollamaClient = new OllamaClient();
    const fileCtxManager = new FileContextManager(context);
    const chatProvider = new ChatViewProvider(context, ollamaClient, fileCtxManager);

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
            const diff = await fileCtxManager.getStagedDiffForCommit();
            if (!diff) {
                vscode.window.showWarningMessage('Aucun fichier stagé. Faites d\'abord un `git add`.');
                return;
            }
            vscode.commands.executeCommand('local-ai.chatView.focus');
            setTimeout(() => {
                chatProvider.sendMessageFromEditor(
                    `Génère un message de commit conventionnel (feat/fix/refactor/...) pour ce diff stagé. Réponds UNIQUEMENT avec le message de commit, rien d'autre :\n\`\`\`diff\n${diff.substring(0, 6000)}\n\`\`\``
                );
            }, 300);
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