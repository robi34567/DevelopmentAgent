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
    var debugElOriginal = debugEl ? debugEl.outerHTML : '';
    var cmdHistory = [];
    var cmdHistoryPos = -1;

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

    providerSelect.addEventListener('change', function() {
        vscode.postMessage({ type: 'changeProvider', provider: this.value });
        modelSelect.innerHTML = '<option value="">Loading models...</option>';
        if (this.value === 'ollama' || this.value === 'lmstudio' || this.value === 'janai') {
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
        addMessage('user', text);
        messageInput.value = '';
        messageInput.style.height = 'auto';
        var welcome = chatContainer.querySelector('.welcome-message');
        if (welcome) welcome.remove();
        showTypingIndicator();
        isProcessing = true;
        sendBtn.disabled = true;
        stopBtn.disabled = false;
        vscode.postMessage({ type: 'sendMessage', text: text });
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

    function parseContent(content) {
        var escaped = escapeHtml(content);
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
        escaped = escaped.replace(/\n/g, '<br>');
        return escaped;
    }

    chatContainer.addEventListener('click', function(e) {
        var btn = e.target.closest('.run-btn');
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        btn.textContent = 'Running...';
        vscode.postMessage({ type: 'executeCommand', command: btn.dataset.cmd });
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

    function finalizeAssistantMessage(content, messageId, stats, modelName, contextSize) {
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
        } else {
            var msg = addMessage('assistant', content, messageId);
            if (msg) {
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
        isProcessing = false;
        sendBtn.disabled = false;
        stopBtn.disabled = true;
        saveChatState();
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
                    finalizeAssistantMessage(message.content, message.messageId, message.stats, message.model, message.contextSize);
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
                    if (message.provider === 'ollama' || message.provider === 'lmstudio' || message.provider === 'janai') {
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
                        '<div class="feature"><span class="check">&#10003;</span> Chat with AI models (Ollama, LM Studio, JAN AI, OpenAI, Copilot)</div>' +
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
                    var html = '<div class="approval-label">Choose an option:</div>';
                    for (var ci = 0; ci < message.choices.length; ci++) {
                        var choiceLabel = escapeHtml(message.choices[ci]);
                        html += '<button class="choice-btn" data-choice="' + choiceLabel.replace(/"/g, '&quot;') + '" style="display:block;width:100%;margin:4px 0;padding:6px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;cursor:pointer;font-size:12px;text-align:left;">' + choiceLabel + '</button>';
                    }
                    choicesDiv.innerHTML = html;
                    chatContainer.appendChild(choicesDiv);
                    chatContainer.scrollTop = chatContainer.scrollHeight;
                    choicesDiv.querySelectorAll('.choice-btn').forEach(function(btn) {
                        btn.addEventListener('click', function() {
                            var choice = btn.dataset.choice;
                            choicesDiv.querySelectorAll('.choice-btn').forEach(function(b) { b.disabled = true; b.style.opacity = '0.5'; });
                            btn.textContent = '✓ ' + btn.textContent;
                            vscode.postMessage({ type: 'choiceResponse', choice: choice });
                        });
                    });
                    break;
                case 'stopComplete':
                    isProcessing = false;
                    sendBtn.disabled = false;
                    stopBtn.disabled = true;
                    hideTypingIndicator();
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
            }
        } catch(e) {
            addMessage('system', 'Internal error handling message: ' + e.message);
        }
    });

    messageInput.focus();

    stopBtn.disabled = true;

    vscode.postMessage({ type: 'getChatState' });
    vscode.postMessage({ type: 'getApproval' });
    vscode.postMessage({ type: 'getSessions' });

    if (providerSelect.value === 'ollama' || providerSelect.value === 'lmstudio' || providerSelect.value === 'janai') {
        modelSelect.style.display = '';
        vscode.postMessage({ type: 'fetchModels' });
    }
})();
