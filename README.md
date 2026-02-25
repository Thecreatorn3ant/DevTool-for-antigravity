# 🌌 Antigravity : Local AI Integration

**Antigravity** est une extension VS Code puissante conçue pour intégrer l'intelligence artificielle locale (via **Ollama**) ou distante directement dans votre flux de travail. Développez plus vite avec un contexte intelligent, des correctifs automatiques et une interface immersive.

---

## ✨ Fonctionnalités

- **🧠 Contexte Intelligent** : L'IA comprend le fichier actif et peut même analyser les fichiers liés (imports) pour des réponses ultra-pertinentes.
- **🛠️ Multi-File Patching** : Appliquez les suggestions de l'IA directement dans votre code avec une vue "Diff" pour valider les changements.
- **🚀 Support Hybride** : Utilisez vos modèles locaux avec **Ollama** ou connectez des APIs externes (OpenAI, etc.) via vos propres clés.
- **📝 Outils Git intégrés** : Générez des messages de commit pertinents ou demandez une revue de votre `git diff` en un clic.
- **🎨 Interface "Black Hole"** : Une expérience utilisateur fluide et cinématique avec un thème sombre premium.

---

## 🚀 Installation Rapide (via .vsix)

Pas besoin de compiler le code ! Suivez ces étapes simples :

1.  **Télécharger le fichier** : Allez dans la section **Releases** (ou dans le dossier `bin/` du dépôt) et téléchargez le fichier `local-ai-integration-0.0.1.vsix`.
2.  **Installer sur VS Code** :
    - Ouvrez VS Code.
    - Allez dans l'onglet **Extensions** (`Ctrl+Shift+X`).
    - Cliquez sur les trois petits points (**...**) en haut à droite du menu des extensions.
    - Choisissez **"Installer à partir de VSIX..."** (Install from VSIX...).
    - Sélectionnez le fichier téléchargé.
3.  **Lancer Ollama** : Assurez-vous qu'Ollama est bien lancé sur votre machine ([ollama.com](https://ollama.com/)).

---

## 🛠️ Configuration

Une fois installée, l'extension est prête à l'emploi. Voici comment la lier à vos modèles :

1.  **Ouvrez la vue Antigravity** dans la barre latérale gauche.
2.  **Sélection du modèle** : Utilisez le menu déroulant pour voir les modèles disponibles sur votre instance Ollama locale (ex: `llama3`, `mistral`, `codellama`).
3.  **Connexion Distante / Cloud** : Pour relier l'extension à un serveur Ollama distant ou un service cloud :
    - Cliquez sur l'icône 🔑 (**Configuration**) dans la barre latérale.
    - Choisissez l'option **"⚡ Ollama"**.
    - Saisissez l'URL complète de votre serveur (ex: `http://votre-ip-ou-domaine:11434`).
    - L'extension synchronisera immédiatement les modèles disponibles sur ce serveur distant.
4.  **Gestion des clés API** : Pour les APIs compatibles (OpenAI, etc.), utilisez le même bouton 🔑 pour configurer l'URL du point d'entrée et votre clé secrète.

---

## 📖 Comment l'utiliser ?

- **Chat contextuel** : Posez des questions sur votre code actuel. L'extension inclut automatiquement le fichier ouvert dans la conversation.
- **Bouton 🔗 Liés** : Cliquez dessus pour que l'IA lise aussi les fichiers que votre code importe (très utile pour comprendre les dépendances).
- **Bouton 🧠 Réflexion** : Active un mode où l'IA prend le temps de planifier sa solution avant de proposer du code.
- **Bouton 💾 Commit** : L'IA analyse vos changements non commités et vous propose un message clair et structuré.

---

## 🤝 Contribution

Ce projet est Open Source. Si vous souhaitez modifier le code ou ajouter des fonctionnalités :
1. Clonez le dépôt.
2. `npm install`
3. `npm run compile`
4. Appuyez sur `F5` pour tester vos modifications dans une nouvelle fenêtre.

---

## 🛠️ Workflow de développement

Pour garder le projet stable, nous utilisons deux branches principales :
- `main` : Contient les versions stables et les releases VSIX.
- `dev` : Branche de travail. Toutes les Pull Requests doivent cibler cette branche.

**Note aux contributeurs :** Merci de ne pas pousser directement sur `dev` ou `main`. Créez une branche par fonctionnalité (ex: `feature/ma-super-option`).

---
*Développé avec passion pour rendre l'IA locale accessible à tous les développeurs.*