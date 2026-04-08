const vscode = acquireVsCodeApi();

const chat = document.getElementById('chat');
const promptEl = document.getElementById('prompt');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const modelSelect = document.getElementById('modelSelect');
const modelSearch = document.getElementById('modelSearch');
const modelComboBox = document.getElementById('modelComboBox');
const modelDropdown = document.getElementById('modelDropdown');
const filesBar = document.getElementById('filesBar');
const tokenBar = document.getElementById('tokenBar');
const terminalLog = document.getElementById('terminalLog');
const scrollBtn = document.getElementById('scrollBtn');
const termPermSelect = document.getElementById('termPermSelect');
const historyList = document.getElementById('historyList');

let attachedImages = [];
let contextFiles = [];
let currentAiMsg = null;
let currentAiText = '';
let isGenerating = false;
let userScrolledUp = false;
let _msgCounter = 0;
let _allModels = [];
let _comboOpen = false;
let _activeIdx = -1;
let _agentRunning = false;
let _currentLspFormatted = '';

const t = window.I18N || {};

function initTabs() {
    const navItems = document.querySelectorAll('.nav-item');
    const tabPanes = document.querySelectorAll('.tab-pane');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const tabId = item.getAttribute('data-tab');

            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            tabPanes.forEach(pane => pane.classList.remove('active'));
            document.getElementById(`tab-${tabId}`).classList.add('active');

            if (tabId === 'history') loadHistoryList();
            if (tabId === 'settings') loadSettings();
        });
    });
}

function loadHistoryList() {
    vscode.postMessage({ type: 'getHistoryList' });
}

function loadSettings() {
    vscode.postMessage({ type: 'getSettings' });
}

function sendMessage() {
    const val = promptEl.value.trim();
    if (!val || isGenerating) return;

    addMsg(val, 'user', false, _msgCounter);
    _msgCounter += 2;

    showStopButton();
    const selectedOpt = modelSelect.options[modelSelect.selectedIndex];
    const modelVal = modelSelect.value;
    const modelUrl = selectedOpt ? (selectedOpt.getAttribute('data-url') || '') : '';

    vscode.postMessage({
        type: 'sendMessage',
        value: val,
        model: modelVal,
        url: modelUrl,
        contextFiles: contextFiles,
        images: attachedImages
    });

    promptEl.value = '';
    promptEl.style.height = 'auto';
    attachedImages = [];
    updateImagePreviews();
}

function addMsg(txt, cls, isHtml, messageIndex) {
    const d = document.createElement('div');
    d.className = `msg ${cls}`;

    const contentWrap = document.createElement('div');
    contentWrap.className = 'msg-content-wrap';

    const content = document.createElement('div');
    if (isHtml) {
        content.innerHTML = renderMarkdown(txt);
    } else {
        content.innerText = txt;
    }

    contentWrap.appendChild(content);

    if (cls === 'user' && messageIndex !== undefined) {
        const revertBtn = document.createElement('button');
        revertBtn.className = 'msg-revert-btn';
        revertBtn.innerHTML = '↩️';
        revertBtn.onclick = () => revertToMessage(messageIndex);
        d.appendChild(revertBtn);
    }

    d.appendChild(contentWrap);
    chat.appendChild(d);
    smartScroll();
    return d;
}

function renderMarkdown(text) {
    let html = text
        .replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
            const idx = _registerCode(code);
            return `<div class="code-block"><div class="code-header"><span>${lang || 'code'}</span><button onclick="copyCode(${idx})">📋</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
        })
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\*([^*]+)\*/g, '<i>$1</i>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
    return html;
}

window._codeRegistry = [];
function _registerCode(content) { window._codeRegistry.push(content); return window._codeRegistry.length - 1; }
window.copyCode = function (idx) { navigator.clipboard.writeText(window._codeRegistry[idx]); showNotification(t.btn_copy || 'Copied', 'info'); };


function escapeHtml(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function smartScroll() {
    if (!userScrolledUp) {
        chat.scrollTop = chat.scrollHeight;
    }
}

function showStopButton() {
    isGenerating = true;
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'block';
}

function hideStopButton() {
    isGenerating = false;
    sendBtn.style.display = 'block';
    stopBtn.style.display = 'none';
}

function showNotification(message, type = 'info') {
    console.log(`[Notification] ${type}: ${message}`);
}

function renderModelOptions(models, selectedVal) {
    _allModels = models;

    modelSelect.innerHTML = models.map(x => {
        const s = x.value === selectedVal ? ' selected' : '';
        return `<option value="${x.value}" data-name="${x.name}" data-provider="${x.provider || ''}"${s}>${x.name}</option>`;
    }).join('');

    renderDropdown(models, selectedVal);

    const found = models.find(x => x.value === selectedVal) || models[0];
    if (found) {
        modelSearch.value = found.name;
        updateSelectColor();
    }
}

function renderDropdown(models, selectedVal) {
    const PROVIDER_ICONS = {
        local: '⚡', lmstudio: '💻', gemini: '✨', openai: '✦', openrouter: '◎',
        together: '∞', mistral: '†', groq: '›', anthropic: '✦',
        deepseek: '∞', cohere: '✦', perplexity: '◎', xai: '✦',
        fireworks: '⚡', 'ollama-cloud': '☁️'
    };

    modelDropdown.innerHTML = models.map(m => {
        const isSelected = m.value === selectedVal;
        const icon = PROVIDER_ICONS[m.provider] || '☁️';
        return `
            <div class="model-item ${isSelected ? 'selected' : ''}" data-value="${m.value}" data-name="${m.name}">
                <span class="model-item-provider">${icon}</span>
                <span class="model-item-name">${m.name}</span>
            </div>
        `;
    }).join('');

    modelDropdown.querySelectorAll('.model-item').forEach(item => {
        item.onclick = (e) => {
            e.stopPropagation();
            selectModel(item.getAttribute('data-value'), item.getAttribute('data-name'));
        };
    });
}

function toggleDropdown(show) {
    _comboOpen = show !== undefined ? show : !_comboOpen;
    if (_comboOpen) {
        modelDropdown.classList.add('show');
        modelSearch.focus();
    } else {
        modelDropdown.classList.remove('show');
    }
}

function selectModel(val, name) {
    modelSelect.value = val;
    modelSearch.value = name;
    toggleDropdown(false);
    updateSelectColor();
    vscode.postMessage({ type: 'saveModel', model: val });
}

function filterModels() {
    const q = modelSearch.value.toLowerCase();
    const filtered = _allModels.filter(m => m.name.toLowerCase().includes(q));
    renderDropdown(filtered, modelSelect.value);
    if (!modelDropdown.classList.contains('show')) toggleDropdown(true);
}

function updateSelectColor() {
    const val = modelSelect.value;
    const found = _allModels.find(x => x.value === val);
    const provider = found ? (found.provider || 'local') : 'offline';
    const warn = document.getElementById('localWarn');

    if (!found) {
        warn.innerHTML = '⚠️ Offline';
        warn.className = 'status-banner offline';
    } else {
        warn.innerHTML = `<span>${provider === 'local' ? '⚡' : '☁️'}</span> <b>${found.name}</b>`;
        warn.className = `status-banner ${provider}`;
    }
}


sendBtn.onclick = sendMessage;
stopBtn.onclick = () => { vscode.postMessage({ type: 'stopGeneration' }); hideStopButton(); };

promptEl.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
};

document.getElementById('btnNewChat').onclick = () => {
    if (confirm(t.clear_history_confirm || 'New chat?')) {
        vscode.postMessage({ type: 'resetChat' });
        chat.innerHTML = '';
    }
};

document.getElementById('btnAddFile').onclick = () => vscode.postMessage({ type: 'requestFileAccess', target: 'picker' });

document.getElementById('btnAgent').onclick = () => {
    const goal = promptEl.value.trim() || prompt('Agent goal:');
    if (goal) vscode.postMessage({ type: 'runAgent', goal });
};

modelComboBox.onclick = (e) => {
    e.stopPropagation();
    toggleDropdown();
};

modelSearch.oninput = filterModels;
modelSearch.onclick = (e) => e.stopPropagation();

document.addEventListener('click', () => toggleDropdown(false));

document.getElementById('btnSaveSettings').onclick = saveSettings;

document.getElementById('settingContextMult').oninput = (e) => {
    document.getElementById('multValue').textContent = `${parseFloat(e.target.value).toFixed(1)}x`;
};

function saveSettings() {
    const contextMult = parseFloat(document.getElementById('settingContextMult').value);
    const lang = document.getElementById('selectLang').value;

    vscode.postMessage({
        type: 'saveSettings',
        settings: {
            contextMult: contextMult
        }
    });

    if (lang !== window.LANG) {
        vscode.postMessage({ type: 'setLanguage', value: lang });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initTabs();

    vscode.postMessage({ type: 'getModels' });
    vscode.postMessage({ type: 'restoreHistory' });
    vscode.postMessage({ type: 'getTokenBudget' });
});

window.addEventListener('message', e => {
    const m = e.data;
    switch (m.type) {
        case 'setModels':
            renderModelOptions(m.models, m.selected);
            break;
        case 'startResponse':
            showStopButton();
            if (!m.isContinuing) {
                currentAiMsg = document.createElement('div');
                currentAiMsg.className = 'msg ai';
                currentAiMsg.innerHTML = '<div class="thinking">...</div>';
                chat.appendChild(currentAiMsg);
            }
            currentAiText = '';
            break;
        case 'partialResponse':
            currentAiText += m.value;
            currentAiMsg.innerHTML = renderMarkdown(currentAiText);
            smartScroll();
            break;
        case 'endResponse':
            hideStopButton();
            currentAiMsg.innerHTML = renderMarkdown(m.value || currentAiText);
            currentAiMsg = null;
            break;
        case 'restoreHistory':
            if (m.history) {
                chat.innerHTML = '';
                m.history.forEach((msg, i) => addMsg(msg.value, msg.role, msg.role === 'ai', i));
            }
            break;
        case 'historyList':
            renderHistoryList(m.sessions);
            break;
        case 'settingsData':
            updateSettingsUI(m.settings);
            break;
        case 'languageChanged':
            window.I18N = m.translations;
            location.reload();
            break;
    }
});

function renderHistoryList(sessions) {
    if (!sessions || sessions.length === 0) {
        historyList.innerHTML = `<p class="empty-msg">${t.no_history || 'Aucune session'}</p>`;
        return;
    }
    historyList.innerHTML = sessions.map(s => `
        <div class="history-item">
            <div class="history-info" onclick="loadSession('${s.id}')">
                <div class="history-meta">
                    <span class="history-date">${new Date(s.timestamp).toLocaleDateString()}</span>
                    <span class="history-model">${s.model || ''}</span>
                </div>
                <div class="history-preview">${escapeHtml(s.preview || '...')}</div>
            </div>
            <button class="history-delete-btn" onclick="deleteSession('${s.id}')" title="${t.delete_session || 'Supprimer'}">🗑️</button>
        </div>
    `).join('');
}

window.loadSession = (id) => {
    vscode.postMessage({ type: 'loadSession', id });
    document.querySelector('[data-tab="chat"]').click();
};

window.deleteSession = (id) => {
    if (confirm(t.confirm_delete || 'Supprimer cette session ?')) {
        vscode.postMessage({ type: 'deleteSession', id });
    }
};

function updateSettingsUI(settings) {
    document.getElementById('settingContextMult').value = settings.contextMult || 1;
    document.getElementById('multValue').textContent = `${(settings.contextMult || 1).toFixed(1)}x`;
}

/* Onboarding Navigation */
let currentObStep = 1;
window.setObStep = function(n) {
    const steps = document.querySelectorAll('.ob-step');
    steps.forEach(s => s.classList.remove('active'));
    
    currentObStep = n;
    const nextStep = document.getElementById(`ob-step-${n}`);
    if (nextStep) {
        nextStep.classList.add('active');
        // Scroll to top of card on step change
        document.getElementById('obCard').scrollTop = 0;
    }
};

window.obFinish = function() {
    vscode.postMessage({ type: 'finishOnboarding', language: window.LANG || 'en' });
};

window.saveGeminiKey = function() {
    const key = document.getElementById('obGeminiKey').value;
    if (key) {
        vscode.postMessage({ type: 'setupGeminiKey', key: key });
        // Auto move to next step after a tiny delay
        setTimeout(() => window.setObStep(4), 1000);
    } else {
        window.setObStep(4); // Skip
    }
};
