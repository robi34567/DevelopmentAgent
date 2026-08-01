(function() {
    var debugEl = document.getElementById('debug-status');
    try {
        var vscode = acquireVsCodeApi();
        if (debugEl) debugEl.textContent = 'Script loaded - VS Code API acquired';
        if (debugEl) debugEl.style.color = 'var(--vscode-testing-iconPassed)';
    } catch(e) {
        if (debugEl) debugEl.textContent = 'ERROR acquiring VS Code API: ' + e.message;
        if (debugEl) debugEl.style.color = 'var(--vscode-errorForeground)';
        return;
    }

    var chatContainer = document.getElementById('chat-container');
    var messageInput = document.getElementById('message-input');
    var sendBtn = document.getElementById('send-btn');
    var stopBtn = document.getElementById('stop-btn');
    var clearBtn = document.getElementById('clear-btn');
    var compressBtn = document.getElementById('compress-btn');
    var benchmarkBtn = document.getElementById('benchmark-btn');
    var batchBenchmarkBtn = document.getElementById('batch-benchmark-btn');
    var batchTriesInput = document.getElementById('batch-tries');
    var providerSelect = document.getElementById('provider-select');
    var modelSelect = document.getElementById('model-select');
    var approvalSelect = document.getElementById('approval-select');
    var newSessionBtn = document.getElementById('new-session-btn');
    var sessionSelect = document.getElementById('session-select');
    var deleteSessionBtn = document.getElementById('delete-session-btn');
    var saveSessionBtn = document.getElementById('save-session-btn');
    var isProcessing = false;
    var currentAssistantMessage = null;
    var currentThinkingEl = null;
    var showThinking = true;
    var debugElOriginal = debugEl ? debugEl.outerHTML : '';
    var cmdHistory = [];
    var cmdHistoryPos = -1;
    var pendingImages = [];

    function dataUrlToBlob(dataUrl) {
        var parts = dataUrl.split(',');
        var mime = parts[0].match(/:(.*?);/)[1];
        var bytes = atob(parts[1]);
        var arr = new Uint8Array(bytes.length);
        for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
        return new Blob([arr], { type: mime });
    }

    function createImagePreview(src, mimeType) {
        vscode.postMessage({ type: 'log', text: 'createImagePreview called, src length=' + src.length + ' mimeType=' + mimeType });
        var container = document.getElementById('image-preview-container');
        vscode.postMessage({ type: 'log', text: 'container found: ' + (!!container) });
        if (!container) {
            vscode.postMessage({ type: 'log', text: 'ERROR: image-preview-container not found in DOM' });
            return;
        }
        var wrapper = document.createElement('div');
        wrapper.className = 'image-preview-wrapper';
        var img = document.createElement('img');
        img.src = src;
        img.className = 'image-preview-thumb';
        img.onerror = function() {
            vscode.postMessage({ type: 'log', text: 'img.onerror fired, could not load preview' });
            wrapper.innerHTML = '<span style="font-size:10px;color:var(--vscode-errorForeground);padding:4px;">Error</span>';
        };
        var removeBtn = document.createElement('button');
        removeBtn.className = 'image-preview-remove';
        removeBtn.innerHTML = '&times;';
        removeBtn.title = 'Remove image';
        (function(imgSrc, imgMime) {
            removeBtn.addEventListener('click', function() {
                wrapper.remove();
                pendingImages = pendingImages.filter(function(p) { return p.base64 !== imgSrc.split(',')[1]; });
                if (pendingImages.length === 0) {
                    container.style.display = 'none';
                }
            });
        })(src, mimeType);
        wrapper.appendChild(img);
        wrapper.appendChild(removeBtn);
        container.appendChild(wrapper);
        container.style.display = 'flex';
        vscode.postMessage({ type: 'log', text: 'preview appended to container' });
    }

    function addPendingImage(dataUrl, mimeType) {
        vscode.postMessage({ type: 'log', text: 'addPendingImage called, dataUrl length=' + dataUrl.length + ' mimeType=' + mimeType });
        var base64 = dataUrl.split(',')[1];
        vscode.postMessage({ type: 'log', text: 'base64 length=' + base64.length });
        pendingImages.push({ base64: base64, mimeType: mimeType });
        vscode.postMessage({ type: 'log', text: 'pendingImages count: ' + pendingImages.length });
        createImagePreview(dataUrl, mimeType);
    }

    function readClipboardImageBlob(blob) {
        vscode.postMessage({ type: 'log', text: 'readClipboardImageBlob called size=' + blob.size + ' type=' + blob.type });
        var allowedMime = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
        if (allowedMime.indexOf(blob.type) === -1) {
            vscode.postMessage({ type: 'log', text: 'unsupported mime: ' + blob.type });
            addMessage('system', '⚠️ Unsupported image format: ' + blob.type + '. Please use PNG or JPEG.');
            return;
        }
        if (blob.size > 10 * 1024 * 1024) {
            vscode.postMessage({ type: 'log', text: 'image too large: ' + blob.size });
            addMessage('system', '⚠️ Image too large (max 10MB).');
            return;
        }
        vscode.postMessage({ type: 'log', text: 'validation passed, starting FileReader' });
        var reader = new FileReader();
        reader.onload = function(ev) {
            vscode.postMessage({ type: 'log', text: 'FileReader onload fired, result length: ' + (ev.target.result ? ev.target.result.length : 0) });
            addPendingImage(ev.target.result, blob.type);
        };
        reader.onerror = function(ev) {
            vscode.postMessage({ type: 'log', text: 'FileReader onerror: ' + (ev.target ? ev.target.error ? ev.target.error.message : 'unknown' : 'no target') });
            addMessage('system', '⚠️ Failed to read image from clipboard.');
        };
        reader.readAsDataURL(blob);
        vscode.postMessage({ type: 'log', text: 'readAsDataURL called' });
    }

    function readClipboardViaNavigator() {
        try {
            navigator.clipboard.read().then(function(items) {
                console.log('[Local Copilot navigator.clipboard.read] Got', items.length, 'items');
                for (var ci = 0; ci < items.length; ci++) {
                    console.log('[Local Copilot navigator.clipboard.read] Item', ci, 'types:', items[ci].types.join(', '));
                    var types = items[ci].types;
                    for (var ti = 0; ti < types.length; ti++) {
                        if (types[ti].startsWith('image/')) {
                            console.log('[Local Copilot navigator.clipboard.read] Found image type:', types[ti]);
                            items[ci].getType(types[ti]).then(function(blob) {
                                console.log('[Local Copilot navigator.clipboard.read] Got blob, size:', blob.size, 'type:', blob.type);
                                readClipboardImageBlob(blob);
                                if (messageInput.value.trim()) {
                                    messageInput.value = '';
                                    messageInput.style.height = 'auto';
                                }
                            }).catch(function(err) {
                                console.log('[Local Copilot navigator.clipboard.read] getType error:', err);
                            });
                            return;
                        }
                    }
                }
                console.log('[Local Copilot navigator.clipboard.read] No image found in any item');
            }).catch(function(err) {
                console.log('[Local Copilot navigator.clipboard.read] read() failed:', err.message || err);
            });
        } catch(e) {
            console.log('[Local Copilot navigator.clipboard.read] Exception:', e.message || e);
        }
    }

    messageInput.addEventListener('paste', function(e) {
        vscode.postMessage({ type: 'log', text: 'paste event fired' });
        var items = e.clipboardData.items;
        vscode.postMessage({ type: 'log', text: 'items count: ' + (items ? items.length : 0) });
        for (var i = 0; i < items.length; i++) {
            vscode.postMessage({ type: 'log', text: 'item ' + i + ' type=' + items[i].type + ' kind=' + items[i].kind });
        }
        if (e.clipboardData.types) {
            vscode.postMessage({ type: 'log', text: 'types: ' + Array.from(e.clipboardData.types).join(', ') });
        }
        if (e.clipboardData.files && e.clipboardData.files.length > 0) {
            vscode.postMessage({ type: 'log', text: 'files count: ' + e.clipboardData.files.length });
        }
        var imgItem = null;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                imgItem = items[i];
                break;
            }
        }
        if (imgItem) {
            vscode.postMessage({ type: 'log', text: 'found image item: ' + imgItem.type });
            e.preventDefault();
            var file = imgItem.getAsFile();
            if (file) {
                vscode.postMessage({ type: 'log', text: 'got file size=' + file.size + ' type=' + file.type });
                readClipboardImageBlob(file);
            } else {
                vscode.postMessage({ type: 'log', text: 'getAsFile returned null' });
            }
            return;
        }
        vscode.postMessage({ type: 'log', text: 'no image in items, trying fallbacks' });
        readClipboardViaNavigator();
        vscode.postMessage({ type: 'log', text: 'sending readClipboardImage' });
        vscode.postMessage({ type: 'readClipboardImage' });
    });

    function saveChatState() {
        var html = chatContainer.innerHTML;
        vscode.postMessage({ type: 'saveChatState', html: html });
    }

    messageInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (cmdHistory.length === 0) return;
            if (cmdHistoryPos <= 0) cmdHistoryPos = cmdHistory.length;
            cmdHistoryPos--;
            messageInput.value = cmdHistory[cmdHistoryPos];
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (cmdHistoryPos === -1) return;
            if (cmdHistoryPos < cmdHistory.length - 1) {
                cmdHistoryPos++;
                messageInput.value = cmdHistory[cmdHistoryPos];
            } else {
                cmdHistoryPos = -1;
                messageInput.value = '';
            }
            messageInput.style.height = 'auto';
            messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
        }
    });

    sendBtn.addEventListener('click', sendMessage);
    stopBtn.addEventListener('click', stopGeneration);
    clearBtn.addEventListener('click', clearChat);
    compressBtn.addEventListener('click', compressHistory);
    benchmarkBtn.addEventListener('click', runBenchmark);
    batchBenchmarkBtn.addEventListener('click', runBatchBenchmark);
    document.getElementById('thinking-toggle').addEventListener('click', function() {
        vscode.postMessage({ type: 'toggleThinking' });
    });

    providerSelect.addEventListener('change', function() {
        vscode.postMessage({ type: 'changeProvider', provider: this.value });
        modelSelect.innerHTML = '<option value="">Loading models...</option>';
        if (providerCanFetchModels(this.value)) {
            modelSelect.style.display = '';
            vscode.postMessage({ type: 'fetchModels', provider: this.value });
        } else {
            modelSelect.style.display = 'none';
        }
    });

    modelSelect.addEventListener('change', function() {
        if (this.value) {
            vscode.postMessage({ type: 'changeModel', model: this.value });
        }
    });

    approvalSelect.addEventListener('change', function() {
        vscode.postMessage({ type: 'changeApproval', mode: this.value });
    });

    newSessionBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'newSession' });
    });

    saveSessionBtn.addEventListener('click', function() {
        vscode.postMessage({ type: 'saveSession' });
    });

    deleteSessionBtn.addEventListener('click', function() {
        var selectedId = sessionSelect.value;
        if (selectedId) {
            vscode.postMessage({ type: 'deleteSession', sessionId: selectedId });
        }
    });

    sessionSelect.addEventListener('change', function() {
        if (this.value) {
            vscode.postMessage({ type: 'loadSession', sessionId: this.value });
        }
    });

    function populateSessionList(sessions, activeId) {
        sessionSelect.innerHTML = '';
        if (!sessions || sessions.length === 0) {
            var opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No sessions';
            sessionSelect.appendChild(opt);
            return;
        }
        sessions.forEach(function(s) {
            var opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            if (s.id === activeId) opt.selected = true;
            sessionSelect.appendChild(opt);
        });
    }

    function populateModels(models, error) {
        modelSelect.innerHTML = '';
        if (error || !models || models.length === 0) {
            var opt = document.createElement('option');
            opt.value = '';
            opt.textContent = error ? 'No models found' : 'No models installed';
            modelSelect.appendChild(opt);
            return;
        }
        models.forEach(function(name) {
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            modelSelect.appendChild(opt);
        });
    }

    function sendMessage() {
        var text = messageInput.value.trim();
        if (!text || isProcessing) return;
        cmdHistory.push(text);
        cmdHistoryPos = -1;
        vscode.postMessage({ type: 'saveCmdHistory', history: cmdHistory });
        var displayText = text;
        if (pendingImages.length > 0) {
            displayText += '\n\n[' + pendingImages.length + ' image(s) attached]';
        }
        addMessage('user', displayText);
        messageInput.value = '';
        messageInput.style.height = 'auto';
        var imgs = pendingImages.slice();
        pendingImages = [];
        var container = document.getElementById('image-preview-container');
        container.innerHTML = '';
        container.style.display = 'none';
        var welcome = chatContainer.querySelector('.welcome-message');
        if (welcome) welcome.remove();
        showTypingIndicator();
        isProcessing = true;
        sendBtn.disabled = true;
        stopBtn.disabled = false;
        vscode.postMessage({ type: 'sendMessage', text: text, images: imgs });
    }

    function stopGeneration() {
        vscode.postMessage({ type: 'stopGeneration' });
        hideTypingIndicator();
        // Remove any pending approval prompts
        var approvals = chatContainer.querySelectorAll('.approval-prompt');
        for (var ai = 0; ai < approvals.length; ai++) {
            var ab = approvals[ai].querySelectorAll('button');
            for (var bi = 0; bi < ab.length; bi++) { ab[bi].disabled = true; }
            var lbl = approvals[ai].querySelector('.approval-label');
            if (lbl) lbl.innerHTML = '&#9632; Stopped';
        }
        isProcessing = false;
        sendBtn.disabled = false;
        stopBtn.disabled = true;
        currentAssistantMessage = null;
        if (debugEl) debugEl.textContent = 'Stopped';
        saveChatState();
    }

    function compressHistory() {
        vscode.postMessage({ type: 'compressHistory' });
        compressBtn.disabled = true;
        compressBtn.textContent = 'Compressing...';
    }

    function runBenchmark() {
        vscode.postMessage({ type: 'runBenchmark' });
        benchmarkBtn.disabled = true;
        benchmarkBtn.textContent = 'Benchmarking...';
    }

    function runBatchBenchmark() {
        var tries = parseInt(batchTriesInput.value, 10) || 2;
        vscode.postMessage({ type: 'runBatchBenchmark', tries: tries });
        batchBenchmarkBtn.disabled = true;
        batchBenchmarkBtn.textContent = 'Batching...';
        isProcessing = true;
        sendBtn.disabled = true;
        stopBtn.disabled = false;
    }

    function clearChat() {
        chatContainer.innerHTML = '';
        if (debugEl) chatContainer.appendChild(debugEl);
        vscode.postMessage({ type: 'clearChat' });
        saveChatState();
    }

    function addMessage(role, content, messageId) {
        hideTypingIndicator();
        var div = document.createElement('div');
        div.className = 'message ' + role;
        if (messageId) div.dataset.messageId = messageId;
        var parsedContent = parseContent(content);
        div.innerHTML = parsedContent;
        chatContainer.appendChild(div);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        saveChatState();
        return div;
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function attrEncode(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    var LINK_WEB_RE = /(?<![\w"=/'\\:.])(https?:\/\/[^\s<>"']+)/g;
    var LINK_FILE_RE = /(?<![\w"=/'\\:.])(?:[A-Za-z]:)?[\\/]?[\w.~-]+(?:[\\/][\w.~-]+)*\.(?:tsx?|mjs|cjs|jsx?|pyw?|jsonc?|md|markdown|txt|html?|css|scss|less|vue|svelte|cpp?|hpp?|cc|c|h|go|rs|rb|php|java|kt|kts|swift|sh|bash|ps1|psm1|bat|cmd|ya?ml|toml|ini|cfg|conf|xml|svg|png|jpe?g|gif|webp|ico|map|sql|lock|env|log|csv|tsv|sqlite|db|d\.ts|ttf|woff2?)(?![\\/\w])/g;

    function addLinksToText(text) {
        var out = '';
        var lastIndex = 0;
        text.replace(LINK_WEB_RE, function(match, url, offset) {
            var clean = url.replace(/[.,;:!?]+$/, '').replace(/[)\]}]+$/, '');
            out += text.substring(lastIndex, offset);
            out += '<a class="ll web" href="#" data-url="' + attrEncode(clean) + '" title="Open in browser">' +
                '<span class="ll-text">' + clean + '</span><span class="ll-badge">open &#8599;</span></a>';
            lastIndex = offset + url.length;
            return match;
        });
        out += text.substring(lastIndex);
        out = out.replace(LINK_FILE_RE, function(match) {
            return '<a class="ll file" href="#" data-path="' + attrEncode(match) + '" title="Open in VS Code">' +
                '<span class="ll-text">' + match + '</span><span class="ll-badge">open</span></a>';
        });
        return out;
    }

    function addContentLinks(escaped) {
        return escaped.split(/(<[^>]*>)/).map(function(part) {
            if (part.length > 0 && part.charAt(0) === '<' && part.charAt(part.length - 1) === '>') {
                return part;
            }
            return addLinksToText(part);
        }).join('');
    }

    function parseContent(content) {
        var escaped = escapeHtml(content);
        escaped = escaped.replace(/!\[image\]\(data:(image\/[^;]+);base64,([^)]+)\)/g, function(m, mime, b64) {
            return '<img src="data:' + mime + ';base64,' + b64 + '" class="chat-image" alt="Image">';
        });
        escaped = escaped.replace(/\[READ\]([\s\S]*?)\[\/READ\]/g, function(m, p) {
            return '<div class="cmd-block"><span class="cmd-label">&#128196; Read</span><div class="cmd-text">' + escapeHtml(p.trim()) + '</div></div>';
        });
        escaped = escaped.replace(/\[WRITE\]([\s\S]*?)\[\/WRITE\]/g, function(m, w) {
            var n = w.indexOf('\n');
            var wp = n === -1 ? w.trim() : w.substring(0, n).trim();
            var wc = n === -1 ? '' : w.substring(n);
            return '<div class="cmd-block"><span class="cmd-label">&#128221; Write</span><div class="cmd-text">' + escapeHtml(wp) + '</div>' + (wc ? '<div style="margin-top:6px;padding:6px;background:var(--vscode-terminal-background);border-radius:4px;font-size:11px;white-space:pre-wrap;max-height:200px;overflow-y:auto;">' + escapeHtml(wc) + '</div>' : '') + '</div>';
        });
        escaped = escaped.replace(/\[SEARCH\]([\s\S]*?)\[\/SEARCH\]/g, function(m, p) {
            return '<div class="cmd-block"><span class="cmd-label">&#128270; Search</span><div class="cmd-text">' + escapeHtml(p.trim()) + '</div></div>';
        });
        escaped = escaped.replace(/\[FILES\]([\s\S]*?)\[\/FILES\]/g, function(m, p) {
            return '<div class="cmd-block"><span class="cmd-label">&#128193; Files</span><div class="cmd-text">' + escapeHtml(p.trim()) + '</div></div>';
        });
        escaped = escaped.replace(/\[ASK\]([\s\S]*?)\[\/ASK\]/g, function(match, question) {
            var escapedQ = escapeHtml(question);
            return '<div style="background:var(--vscode-inputValidation-infoBackground);border:1px solid var(--vscode-inputValidation-infoBorder);border-radius:6px;padding:10px 14px;margin:8px 0;">' +
                '<div style="font-size:11px;color:var(--vscode-inputValidation-infoForeground);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px;">&#10067; Question</div>' +
                '<div style="font-size:13px;">' + escapedQ.replace(/\n/g, '<br>') + '</div>' +
                '</div>';
        });
        escaped = escaped.replace(/\[CHOICES\][\s\S]*?\[\/CHOICES\]/g, '');
        escaped = escaped.replace(/\[CMD\]([\s\S]*?)\[\/CMD\]/g, function(match, cmd) {
            var escapedCmd = escapeHtml(cmd);
            var cmdForAttr = cmd.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            return '<div class="cmd-block">' +
                '<span class="cmd-label">&#9654; Command</span>' +
                '<div class="cmd-text">' + escapedCmd + '</div>' +
                '<button class="run-btn" data-cmd="' + cmdForAttr + '">Run in Terminal</button>' +
                '</div>';
        });
        escaped = escaped.replace(/\[OUTPUT\]([\s\S]*?)\[\/OUTPUT\]/g, function(match, output) {
            var escapedOutput = escapeHtml(output);
            return '<div class="cmd-output success">' +
                '<span class="output-label">&#128203; Output</span>' +
                escapedOutput +
                '</div>';
        });
        escaped = escaped.replace(/\[ERROR\]([\s\S]*?)\[\/ERROR\]/g, function(match, error) {
            var escapedError = escapeHtml(error);
            return '<div class="cmd-output error">' +
                '<span class="output-label">&#10060; Error</span>' +
                escapedError +
                '</div>';
        });
        escaped = addContentLinks(escaped);
        escaped = escaped.replace(/\n/g, '<br>');
        return escaped;
    }

    chatContainer.addEventListener('click', function(e) {
        var btn = e.target.closest('.run-btn');
        if (btn && !btn.disabled) {
            btn.disabled = true;
            btn.textContent = 'Running...';
            vscode.postMessage({ type: 'executeCommand', command: btn.dataset.cmd });
            return;
        }
        var linkEl = e.target.closest('.ll');
        if (!linkEl) return;
        e.preventDefault();
        if (linkEl.classList.contains('web')) {
            vscode.postMessage({ type: 'openLink', url: linkEl.dataset.url });
        } else if (linkEl.classList.contains('file')) {
            vscode.postMessage({ type: 'openFile', path: linkEl.dataset.path });
        }
    });

    function showTypingIndicator() {
        hideTypingIndicator();
        var div = document.createElement('div');
        div.className = 'typing-indicator';
        div.id = 'typing-indicator';
        div.innerHTML = '<span></span><span></span><span></span>';
        chatContainer.appendChild(div);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function hideTypingIndicator() {
        var indicator = document.getElementById('typing-indicator');
        if (indicator) indicator.remove();
    }

    function updateAssistantMessage(content, messageId) {
        hideTypingIndicator();
        if (debugEl) debugEl.textContent = 'Receiving response...';
        var msgEl = currentAssistantMessage;
        if (!msgEl || !chatContainer.contains(msgEl)) {
            msgEl = addMessage('assistant', '', messageId);
            currentAssistantMessage = msgEl;
        }
        var parsed = parseContent(content);
        msgEl.innerHTML = parsed;
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function finalizeAssistantMessage(content, messageId, stats, modelName, contextSize, thinking) {
        hideTypingIndicator();
        if (debugEl) debugEl.textContent = 'Response complete';
        if (currentAssistantMessage && chatContainer.contains(currentAssistantMessage)) {
            var parsed = parseContent(content);
            var statsHtml = '';
            if (modelName) {
                statsHtml += '<span class="model-name">' + escapeHtml(modelName) + '</span>';
            }
            if (stats && stats.tokensPerSec) {
                if (statsHtml) statsHtml += ' &middot; ';
                statsHtml += stats.tokensPerSec + ' tokens/sec';
                if (stats.tokenCount) statsHtml += ' &middot; ' + stats.tokenCount + ' tokens';
                if (stats.durationMs) statsHtml += ' &middot; ' + (stats.durationMs / 1000).toFixed(1) + 's';
            } else if (stats && stats.tokenCount) {
                if (statsHtml) statsHtml += ' &middot; ';
                statsHtml += stats.tokenCount + ' tokens';
                if (stats.durationMs) statsHtml += ' &middot; ' + (stats.durationMs / 1000).toFixed(1) + 's';
            } else if (stats && stats.durationMs) {
                if (statsHtml) statsHtml += ' &middot; ';
                statsHtml += (stats.durationMs / 1000).toFixed(1) + 's';
            }
            if (contextSize > 0 && stats && stats.promptEvalCount > 0) {
                var pct = ((stats.promptEvalCount / contextSize) * 100);
                var pctStr = pct < 0.1 ? '<0.1%' : pct.toFixed(1) + '%';
                statsHtml += ' &middot; <span class="ctx-size">' + stats.promptEvalCount + '/' + formatCtx(contextSize) + ' (' + pctStr + ')</span>';
            } else if (contextSize > 0) {
                statsHtml += ' &middot; <span class="ctx-size">' + formatCtx(contextSize) + '</span>';
            }
            if (statsHtml) {
                parsed += '<div class="response-stats">' + statsHtml + '</div>';
            }
            currentAssistantMessage.innerHTML = parsed;
            if (thinking && showThinking) {
                appendThinkingToMessage(currentAssistantMessage, thinking);
            }
        } else {
            var msg = addMessage('assistant', content, messageId);
            if (msg) {
                if (thinking && showThinking) {
                    appendThinkingToMessage(msg, thinking);
                }
                var statsDiv = document.createElement('div');
                statsDiv.className = 'response-stats';
                var parts = [];
                if (modelName) parts.push('<span class="model-name">' + escapeHtml(modelName) + '</span>');
                if (stats && stats.tokensPerSec) {
                    parts.push(stats.tokensPerSec + ' tokens/sec');
                    if (stats.tokenCount) parts.push(stats.tokenCount + ' tokens');
                    if (stats.durationMs) parts.push((stats.durationMs / 1000).toFixed(1) + 's');
                } else if (stats && stats.tokenCount) {
                    parts.push(stats.tokenCount + ' tokens');
                    if (stats.durationMs) parts.push((stats.durationMs / 1000).toFixed(1) + 's');
                } else if (stats && stats.durationMs) {
                    parts.push((stats.durationMs / 1000).toFixed(1) + 's');
                }
                if (contextSize > 0 && stats && stats.promptEvalCount > 0) {
                    var pct2 = ((stats.promptEvalCount / contextSize) * 100);
                    var pctStr2 = pct2 < 0.1 ? '<0.1%' : pct2.toFixed(1) + '%';
                    parts.push('<span class="ctx-size">' + stats.promptEvalCount + '/' + formatCtx(contextSize) + ' (' + pctStr2 + ')</span>');
                } else if (contextSize > 0) {
                    parts.push('<span class="ctx-size">' + formatCtx(contextSize) + '</span>');
                }
                if (parts.length > 0) {
                    statsDiv.innerHTML = parts.join(' &middot; ');
                    msg.appendChild(statsDiv);
                }
            }
        }
        currentAssistantMessage = null;
        currentThinkingEl = null;
        isProcessing = false;
        sendBtn.disabled = false;
        stopBtn.disabled = true;
        saveChatState();
    }

    function appendThinkingToMessage(msgEl, thinking) {
        var existing = msgEl.querySelector('.thinking-block');
        if (existing) { existing.remove(); }
        var details = document.createElement('details');
        details.className = 'thinking-block';
        details.open = showThinking;
        var summary = document.createElement('summary');
        summary.className = 'thinking-summary';
        summary.textContent = '\u{1F9E0} Thinking';
        details.appendChild(summary);
        var contentDiv = document.createElement('div');
        contentDiv.className = 'thinking-content';
        contentDiv.textContent = thinking;
        details.appendChild(contentDiv);
        msgEl.insertBefore(details, msgEl.firstChild);
        currentThinkingEl = details;
    }

    function updateThinkingContent(content) {
        hideTypingIndicator();
        if (debugEl) debugEl.textContent = 'Model thinking...';
        var msgEl = currentAssistantMessage;
        if (!msgEl || !chatContainer.contains(msgEl)) {
            msgEl = addMessage('assistant', '', null);
            currentAssistantMessage = msgEl;
        }
        var existing = msgEl.querySelector('.thinking-block');
        if (existing) {
            var contentDiv = existing.querySelector('.thinking-content');
            if (contentDiv) contentDiv.textContent = content;
        } else {
            appendThinkingToMessage(msgEl, content);
        }
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function clearThinkingContent() {
        var els = chatContainer.querySelectorAll('.thinking-block');
        for (var ti = 0; ti < els.length; ti++) {
            els[ti].remove();
        }
        currentThinkingEl = null;
    }

    function formatCtx(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M ctx';
        if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'K ctx';
        return n + ' ctx';
    }

    window.addEventListener('message', function(event) {
        var message = event.data;
        try {
            switch (message.type) {
                case 'addMessage':
                    addMessage(message.role, message.content, message.messageId);
                    break;
                case 'updateAssistantMessage':
                    updateAssistantMessage(message.content, message.messageId);
                    break;
                case 'finalizeAssistantMessage':
                    finalizeAssistantMessage(message.content, message.messageId, message.stats, message.model, message.contextSize, message.thinking);
                    break;
                case 'addCommandOutput':
                    // Remove any executing indicator
                    var execInd = document.getElementById('executing-indicator');
                    if (execInd) execInd.remove();
                    var msgs = chatContainer.querySelectorAll('.message.assistant');
                    var lastMsg = msgs[msgs.length - 1];
                    if (lastMsg) {
                        var outputDiv = document.createElement('div');
                        outputDiv.className = 'cmd-output ' + (message.success ? 'success' : 'error');
                        outputDiv.innerHTML = '<span class="output-label">' +
                            (message.success ? '&#128203; Output' : '&#10060; Error') + '</span>' +
                            escapeHtml(message.output).replace(/\n/g, '<br>');
                        lastMsg.appendChild(outputDiv);
                        chatContainer.scrollTop = chatContainer.scrollHeight;
                    }
                    saveChatState();
                    break;
                case 'executingCommand':
                    var execDiv = document.createElement('div');
                    execDiv.id = 'executing-indicator';
                    execDiv.className = 'message system';
                    execDiv.innerHTML = '&#9654; Executing: <code>' + escapeHtml(message.command) + '</code>';
                    chatContainer.appendChild(execDiv);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    break;
                case 'startAssistantMessage':
                    showTypingIndicator();
                    break;
                case 'commandComplete':
                    document.querySelectorAll('.run-btn:disabled').forEach(function(btn) {
                        btn.disabled = false;
                        btn.textContent = 'Run in Terminal';
                    });
                    break;
                case 'error':
                    addMessage('system', '&#10060; ' + (message.text || 'Unknown error'));
                    isProcessing = false;
                    sendBtn.disabled = false;
                    stopBtn.disabled = true;
                    hideTypingIndicator();
                    if (debugEl) debugEl.textContent = 'Error: ' + (message.text || 'Unknown');
                    break;
                case 'setProvider':
                    providerSelect.value = message.provider;
                    modelSelect.innerHTML = '<option value="">Loading models...</option>';
                    if (providerCanFetchModels(message.provider)) {
                        modelSelect.style.display = '';
                        vscode.postMessage({ type: 'fetchModels', provider: message.provider });
                    } else {
                        modelSelect.style.display = 'none';
                    }
                    break;
                case 'setModel':
                    if (message.model) {
                        modelSelect.value = message.model;
                    }
                    break;
                case 'modelList':
                    if (!message.provider || message.provider === providerSelect.value) {
                        populateModels(message.models, message.error);
                    }
                    break;
                case 'initChatState':
                    if (message.html) {
                        chatContainer.innerHTML = message.html;
                        debugEl = document.getElementById('debug-status');
                    }
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    break;
                case 'setApproval':
                    approvalSelect.value = message.mode;
                    break;
                case 'approvalRequest':
                    var appDiv = document.createElement('div');
                    appDiv.className = 'approval-prompt';
                    appDiv.id = message.id;
                    var dangerLabel = message.danger ? '&#9888; Potentially dangerous:' : 'Approve command:';
                    appDiv.innerHTML = '<div class="approval-label">' + dangerLabel + '</div>' +
                        '<div class="approval-cmd">' + escapeHtml(message.command) + '</div>' +
                        '<div class="approval-buttons">' +
                        '<button class="approve-btn">Approve</button>' +
                        '<button class="deny-btn">Deny</button>' +
                        '</div>';
                    chatContainer.appendChild(appDiv);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    var approveBtn = appDiv.querySelector('.approve-btn');
                    var denyBtn = appDiv.querySelector('.deny-btn');
                    function handleApproval(approved) {
                        approveBtn.disabled = true;
                        denyBtn.disabled = true;
                        approveBtn.textContent = approved ? 'Approved' : '';
                        denyBtn.textContent = approved ? '' : 'Denied';
                        if (!approved) { denyBtn.textContent = 'Denied'; }
                        else { approveBtn.textContent = 'Approved'; }
                        vscode.postMessage({ type: 'approvalResponse', id: message.id, approved: approved });
                    }
                    approveBtn.addEventListener('click', function() { handleApproval(true); });
                    denyBtn.addEventListener('click', function() { handleApproval(false); });
                    break;
                case 'sessionList':
                    populateSessionList(message.sessions, message.activeId);
                    break;
                case 'sessionStarted':
                    chatContainer.innerHTML = '';
                    if (debugEl) chatContainer.appendChild(debugEl);
                    var welcome = document.createElement('div');
                    welcome.className = 'welcome-message';
                    welcome.innerHTML = '<h2>Welcome to Local Copilot</h2>' +
                        '<p>Your AI assistant with local command execution capabilities.</p>' +
                        '<div class="features">' +
                        '<div class="feature"><span class="check">&#10003;</span> Chat with AI models (Ollama, LM Studio, JAN AI, OpenAI, Copilot, VS Code LM)</div>' +
                        '<div class="feature"><span class="check">&#10003;</span> Execute commands directly in VS Code terminal</div>' +
                        '<div class="feature"><span class="check">&#10003;</span> Read and analyze files in your workspace</div>' +
                        '<div class="feature"><span class="check">&#10003;</span> Install packages and run scripts</div>' +
                        '</div>' +
                        '<p style="margin-top: 16px; font-size: 12px;">Type a message below to get started!</p>';
                    chatContainer.appendChild(welcome);
                    sessionSelect.value = message.sessionId;
                    currentAssistantMessage = null;
                    isProcessing = false;
                    sendBtn.disabled = false;
                    stopBtn.disabled = true;
                    break;
                case 'sessionLoaded':
                    chatContainer.innerHTML = '';
                    if (debugEl) chatContainer.appendChild(debugEl);
                    if (message.chatHtml) {
                        chatContainer.innerHTML = message.chatHtml;
                        debugEl = document.getElementById('debug-status');
                    } else if (message.chatHistory && message.chatHistory.length > 0) {
                        for (var ci = 0; ci < message.chatHistory.length; ci++) {
                            var msg = message.chatHistory[ci];
                            if (msg.role === 'system') {
                                addMessage('system', msg.content);
                            } else {
                                addMessage(msg.role, msg.content);
                            }
                        }
                    } else {
                        var welcome2 = document.createElement('div');
                        welcome2.className = 'welcome-message';
                        welcome2.innerHTML = '<h2>Welcome to Local Copilot</h2>' +
                            '<p>Your AI assistant with local command execution capabilities.</p>' +
                            '<div class="features">' +
                            '<div class="feature"><span class="check">&#10003;</span> Chat with AI models (Ollama, LM Studio, JAN AI, OpenAI, Copilot, VS Code LM)</div>' +
                            '<div class="feature"><span class="check">&#10003;</span> Execute commands directly in VS Code terminal</div>' +
                            '<div class="feature"><span class="check">&#10003;</span> Read and analyze files in your workspace</div>' +
                            '<div class="feature"><span class="check">&#10003;</span> Install packages and run scripts</div>' +
                            '</div>' +
                            '<p style="margin-top: 16px; font-size: 12px;">Type a message below to get started!</p>';
                        chatContainer.appendChild(welcome2);
                    }
                    sessionSelect.value = message.sessionId;
                    currentAssistantMessage = null;
                    isProcessing = false;
                    sendBtn.disabled = false;
                    stopBtn.disabled = true;
                    break;
                case 'sessionSaved':
                    sessionSelect.value = message.sessionId;
                    break;
                case 'choiceRequest':
                    var choicesDiv = document.createElement('div');
                    choicesDiv.className = 'approval-prompt';
                    choicesDiv.id = message.id;
                    var regularChoices = [];
                    var seenCustomLike = false;
                    for (var ci = 0; ci < message.choices.length; ci++) {
                        var chStr = String(message.choices[ci]).trim();
                        var chLower = chStr.toLowerCase();
                        if (chStr === '__custom__' || chLower === 'custom' || chLower === 'custom...' || chLower === 'custom option' || chLower === 'other' || chLower === 'something else' || chLower === 'type your own') {
                            seenCustomLike = true;
                        } else {
                            regularChoices.push(chStr);
                        }
                    }
                    var html = '<div class="approval-label">Choose an option:</div>';
                    for (var ci2 = 0; ci2 < regularChoices.length; ci2++) {
                        var choiceLabel = escapeHtml(regularChoices[ci2]);
                        html += '<button class="choice-btn" data-choice="' + choiceLabel.replace(/"/g, '&quot;') + '" style="display:block;width:100%;margin:4px 0;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:12px;text-align:left;">' + choiceLabel + '</button>';
                    }
                    html += '<button id="custom-choice-open" class="choice-custom" style="display:block;width:100%;margin:4px 0;padding:6px 12px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;border-radius:4px;cursor:pointer;font-size:12px;text-align:left;">&#9998; Custom...</button>' +
                        '<div id="custom-choice-editor" style="display:none;margin-top:4px;">' +
                        '<div style="display:flex;gap:6px;">' +
                        '<input id="custom-choice-input" type="text" placeholder="Type your own answer..." style="flex:1;padding:6px 8px;border-radius:4px;border:1px solid var(--vscode-panel-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:12px;">' +
                        '<button id="custom-choice-submit" style="padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;">Submit</button>' +
                        '</div>' +
                        '<div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;">Press Enter to submit</div>' +
                        '</div>';
                    choicesDiv.innerHTML = html;
                    chatContainer.appendChild(choicesDiv);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    function disableAllChoiceButtons() {
                        choicesDiv.querySelectorAll('.choice-btn, .choice-custom').forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });
                    }
                    choicesDiv.querySelectorAll('.choice-btn').forEach(function(btn) {
                        btn.addEventListener('click', function() {
                            disableAllChoiceButtons();
                            var editor = choicesDiv.querySelector('#custom-choice-editor');
                            if (editor) { editor.style.display = 'none'; }
                            btn.textContent = '✓ ' + btn.textContent;
                            vscode.postMessage({ type: 'choiceResponse', choice: btn.dataset.choice });
                        });
                    });
                    var openBtn = choicesDiv.querySelector('#custom-choice-open');
                    var editor = choicesDiv.querySelector('#custom-choice-editor');
                    var inputEl = choicesDiv.querySelector('#custom-choice-input');
                    var submitEl = choicesDiv.querySelector('#custom-choice-submit');
                    openBtn.addEventListener('click', function() {
                        disableAllChoiceButtons();
                        openBtn.disabled = true;
                        openBtn.style.opacity = '0.5';
                        openBtn.textContent = '✏️ Custom...';
                        editor.style.display = '';
                        setTimeout(function() { inputEl.focus(); }, 50);
                    });
                    inputEl.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            submitEl.click();
                        }
                    });
                    submitEl.addEventListener('click', function() {
                        var text = inputEl.value.trim();
                        if (!text) { inputEl.focus(); return; }
                        inputEl.disabled = true;
                        submitEl.disabled = true;
                        submitEl.textContent = '✓ Sent';
                        vscode.postMessage({ type: 'choiceResponse', choice: text });
                    });
                    break;
                case 'stopComplete':
                    isProcessing = false;
                    sendBtn.disabled = false;
                    stopBtn.disabled = true;
                    hideTypingIndicator();
                    break;
                case 'clipboardImage':
                    console.log('[Local Copilot] Received clipboardImage from extension, has base64:', !!message.base64, 'mimeType:', message.mimeType);
                    if (message.base64 && message.mimeType) {
                        addPendingImage('data:' + message.mimeType + ';base64,' + message.base64, message.mimeType);
                        if (messageInput.value.trim()) {
                            console.log('[Local Copilot] Clearing auto-inserted text:', messageInput.value);
                            messageInput.value = '';
                            messageInput.style.height = 'auto';
                        }
                    }
                    break;
                case 'compressComplete':
                    compressBtn.disabled = false;
                    compressBtn.textContent = 'Compress';
                    break;
                case 'benchmarkComplete':
                    benchmarkBtn.disabled = false;
                    benchmarkBtn.textContent = 'Benchmark';
                    break;
                case 'batchBenchmarkComplete':
                    batchBenchmarkBtn.disabled = false;
                    batchBenchmarkBtn.textContent = 'Batch';
                    isProcessing = false;
                    sendBtn.disabled = false;
                    stopBtn.disabled = true;
                    hideTypingIndicator();
                    break;
                case 'benchmarkProgress':
                    var progEl = document.getElementById('batch-progress');
                    if (!progEl) {
                        progEl = document.createElement('div');
                        progEl.id = 'batch-progress';
                        progEl.className = 'message system';
                        chatContainer.appendChild(progEl);
                    }
                    progEl.innerHTML = escapeHtml(message.text).replace(/\n/g, '<br>');
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    break;
                case 'cmdHistory':
                    if (message.history && message.history.length > 0) {
                        cmdHistory = message.history;
                        cmdHistoryPos = -1;
                    }
                    break;
                case 'clearAndShowCompressed':
                    chatContainer.innerHTML = '';
                    if (debugEl) chatContainer.appendChild(debugEl);
                    var compressedMsg = document.createElement('div');
                    compressedMsg.className = 'message system';
                    compressedMsg.innerHTML = '📦 Chat history compressed: ' + message.count + ' previous messages removed and summarized for context.';
                    chatContainer.appendChild(compressedMsg);
                    compressBtn.disabled = false;
                    compressBtn.textContent = 'Compress';
                    currentAssistantMessage = null;
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    saveChatState();
                    break;
                case 'updateThinkingContent':
                    updateThinkingContent(message.content);
                    break;
                case 'clearThinkingContent':
                    clearThinkingContent();
                    break;
                case 'thinkingToggled':
                    showThinking = message.show;
                    var thinkingToggle = document.getElementById('thinking-toggle');
                    if (thinkingToggle) {
                        thinkingToggle.textContent = showThinking ? '🧠 Thinking ON' : '🧠 Thinking OFF';
                        thinkingToggle.classList.toggle('active', showThinking);
                    }
                    var allThinking = chatContainer.querySelectorAll('.thinking-block');
                    for (var ti = 0; ti < allThinking.length; ti++) {
                        allThinking[ti].open = showThinking;
                    }
                    break;
                case 'configLoaded':
                case 'configSaved':
                    applyConfig(message.config, message.configPath || '');
                    break;
            }
        } catch(e) {
            addMessage('system', 'Internal error handling message: ' + e.message);
        }
    });

    messageInput.focus();

    stopBtn.disabled = true;

    // ----- Config UI -----
    var currentConfig = null;
    var configOverlay = document.getElementById('config-overlay');
    var configBtn = document.getElementById('config-btn');
    var configProviders = document.getElementById('config-providers');
    var configAddBtn = document.getElementById('config-add-provider');

    function field(id) { return document.getElementById(id); }

    function setFieldValue(id, value) {
        var el = field(id);
        if (el && value !== undefined && value !== null) el.value = value;
    }

    function providerCanFetchModels(id) {
        if (!id) return false;
        if (currentConfig && currentConfig.providers && currentConfig.providers[id]) {
            var t = currentConfig.providers[id].type;
            return t === 'ollama' || t === 'openai' || t === 'vscode-lm';
        }
        return id === 'ollama' || id === 'lmstudio' || id === 'janai' || id === 'vscode-lm';
    }

    function updateProviderBlockVisibility(div) {
        var type = div.querySelector('.pf-type').value;
        var epWrap = div.querySelector('.pf-endpoint-wrap');
        var modelRow = div.querySelector('.pf-model-row');
        var keyWrap = div.querySelector('.pf-key-wrap');
        var hint = div.querySelector('.pf-hint');
        epWrap.classList.toggle('hidden', type === 'copilot-web');
        modelRow.classList.toggle('hidden', type === 'copilot-web');
        keyWrap.classList.toggle('hidden', type !== 'openai');
        hint.classList.toggle('hidden', type !== 'copilot-web');
    }

    function buildProviderBlock(id, p) {
        p = p || {};
        var type = p.type || 'openai';
        var div = document.createElement('div');
        div.className = 'provider-block';
        div.innerHTML =
            '<div class="provider-block-header">' +
            '  <span class="provider-name">' + escapeHtml(p.label || id) + '</span>' +
            '  <button type="button" class="provider-delete" title="Delete provider">&#128465;</button>' +
            '</div>' +
            '<div class="pf-row">' +
            '  <div><label>ID</label><input type="text" class="pf-id" value="' + escapeHtml(id) + '"></div>' +
            '  <div><label>Label</label><input type="text" class="pf-label" value="' + escapeHtml(p.label || id) + '"></div>' +
            '</div>' +
            '<div class="pf-row"><div><label>Type</label><select class="pf-type">' +
            '  <option value="ollama">Ollama compatible</option>' +
            '  <option value="openai">OpenAI compatible</option>' +
            '  <option value="copilot-web">GitHub Copilot</option>' +
            '  <option value="vscode-lm">VS Code LM</option>' +
            '</select></div></div>' +
            '<label class="pf-endpoint-wrap">Endpoint' +
            '  <input type="text" class="pf-endpoint" value="' + escapeHtml(p.endpoint || '') + '" placeholder="http://host:port/v1">' +
            '</label>' +
            '<div class="pf-row pf-model-row">' +
            '  <div><label>Model</label><input type="text" class="pf-model" value="' + escapeHtml(p.model || '') + '"></div>' +
            '  <div class="pf-key-wrap"><label>API Key</label><input type="password" class="pf-key" value="' + escapeHtml(p.apiKey || '') + '" placeholder="sk-..."></div>' +
            '</div>' +
            '<p class="provider-block-hint pf-hint hidden">Uses your installed GitHub Copilot extension.</p>';
        div.querySelector('.pf-type').value = type;
        updateProviderBlockVisibility(div);
        div.querySelector('.pf-type').addEventListener('change', function() { updateProviderBlockVisibility(div); });
        div.querySelector('.pf-id').addEventListener('input', function() {
            div.querySelector('.provider-name').textContent = div.querySelector('.pf-label').value.trim() || this.value;
        });
        div.querySelector('.pf-label').addEventListener('input', function() {
            div.querySelector('.provider-name').textContent = this.value.trim() || div.querySelector('.pf-id').value;
        });
        div.querySelector('.provider-delete').addEventListener('click', function() {
            if (document.querySelectorAll('#config-providers .provider-block').length <= 1) return;
            var wasActive = field('config-active-provider').value === id;
            div.remove();
            updateDeleteButtons();
            rebuildProviderOptions();
            if (wasActive) {
                var first = document.querySelector('#config-providers .provider-block .pf-id');
                if (first) field('config-active-provider').value = first.value;
            }
        });
        return div;
    }

    function updateDeleteButtons() {
        var blocks = document.querySelectorAll('#config-providers .provider-block');
        var canDelete = blocks.length > 1;
        for (var i = 0; i < blocks.length; i++) {
            blocks[i].querySelector('.provider-delete').disabled = !canDelete;
        }
    }

    function renderProviderBlocks(cfg) {
        configProviders.innerHTML = '';
        var prov = (cfg && cfg.providers) || {};
        var keys = Object.keys(prov);
        for (var i = 0; i < keys.length; i++) {
            configProviders.appendChild(buildProviderBlock(keys[i], prov[keys[i]]));
        }
        updateDeleteButtons();
    }

    function rebuildProviderOptions() {
        var prov = (currentConfig && currentConfig.providers) || {};
        var keys = Object.keys(prov);
        function fill(sel) {
            sel.innerHTML = '';
            for (var i = 0; i < keys.length; i++) {
                var opt = document.createElement('option');
                opt.value = keys[i];
                opt.textContent = (prov[keys[i]].label || keys[i]) + (keys[i] === (currentConfig && currentConfig.aiProvider) ? ' (active)' : '');
                sel.appendChild(opt);
            }
            if (keys.length === 0) {
                var empty = document.createElement('option');
                empty.value = '';
                empty.textContent = 'No providers';
                sel.appendChild(empty);
            }
        }
        fill(providerSelect);
        fill(field('config-active-provider'));
        var active = currentConfig && (currentConfig.aiProvider || currentConfig.activeProvider);
        if (active) {
            providerSelect.value = active;
            field('config-active-provider').value = active;
        }
    }

    function applyConfig(cfg, path) {
        currentConfig = cfg;
        if (path && field('config-path')) field('config-path').textContent = path;
        if (!cfg) return;
        if (cfg.approvalMode) {
            setFieldValue('config-approval', cfg.approvalMode);
            if (approvalSelect) approvalSelect.value = cfg.approvalMode;
        }
        if (cfg.systemPrompt !== undefined) setFieldValue('config-system-prompt', cfg.systemPrompt);
        rebuildProviderOptions();
        renderProviderBlocks(cfg);
        var active = cfg.aiProvider || cfg.activeProvider;
        if (active && providerCanFetchModels(active)) {
            modelSelect.style.display = '';
            vscode.postMessage({ type: 'fetchModels', provider: active });
        } else if (active) {
            modelSelect.style.display = 'none';
        }
    }

    function collectProviders() {
        var providers = {};
        var blocks = document.querySelectorAll('#config-providers .provider-block');
        for (var i = 0; i < blocks.length; i++) {
            var blk = blocks[i];
            var id = blk.querySelector('.pf-id').value.trim();
            if (!id) continue;
            var type = blk.querySelector('.pf-type').value;
            var p = {
                type: type,
                label: blk.querySelector('.pf-label').value.trim() || id
            };
            var epEl = blk.querySelector('.pf-endpoint');
            if (epEl && !epEl.classList.contains('hidden') && epEl.value.trim()) p.endpoint = epEl.value.trim();
            var modelEl = blk.querySelector('.pf-model');
            if (modelEl && !modelEl.classList.contains('hidden') && modelEl.value.trim()) p.model = modelEl.value.trim();
            var keyEl = blk.querySelector('.pf-key');
            if (keyEl && !keyEl.classList.contains('hidden') && keyEl.value) p.apiKey = keyEl.value;
            providers[id] = p;
        }
        return providers;
    }

    if (configBtn && configOverlay) {
        configBtn.addEventListener('click', function() {
            vscode.postMessage({ type: 'getConfig' });
            configOverlay.classList.add('open');
            var statusEl = field('config-status');
            if (statusEl) statusEl.textContent = '';
        });
        field('config-cancel-btn').addEventListener('click', function() {
            configOverlay.classList.remove('open');
        });
        configOverlay.addEventListener('click', function(e) {
            if (e.target === configOverlay) configOverlay.classList.remove('open');
        });
        configAddBtn.addEventListener('click', function() {
            configProviders.appendChild(buildProviderBlock('', { type: 'openai', label: 'New Provider' }));
            updateDeleteButtons();
            var last = configProviders.lastElementChild;
            if (last) last.querySelector('.pf-id').focus();
        });
        field('config-save-btn').addEventListener('click', function() {
            var providers = collectProviders();
            var active = field('config-active-provider').value;
            if (!providers[active]) {
                var firstId = Object.keys(providers)[0];
                active = firstId || '';
            }
            var cfg = {
                aiProvider: active,
                approvalMode: field('config-approval').value,
                systemPrompt: field('config-system-prompt').value,
                providers: providers
            };
            if (Object.keys(providers).length === 0) {
                var statusEl = field('config-status');
                if (statusEl) {
                    statusEl.textContent = 'At least one provider is required.';
                    statusEl.style.color = 'var(--vscode-errorForeground)';
                }
                return;
            }
            vscode.postMessage({ type: 'saveConfig', config: cfg });
            configOverlay.classList.remove('open');
            var statusEl = field('config-status');
            if (statusEl) {
                statusEl.textContent = 'Config saved. New provider/model settings are active.';
                statusEl.style.color = 'var(--vscode-testing-iconPassed)';
            }
        });
    }

    vscode.postMessage({ type: 'getConfig' });
    vscode.postMessage({ type: 'getChatState' });
    vscode.postMessage({ type: 'getCmdHistory' });
    vscode.postMessage({ type: 'getApproval' });
    vscode.postMessage({ type: 'getSessions' });
    vscode.postMessage({ type: 'getThinkingState' });

    if (providerSelect.value && providerCanFetchModels(providerSelect.value)) {
        modelSelect.style.display = '';
        vscode.postMessage({ type: 'fetchModels' });
    }
})();
