const vscode = acquireVsCodeApi();
const chat = document.getElementById('chat');
const promptEl = document.getElementById('prompt');

var attachedImages = [];
var imagePreviewContainer = null;

function createImagePreview(base64, mimeType) {
    if (!imagePreviewContainer) {
        imagePreviewContainer = document.createElement('div');
        imagePreviewContainer.id = 'imagePreview';
        imagePreviewContainer.style.cssText = 'display:flex;gap:6px;padding:6px 12px;background:rgba(0,122,204,0.1);border-top:1px solid rgba(0,122,204,0.2);flex-wrap:wrap;align-items:center;';
        var label = document.createElement('span');
        label.style.cssText = 'color:#666;font-size:11px;';
        label.textContent = '📷 Images :';
        imagePreviewContainer.appendChild(label);
        document.querySelector('.input-area').insertBefore(imagePreviewContainer, document.querySelector('.input-row'));
    }
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative;width:60px;height:60px;border-radius:6px;overflow:hidden;border:1px solid rgba(0,210,255,0.3);';
    var img = document.createElement('img');
    img.src = 'data:' + mimeType + ';base64,' + base64;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
    var removeBtn = document.createElement('button');
    removeBtn.innerHTML = '×';
    removeBtn.style.cssText = 'position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;background:rgba(255,80,80,0.9);color:#fff;border:none;cursor:pointer;font-size:14px;line-height:1;padding:0;';
    removeBtn.onclick = function () {
        var idx = attachedImages.findIndex(function (x) { return x.base64 === base64; });
        if (idx !== -1) attachedImages.splice(idx, 1);
        wrapper.remove();
        if (imagePreviewContainer && imagePreviewContainer.querySelectorAll('img').length === 0) {
            imagePreviewContainer.remove(); imagePreviewContainer = null;
        }
    };
    wrapper.appendChild(img); wrapper.appendChild(removeBtn);
    imagePreviewContainer.appendChild(wrapper);
}

function addImage(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
        var base64 = e.target.result.split(',')[1];
        var mimeType = file.type;
        attachedImages.push({ base64: base64, mimeType: mimeType });
        createImagePreview(base64, mimeType);
        showNotification('📷 Image ajoutée (' + attachedImages.length + ')', 'info');
    };
    reader.readAsDataURL(file);
}

promptEl.addEventListener('paste', function (e) {
    var items = e.clipboardData.items;
    for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            e.preventDefault(); addImage(items[i].getAsFile()); break;
        }
    }
});

var inputArea = document.querySelector('.input-area');
inputArea.addEventListener('drop', function (e) {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer.files.length > 0) {
        for (var i = 0; i < e.dataTransfer.files.length; i++) {
            if (e.dataTransfer.files[i].type.indexOf('image') !== -1) addImage(e.dataTransfer.files[i]);
        }
    }
});
inputArea.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); inputArea.style.background = 'rgba(0,210,255,0.05)'; });
inputArea.addEventListener('dragleave', function (e) { e.preventDefault(); e.stopPropagation(); inputArea.style.background = ''; });

const send = document.getElementById('send');
const modelSelect = document.getElementById('modelSelect');
const filesBar = document.getElementById('filesBar');
const tokenBar = document.getElementById('tokenBar');
const terminalLog = document.getElementById('terminalLog');
const scrollBtn = document.getElementById('scrollBtn');
const termPermSelect = document.getElementById('termPermSelect');
let contextFiles = [];
let currentAiMsg = null;
let currentAiText = '';
let thinkModeActive = false;
let userScrolledUp = false;
let _msgCounter = 0;
let _allModels = [];
var notificationContainer = null;

var PROVIDER_COLORS = { local: '#b19cd9', lmstudio: '#74aa9c', gemini: '#7ab4f5', openai: '#74aa9c', openrouter: '#ffb74d', together: '#4dd0e1', mistral: '#ff8a80', groq: '#ffd700', anthropic: '#cc88ff', 'ollama-cloud': '#00d2ff' };
function providerColor(p) { return PROVIDER_COLORS[p] || '#00d2ff'; }
function providerBanner(p, name) {
    var icons = { local: '⚡', lmstudio: '💻', gemini: '✦', openai: '◈', openrouter: '◎', together: '◉', mistral: '◆', groq: '▸', anthropic: '◈', 'ollama-cloud': '☁️' };
    var labels = { local: 'Mode Local', lmstudio: 'LM Studio', gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter', together: 'Together AI', mistral: 'Mistral', groq: 'Groq', anthropic: 'Anthropic', 'ollama-cloud': 'Ollama Cloud' };
    return (icons[p] || '☁️') + ' <b>' + (labels[p] || 'Cloud') + '</b> &mdash; ' + name;
}

var modelComboBox = document.getElementById('modelComboBox');
var modelSearch = document.getElementById('modelSearch');
var modelDropdown = document.getElementById('modelDropdown');
var _comboOpen = false;
var _activeIdx = -1;
var _currentFilter = '';

function renderDropdown(filter) {
    _currentFilter = filter || '';
    var f = _currentFilter.toLowerCase().trim();
    var filtered = f ? _allModels.filter(function (x) {
        var n = (x.name || '').toLowerCase();
        var p = (x.provider || '').toLowerCase();
        return n.indexOf(f) !== -1 || p.indexOf(f) !== -1;
    }) : _allModels;
    var listHtml = filtered.length === 0 ? '<div class="model-opt-empty">Aucun résultat</div>'
        : filtered.map(function (x, i) {
            var c = providerColor(x.provider);
            var sel = x.value === modelSelect.value ? ' selected' : '';
            var icons = { local: '⚡', lmstudio: '💻', gemini: '✦', openai: '◈', openrouter: '◎', together: '◉', mistral: '◆', groq: '▸', anthropic: '◈', 'ollama-cloud': '☁️' };
            var icon = icons[x.provider] || '☁️';
            return '<div class="model-opt' + sel + '" data-value="' + x.value + '" data-idx="' + i + '">' +
                '<span class="opt-icon" style="color:' + c + '">' + icon + '</span>' +
                '<span class="opt-name" style="color:' + c + '">' + escapeHtml(x.name) + '</span></div>';
        }).join('');
    modelDropdown.innerHTML = '<div id="modelDropdownSearch-wrap"><input id="modelDropdownSearch" placeholder="Rechercher…" autocomplete="off" spellcheck="false"></div><div id="modelDropdownList">' + listHtml + '</div>';
    var dSearch = document.getElementById('modelDropdownSearch');
    if (dSearch) {
        dSearch.value = _currentFilter;
        dSearch.focus();
        var len = dSearch.value.length;
        dSearch.setSelectionRange(len, len);
        dSearch.addEventListener('input', function () { renderDropdown(dSearch.value); });
        dSearch.addEventListener('keydown', function (e) {
            var list = modelDropdown.querySelectorAll('.model-opt');
            if (e.key === 'ArrowDown') { e.preventDefault(); _activeIdx = Math.min(_activeIdx + 1, list.length - 1); highlightActive(list); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); _activeIdx = Math.max(_activeIdx - 1, 0); highlightActive(list); }
            else if (e.key === 'Enter') { e.preventDefault(); if (_activeIdx >= 0 && list[_activeIdx]) selectModel(list[_activeIdx].getAttribute('data-value')); }
            else if (e.key === 'Escape') { closeCombo(); }
        });
    }
    modelDropdown.querySelectorAll('.model-opt').forEach(function (el) {
        el.addEventListener('mousedown', function (e) { e.preventDefault(); selectModel(el.getAttribute('data-value')); });
    });
}

function highlightActive(list) {
    list.forEach(function (el, i) { el.classList.toggle('active', i === _activeIdx); });
    if (_activeIdx >= 0 && list[_activeIdx]) list[_activeIdx].scrollIntoView({ block: 'nearest' });
}

function selectModel(val) {
    var found = _allModels.find(function (x) { return x.value === val; });
    if (!found) return;
    modelSelect.value = val;
    modelSearch.value = found.name;
    modelSearch.style.color = providerColor(found.provider);
    closeCombo(); updateSelectColor();
    vscode.postMessage({ type: 'saveModel', model: val });
}

function openCombo() { _comboOpen = true; _activeIdx = -1; _currentFilter = ''; modelComboBox.classList.add('open'); modelDropdown.classList.add('open'); renderDropdown(''); }
function closeCombo() {
    _comboOpen = false; modelComboBox.classList.remove('open'); modelDropdown.classList.remove('open');
    var found = _allModels.find(function (x) { return x.value === modelSelect.value; });
    if (found) { modelSearch.value = found.name; modelSearch.style.color = providerColor(found.provider); }
}

modelComboBox.addEventListener('mousedown', function (e) {
    if (e.target === modelSearch && _comboOpen) return;
    e.preventDefault();
    _comboOpen ? closeCombo() : openCombo();
});
document.addEventListener('mousedown', function (e) {
    if (_comboOpen && !modelComboBox.contains(e.target) && !modelDropdown.contains(e.target)) closeCombo();
});

function renderModelOptions(models, selectedVal) {
    _allModels = models;
    modelSelect.innerHTML = models.map(function (x) {
        var s = x.value === selectedVal ? ' selected' : '';
        return '<option value="' + x.value + '" data-name="' + x.name + '" data-provider="' + (x.provider || '') + '"' + s + '>' + x.name + '</option>';
    }).join('');
    var found = models.find(function (x) { return x.value === selectedVal; }) || models[0];
    if (found) { modelSearch.value = found.name; modelSearch.style.color = providerColor(found.provider); }
    updateSelectColor();
}

chat.addEventListener('scroll', function () {
    var threshold = 60;
    var atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < threshold;
    userScrolledUp = !atBottom;
    scrollBtn.style.display = userScrolledUp ? 'flex' : 'none';
});
scrollBtn.onclick = function () { chat.scrollTop = chat.scrollHeight; userScrolledUp = false; scrollBtn.style.display = 'none'; };
function smartScroll() { if (!userScrolledUp) chat.scrollTop = chat.scrollHeight; }

termPermSelect.onchange = function () { vscode.postMessage({ type: 'setTerminalPermission', value: termPermSelect.value }); };

promptEl.addEventListener('input', function () { promptEl.style.height = 'auto'; promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px'; });

function addContextFile(name, content) {
    if (contextFiles.find(function (f) { return f.name === name; })) return;
    contextFiles.push({ name: name, content: content });
    renderFilesBar();
    vscode.postMessage({ type: 'getTokenBudget' });
}

function renderFilesBar() {
    if (contextFiles.length === 0) { filesBar.style.display = 'none'; return; }
    filesBar.style.display = 'flex';
    filesBar.innerHTML = '<span style="color:#666;margin-right:4px;">📁</span>' +
        contextFiles.map(function (f, i) {
            var tokens = Math.ceil(f.content.length / 4);
            return '<span class="file-tag" data-idx="' + i + '" title="' + tokens + ' tokens">' + f.name + ' <span style="color:#888;font-size:10px">(' + tokens + 't)</span> ×</span>';
        }).join('') +
        '<button class="file-tag btn-clear-files" onclick="clearAllFiles()" style="color:#ff6b6b;border-color:#ff6b6b;">Vider</button>';
    filesBar.querySelectorAll('.file-tag[data-idx]').forEach(function (el) {
        el.onclick = function () {
            var idx = parseInt(el.getAttribute('data-idx'));
            vscode.postMessage({ type: 'removeContextFile', name: contextFiles[idx].name });
            contextFiles.splice(idx, 1); renderFilesBar();
        };
    });
}

function clearAllFiles() {
    contextFiles.forEach(function (f) { vscode.postMessage({ type: 'removeContextFile', name: f.name }); });
    contextFiles = []; renderFilesBar();
}

function updateTokenBar(used, max, isCloud) {
    var pct = Math.min(100, Math.round(used / max * 100));
    var color = pct > 85 ? '#ff6b6b' : pct > 60 ? '#ffaa00' : '#00d2ff';
    var icon = isCloud ? '☁️' : '⚡';
    tokenBar.innerHTML = '<span style="color:#666;font-size:10px">' + icon + ' Tokens : ' +
        '<span style="color:' + color + '">' + used + '</span>/' + max +
        ' <div style="display:inline-block;width:60px;height:4px;background:#222;border-radius:2px;vertical-align:middle;margin-left:4px;">' +
        '<div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:2px;"></div></div>' +
        (pct > 85 ? ' ⚠️ Contexte saturé' : '') + '</span>';
    tokenBar.style.display = 'block';
}

function revertToMessage(index) {
    if (confirm('Revenir à ce message ?\nL\'historique après ce point sera supprimé.')) {
        vscode.postMessage({ type: 'revertTo', index: index });
    }
}

function addMsg(txt, cls, isHtml, messageIndex) {
    var d = document.createElement('div');
    d.className = 'msg ' + cls;
    var contentWrap = document.createElement('div');
    contentWrap.style.cssText = 'display: flex; flex-direction: column; gap: 6px; width: 100%;';
    var content = document.createElement('div');
    if (isHtml) { content.innerHTML = txt; } else { content.innerText = txt; }
    contentWrap.appendChild(content);
    if (cls === 'user' && messageIndex !== undefined) {
        var revertBtn = document.createElement('button');
        revertBtn.className = 'msg-revert-btn';
        revertBtn.innerHTML = '↩️ Revenir à ce message';
        revertBtn.onclick = function () { revertToMessage(messageIndex); };
        contentWrap.appendChild(revertBtn);
    }
    d.appendChild(contentWrap);
    chat.appendChild(d);
    smartScroll();
    return d;
}

function addStatusMsg(txt) { showNotification(txt, 'info'); }

function showNotification(message, type) {
    type = type || 'info';
    if (!notificationContainer) {
        notificationContainer = document.createElement('div');
        notificationContainer.id = 'notificationContainer';
        notificationContainer.style.cssText = 'position:fixed;bottom:80px;right:20px;display:flex;flex-direction:column;gap:8px;z-index:10000;max-width:320px;';
        document.body.appendChild(notificationContainer);
    }
    var colors = {
        info: { bg: 'rgba(0,210,255,0.15)', border: 'rgba(0,210,255,0.4)', color: '#00d2ff', icon: 'ℹ️' },
        success: { bg: 'rgba(0,200,100,0.15)', border: 'rgba(0,200,100,0.4)', color: '#6debb0', icon: '✅' },
        warning: { bg: 'rgba(255,170,0,0.15)', border: 'rgba(255,170,0,0.4)', color: '#ffb74d', icon: '⚠️' },
        error: { bg: 'rgba(255,80,80,0.15)', border: 'rgba(255,80,80,0.4)', color: '#ff8888', icon: '❌' }
    };
    var style = colors[type] || colors.info;
    var notif = document.createElement('div');
    notif.style.cssText = 'background:' + style.bg + ';border:1px solid ' + style.border + ';color:' + style.color + ';padding:10px 14px;border-radius:8px;font-size:12px;display:flex;align-items:center;gap:8px;box-shadow:0 4px 12px rgba(0,0,0,0.4);animation:slideIn 0.3s ease;';
    notif.innerHTML = '<span style="font-size:16px;flex-shrink:0;">' + style.icon + '</span><span style="flex:1;">' + escapeHtml(message) + '</span>';
    notificationContainer.appendChild(notif);
    setTimeout(function () {
        notif.style.animation = 'slideOut 0.3s ease';
        setTimeout(function () {
            notif.remove();
            if (notificationContainer && notificationContainer.children.length === 0) { notificationContainer.remove(); notificationContainer = null; }
        }, 300);
    }, 2500);
}

function escapeHtml(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

window._codeRegistry = [];
function _registerCode(content) { window._codeRegistry.push(content); return window._codeRegistry.length - 1; }

function renderMarkdown(text) {
    text = text.replace(/\[PLAN\]([\s\S]*?)\[\/PLAN\]/g, function (_, plan) {
        var idx = _registerCode(plan);
        return '<div class="msg plan-msg"><b>🧠 Plan de l\'IA :</b><br>' + escapeHtml(plan).replace(/\n/g, '<br>') + '<div style="margin-top:10px;"><button class="btn-cloud" style="background:#cc88ff;color:#000;border:none;" onclick="startPlanImplementation(' + idx + ')">🚀 Démarrer l\'implémentation</button></div></div>';
    });
    text = text.replace(/\[PROJECT_SUMMARY\][\s\S]*?\[\/PROJECT_SUMMARY\]/g, '');
    text = text.replace(/\[NEED_FILE:[^\]]+\]/g, '');
    text = text.replace(/\[WILL_MODIFY:[^\]]+\]/g, '');
    text = text.replace(/\[FILE:\s*([^ \]\n]+)(?: [^\]\n]+)?\]\s*```(\w+)?\n([\s\S]*?)```/g, function (_, fname, lang, code) {
        var idx = _registerCode(code); var fidx = _registerCode(fname);
        return '<div class="code-block patch"><div class="code-header"><span>📄 ' + escapeHtml(fname) + '</span><button onclick="applyFilePatch(' + idx + ',' + fidx + ')">✅ Appliquer</button></div><div class="code-content">' + escapeHtml(code) + '</div></div>';
    });
    text = text.replace(/```(\w+)?\n([\s\S]*?)```/g, function (_, lang, code) {
        var idx = _registerCode(code);
        var isPatch = /SEARCH/i.test(code);
        var cls = isPatch ? 'patch' : '';
        var btns = '<button onclick="applyCode(' + idx + ')">✅ Appliquer</button>';
        if (isPatch) btns += ' <button onclick="copyCode(' + idx + ')">📋 Copier</button>';
        else btns = '<button onclick="copyCode(' + idx + ')">📋 Copier</button> ' + btns;
        return '<div class="code-block ' + cls + '"><div class="code-header"><span>' + (lang || 'code') + '</span>' + btns + '</div><div class="code-content">' + escapeHtml(code) + '</div></div>';
    });
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    text = text.replace(/\*([^*]+)\*/g, '<i>$1</i>');
    var paras = text.split('\n\n');
    return paras.map(function (p) {
        p = p.trim(); if (!p) return '';
        if (p.startsWith('<div')) return p;
        p = p.replace(/\n/g, '<br>');
        return '<p>' + p + '</p>';
    }).join('');
}

function applyCode(idx) { vscode.postMessage({ type: 'applyToActiveFile', value: window._codeRegistry[idx] }); }
function applyFilePatch(codeIdx, fileIdx) { vscode.postMessage({ type: 'applyToActiveFile', value: window._codeRegistry[codeIdx], targetFile: window._codeRegistry[fileIdx] }); }
function copyCode(idx) { navigator.clipboard.writeText(window._codeRegistry[idx]); }
function startPlanImplementation(idx) { vscode.postMessage({ type: 'injectMessage', value: 'Démarre l\'implémentation du plan :\n' + window._codeRegistry[idx] }); }

var isGenerating = false;
function showStopButton() { isGenerating = true; send.style.display = 'none'; document.getElementById('stop').style.display = 'block'; }
function hideStopButton() { isGenerating = false; send.style.display = 'block'; document.getElementById('stop').style.display = 'none'; }

function sendMessage() {
    var val = promptEl.value.trim();
    if (!val || isGenerating) return;
    var msgIdx = _msgCounter; _msgCounter += 2;
    addMsg(val, 'user', false, msgIdx);
    showStopButton();
    var selectedOpt = modelSelect.options[modelSelect.selectedIndex];
    var modelVal = modelSelect.value;
    var modelUrl = selectedOpt ? (selectedOpt.getAttribute('data-url') || '') : '';
    vscode.postMessage({ type: 'sendMessage', value: val, model: modelVal, url: modelUrl, contextFiles: contextFiles, thinkMode: thinkModeActive, images: attachedImages });
    promptEl.value = ''; promptEl.style.height = 'auto';
    attachedImages = [];
    if (imagePreviewContainer) { imagePreviewContainer.remove(); imagePreviewContainer = null; }
}

send.onclick = sendMessage;
document.getElementById('stop').onclick = function () { vscode.postMessage({ type: 'stopGeneration' }); hideStopButton(); };
promptEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

document.getElementById('btnAddFile').onclick = function () { vscode.postMessage({ type: 'requestFileAccess', target: 'picker' }); };
document.getElementById('btnRelatedFiles').onclick = function () { vscode.postMessage({ type: 'addRelatedFiles' }); };
document.getElementById('btnThink').onclick = function () { vscode.postMessage({ type: 'toggleThinkMode' }); };
document.getElementById('btnCloud').onclick = function () { vscode.postMessage({ type: 'openCloudConnect' }); };
document.getElementById('btnClearHistory').onclick = function () { if (confirm('Effacer l\'historique ?')) { vscode.postMessage({ type: 'clearHistory' }); chat.innerHTML = ''; } };
document.getElementById('btnReset').onclick = function () { vscode.postMessage({ type: 'resetChat' }); };
document.getElementById('btnLsp').onclick = function () { vscode.postMessage({ type: 'getLspDiagnostics', scope: 'workspace' }); };
var _lspWatchActive = false;
document.getElementById('btnLspWatch').onclick = function () { vscode.postMessage({ type: 'toggleLspWatch' }); };
document.getElementById('btnAgent').onclick = function () {
    if (_agentRunning) { vscode.postMessage({ type: 'stopAgent' }); return; }
    var goal = promptEl.value.trim();
    if (!goal) { goal = window.prompt('Objectif de l\'agent :'); }
    if (!goal) return;
    promptEl.value = '';
    vscode.postMessage({ type: 'runAgent', goal: goal });
};
function stopAgent() { vscode.postMessage({ type: 'stopAgent' }); }
function sendLspToAi() {
    if (!_currentLspFormatted) return;
    promptEl.value = 'Analyse ces erreurs LSP et propose les correctifs :\n' + _currentLspFormatted;
    document.getElementById('lspPanel').style.display = 'none';
    promptEl.focus();
}
document.getElementById('btnGitReview').onclick = function () { vscode.postMessage({ type: 'reviewDiff' }); };
document.getElementById('btnCommit').onclick = function () { vscode.postMessage({ type: 'generateCommitMessage' }); };
document.getElementById('btnTests').onclick = function () { vscode.postMessage({ type: 'generateTests' }); };
document.getElementById('btnError').onclick = function () {
    var err = promptEl.value.trim();
    if (!err) { var inp = window.prompt('Coller votre erreur / stack trace :'); if (!inp) return; err = inp; }
    vscode.postMessage({ type: 'analyzeError', value: err }); promptEl.value = '';
};

function updateSelectColor() {
    var val = modelSelect.value;
    var found = _allModels.find(function (x) { return x.value === val; });
    var provider = found ? (found.provider || 'ollama-cloud') : '';
    var warn = document.getElementById('localWarn');
    if (!val || !found) { warn.style.cssText = ''; warn.className = 'offline'; warn.innerHTML = '⚠️ Ollama hors ligne'; warn.style.display = 'block'; }
    else { warn.className = provider; warn.innerHTML = providerBanner(provider, found.name); warn.style.display = 'block'; }
    vscode.postMessage({ type: 'getTokenBudget' });
}
modelSelect.onchange = function () { updateSelectColor(); vscode.postMessage({ type: 'saveModel', model: modelSelect.value }); };

window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'setModels') {
        if (m.models && m.models.length > 0) { _allModels = m.models; renderModelOptions(m.models, m.selected); }
        else { _allModels = []; modelSelect.innerHTML = '<option value="" style="color:#ff6b6b">⚠️ Aucun modèle — lancez Ollama ou LM Studio</option>'; updateSelectColor(); }
    }
    if (m.type === 'startResponse') {
        showStopButton();
        currentAiMsg = document.createElement('div'); currentAiMsg.className = 'msg ai';
        currentAiMsg.innerHTML = '<div class="thinking"><span></span><span></span><span></span></div>';
        chat.appendChild(currentAiMsg); chat.scrollTop = chat.scrollHeight; currentAiText = '';
    }
    if (m.type === 'partialResponse') {
        if (!currentAiMsg) { currentAiMsg = addMsg('', 'ai', true); }
        currentAiText += m.value; currentAiMsg.innerHTML = renderMarkdown(currentAiText); smartScroll();
    }
    if (m.type === 'endResponse') {
        hideStopButton();
        var finalText = m.value || currentAiText;
        if (currentAiMsg) { currentAiMsg.innerHTML = renderMarkdown(finalText); }
        else { addMsg(renderMarkdown(finalText), 'ai', true); }
        currentAiMsg = null; currentAiText = '';
    }
    if (m.type === 'fileContent') { addContextFile(m.name, m.content); }
    if (m.type === 'injectMessage') {
        promptEl.value = m.value; promptEl.style.height = 'auto';
        promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px'; promptEl.focus();
    }
    if (m.type === 'restoreHistory' && m.history) {
        chat.innerHTML = ''; _msgCounter = 0;
        m.history.forEach(function (msg, index) {
            if (msg.role === 'user') { addMsg(msg.value, 'user', false, index); }
            else { addMsg(renderMarkdown(msg.value), 'ai', true); }
        });
        _msgCounter = m.history.length;
    }
    if (m.type === 'statusMessage') { addStatusMsg(m.value); }
    if (m.type === 'thinkModeChanged') {
        thinkModeActive = m.active;
        var btn = document.getElementById('btnThink');
        btn.style.background = m.active ? 'rgba(160,0,255,0.25)' : '';
        btn.style.borderColor = m.active ? '#a000ff' : '';
        btn.style.color = m.active ? '#cc88ff' : '';
    }
    if (m.type === 'tokenBudget') { updateTokenBar(m.used, m.max, m.isCloud); }
    if (m.type === 'notification') { showNotification(m.message, m.notificationType); }
    if (m.type === 'terminalCommand') {
        terminalLog.style.display = 'block';
        var line = document.createElement('div'); line.className = 'cmd-line';
        var badge = m.status === 'refused' ? 'refused' : (m.status === 'auto' ? 'auto' : 'accepted');
        var label = m.status === 'refused' ? 'refusé' : (m.status === 'auto' ? 'auto' : 'ok');
        line.innerHTML = '<span class="cmd-badge ' + badge + '">' + label + '</span><span class="cmd-text">$ ' + escapeHtml(m.cmd) + '</span>';
        terminalLog.appendChild(line); terminalLog.scrollTop = terminalLog.scrollHeight;
        if (terminalLog.children.length > 20) terminalLog.removeChild(terminalLog.firstChild);
    }
    if (m.type === 'setTerminalPermission') { termPermSelect.value = m.value || 'ask-all'; }
    if (m.type === 'lspDiagnostics') {
        var panel = document.getElementById('lspPanel');
        var content = document.getElementById('lspContent');
        var summary = document.getElementById('lspSummary');
        _currentLspFormatted = m.report.formatted;
        summary.innerHTML = (m.report.errorCount > 0 ? '🔴' : '🟡') + ' ' + escapeHtml(m.report.summary);
        content.textContent = m.report.formatted; panel.style.display = 'block';
    }
    if (m.type === 'lspAutoReport') { showNotification('🔴 ' + m.summary, 'error'); _currentLspFormatted = m.formatted; }
    if (m.type === 'lspWatchToggled') {
        _lspWatchActive = m.active;
        var btn = document.getElementById('btnLspWatch');
        btn.style.background = m.active ? 'rgba(255,80,80,0.2)' : '';
        btn.style.borderColor = m.active ? 'rgba(255,80,80,0.5)' : '';
        btn.style.color = m.active ? '#ff8888' : '';
    }
    if (m.type === 'agentStarted') {
        _agentRunning = true;
        var panel = document.getElementById('agentPanel');
        var steps = document.getElementById('agentSteps');
        var label = document.getElementById('agentGoalLabel');
        label.textContent = '🤖 ' + m.goal; steps.innerHTML = ''; panel.style.display = 'block';
        var btn = document.getElementById('btnAgent');
        btn.textContent = '⏹ Stop'; btn.style.background = 'rgba(255,80,80,0.2)';
        btn.style.borderColor = 'rgba(255,80,80,0.5)'; btn.style.color = '#ff8888';
    }
    if (m.type === 'agentStep') {
        var stepIcons = { think: '💭', read_file: '📖', write_file: '✏️', run_command: '💻', fix_diagnostics: '🔍', done: '✅', error: '❌' };
        var icon = stepIcons[m.stepType] || '▸';
        var existing = document.getElementById('agent-step-' + m.stepId);
        if (!existing) { existing = document.createElement('div'); existing.id = 'agent-step-' + m.stepId; existing.className = 'agent-step'; document.getElementById('agentSteps').appendChild(existing); }
        var dur = m.durationMs ? '<span class="agent-step-dur">(' + Math.round(m.durationMs / 100) / 10 + 's)</span>' : '';
        var out = m.output ? '<div class="agent-step-out">' + escapeHtml(m.output.substring(0, 120)) + '</div>' : '';
        existing.className = 'agent-step step-' + m.status;
        existing.innerHTML = '<div class="agent-step-icon">' + icon + '</div><div class="agent-step-body"><div class="agent-step-desc">' + escapeHtml(m.description) + dur + '</div>' + out + '</div>';
        document.getElementById('agentSteps').scrollTop = 9999;
    }
    if (m.type === 'agentDone' || m.type === 'agentStopped' || m.type === 'agentFailed') {
        _agentRunning = false;
        var btn = document.getElementById('btnAgent');
        btn.textContent = '🤖 Agent'; btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';
        showNotification((m.type === 'agentDone' ? '✅' : '❌') + ' Agent terminé — ' + (m.summary || m.reason || 'arrêté'), m.type === 'agentDone' ? 'success' : 'error');
    }
    if (m.type === 'agentLog') { showNotification(m.message, 'info'); }
    if (m.type === 'showPlan') {
        var planEl = document.createElement('div'); planEl.className = 'msg plan-msg';
        planEl.innerHTML = '<b>🧠 Plan de l\'IA :</b><br>' + escapeHtml(m.plan).replace(/\n/g, '<br>');
        chat.appendChild(planEl); chat.scrollTop = chat.scrollHeight;
    }
    if (m.type === 'updateContextFiles') {
        m.files.forEach(function (f) {
            if (!contextFiles.find(function (cf) { return cf.name === f.name; })) {
                contextFiles.push({ name: f.name, content: '...', tokens: f.tokens });
            }
        });
        renderFilesBar();
    }
    if (m.type === 'reset') {
        chat.innerHTML = ''; _msgCounter = 0;
        contextFiles = []; renderFilesBar();
        showNotification(m.templateName ? '🔄 Chat réinitialisé avec "' + m.templateName + '"' : '🔄 Nouveau chat créé', 'success');
    }
    if (m.type === 'fileHistoryChanged') { /* ignore for now */ }
});

vscode.postMessage({ type: 'getModels' });
vscode.postMessage({ type: 'restoreHistory' });
vscode.postMessage({ type: 'getTokenBudget' });
vscode.postMessage({ type: 'getTerminalPermission' });

var _currentLspFormatted = '';
var _agentRunning = false;
// window.SHOW_ONBOARDING is injected by chatViewProvider.ts via an inline <script> tag
var _showOnboarding = (typeof window.SHOW_ONBOARDING !== 'undefined') ? window.SHOW_ONBOARDING : false;

// ===== ONBOARDING =====
var _obCur = 1;
var _obTitles = {
    1: ['Mission Briefing', 'Configure your AI co-pilot in 60 seconds.'],
    2: ['Local AI Setup', 'Private, offline, completely free.'],
    3: ['Cloud Boost', 'Optional — supercharge with Gemini\'s free tier.'],
    4: ['The Cockpit', 'A quick tour before you launch.'],
    5: ['All Systems Go', 'Your AI-powered IDE is ready.']
};

function obGo(step) {
    var prev = document.getElementById('obStep' + _obCur);
    if (prev) prev.classList.remove('active');
    _obCur = step;
    var next = document.getElementById('obStep' + step);
    if (next) next.classList.add('active');
    var t = _obTitles[step] || ['', ''];
    var el = document.getElementById('obMainTitle');
    var sub = document.getElementById('obMainSub');
    var lbl = document.getElementById('obStepLabel');
    if (el) { el.style.opacity = '0'; setTimeout(function () { el.textContent = t[0]; el.style.opacity = '1'; el.style.transition = 'opacity 0.25s'; }, 120); }
    if (sub) { sub.style.opacity = '0'; setTimeout(function () { sub.textContent = t[1]; sub.style.opacity = '1'; sub.style.transition = 'opacity 0.25s'; }, 180); }
    if (lbl) lbl.textContent = 'step ' + step + ' / 5';
    for (var i = 1; i <= 5; i++) {
        var seg = document.getElementById('obSeg' + i);
        if (seg) seg.className = 'ob-seg' + (i < step ? ' done' : i === step ? ' active' : '');
    }
}

function obSkip() {
    var o = document.getElementById('obOverlay');
    if (!o) return;
    o.style.transition = 'opacity 0.4s';
    o.style.opacity = '0';
    setTimeout(function () { o.style.display = 'none'; o.style.opacity = '1'; o.style.transition = ''; }, 400);
}

function obOpen() {
    var o = document.getElementById('obOverlay');
    if (!o) return;
    _obCur = 1;
    // Reset all steps first
    for (var i = 1; i <= 5; i++) {
        var s = document.getElementById('obStep' + i);
        if (s) s.classList.remove('active');
    }
    obGo(1);
    o.style.transition = '';
    o.style.opacity = '0';
    o.style.display = 'flex';
    setTimeout(function () { o.style.transition = 'opacity 0.4s'; o.style.opacity = '1'; }, 20);
}

function obFinish() {
    var o = document.getElementById('obOverlay');
    if (o) { o.style.transition = 'opacity 0.4s'; o.style.opacity = '0'; setTimeout(function () { o.style.display = 'none'; }, 400); }
    vscode.postMessage({ type: 'finishOnboarding' });
    setTimeout(function () { vscode.postMessage({ type: 'getModels' }); }, 800);
}

function obTestOllama() {
    var st = document.getElementById('obOllamaStatus');
    var tx = document.getElementById('obOllamaStatusText');
    if (!st || !tx) return;
    st.className = 'ob-status testing'; tx.textContent = 'Testing localhost:11434…';
    fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(4000) })
        .then(function (r) { if (r.ok) return r.json(); throw new Error('HTTP ' + r.status); })
        .then(function (d) { var n = (d.models || []).length; st.className = 'ob-status ok'; tx.textContent = '✓ Ollama connected — ' + n + ' model' + (n !== 1 ? 's' : '') + ' available'; setTimeout(function () { obGo(3); }, 1200); })
        .catch(function () { st.className = 'ob-status fail'; tx.textContent = '✗ Not found — is Ollama running?'; });
}

function obTestLmStudio() {
    var st = document.getElementById('obLmStatus');
    var tx = document.getElementById('obLmStatusText');
    if (!st || !tx) return;
    st.className = 'ob-status testing'; tx.textContent = 'Testing localhost:1234…';
    fetch('http://localhost:1234/v1/models', { signal: AbortSignal.timeout(4000) })
        .then(function (r) { if (r.ok) return r.json(); throw new Error('HTTP ' + r.status); })
        .then(function (d) { var n = (d.data || []).length; st.className = 'ob-status ok'; tx.textContent = '✓ LM Studio connected — ' + n + ' model' + (n !== 1 ? 's' : '') + ' loaded'; setTimeout(function () { obGo(3); }, 1200); })
        .catch(function () { st.className = 'ob-status fail'; tx.textContent = '✗ Not found — start the Local Server in LM Studio'; });
}

function obSaveGemini() {
    var inp = document.getElementById('obGeminiKey');
    var key = inp ? inp.value.trim() : '';
    var st = document.getElementById('obGeminiStatus');
    var tx = document.getElementById('obGeminiStatusText');
    if (!key || key.length < 10) { if (st) st.className = 'ob-status fail'; if (tx) tx.textContent = '✗ Key looks too short — double-check it.'; return; }
    if (st) st.className = 'ob-status testing'; if (tx) tx.textContent = 'Validating key…';
    fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + key, { signal: AbortSignal.timeout(5000) })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function () { if (st) st.className = 'ob-status ok'; if (tx) tx.textContent = '✓ Key valid — Gemini connected!'; vscode.postMessage({ type: 'setupGeminiKey', key: key }); setTimeout(function () { obGo(4); }, 1000); })
        .catch(function () { if (st) st.className = 'ob-status ok'; if (tx) tx.textContent = '✓ Key saved (connection test skipped)'; vscode.postMessage({ type: 'setupGeminiKey', key: key }); setTimeout(function () { obGo(4); }, 1000); });
}

// Show overlay if first time
if (_showOnboarding) {
    var _overlay = document.getElementById('obOverlay');
    if (_overlay) _overlay.style.display = 'flex';
}

// Attach button listeners
var _btnOb = document.getElementById('btnOnboarding');
if (_btnOb) { _btnOb.onclick = function () { obOpen(); }; }

var _btnHome = document.getElementById('btnHome');
if (_btnHome) { _btnHome.onclick = function () { obOpen(); }; }

// Onboarding Canvas Animation
(function initCanvas() {
    var canvas = document.getElementById('obCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W, H, particles = [];

    function resize() {
        W = canvas.width = canvas.offsetWidth;
        H = canvas.height = canvas.offsetHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    for (var i = 0; i < 80; i++) {
        particles.push({
            x: Math.random() * 1600,
            y: Math.random() * 1200,
            r: Math.random() * 1.2 + 0.2,
            dx: (Math.random() - 0.5) * 0.12,
            dy: (Math.random() - 0.5) * 0.12,
            a: Math.random() * 0.5 + 0.1,
            da: (Math.random() - 0.5) * 0.004,
            hue: Math.random() < 0.6 ? 190 : 270,
        });
    }

    var shooters = [];
    function spawnShooter() {
        shooters.push({
            x: Math.random() * W,
            y: 0,
            len: Math.random() * 60 + 30,
            speed: Math.random() * 3 + 2,
            angle: Math.PI / 4 + (Math.random() - 0.5) * 0.3,
            a: 0.7,
        });
    }
    setInterval(spawnShooter, 2400);

    function draw() {
        ctx.clearRect(0, 0, W, H);
        particles.forEach(function (p) {
            p.x += p.dx; p.y += p.dy; p.a += p.da;
            if (p.a < 0.05 || p.a > 0.65) p.da *= -1;
            if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
            if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = 'hsla(' + p.hue + ',80%,80%,' + p.a + ')';
            ctx.fill();
        });
        shooters = shooters.filter(function (s) { return s.a > 0.01; });
        shooters.forEach(function (s) {
            s.x += Math.cos(s.angle) * s.speed;
            s.y += Math.sin(s.angle) * s.speed;
            s.a -= 0.012;
            var grd = ctx.createLinearGradient(s.x, s.y, s.x - Math.cos(s.angle) * s.len, s.y - Math.sin(s.angle) * s.len);
            grd.addColorStop(0, 'rgba(0,210,255,' + s.a + ')');
            grd.addColorStop(1, 'rgba(0,210,255,0)');
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(s.x - Math.cos(s.angle) * s.len, s.y - Math.sin(s.angle) * s.len);
            ctx.strokeStyle = grd;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });
        requestAnimationFrame(draw);
    }
    draw();
})();
