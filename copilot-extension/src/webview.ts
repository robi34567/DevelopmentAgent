import * as vscode from 'vscode';

export function getWebviewContent(extensionUri: vscode.Uri, webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'main.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
    <title>Local Copilot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        #header {
            padding: 12px 16px;
            background: var(--vscode-titleBar-activeBackground);
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-shrink: 0;
        }
        #header h1 {
            font-size: 14px;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        #header h1 .icon {
            font-size: 18px;
        }
        #header-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }
        #provider-select, #model-select {
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
        }
        #clear-btn {
            background: none;
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-editor-foreground);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        #clear-btn:hover {
            background: var(--vscode-button-hoverBackground);
            color: var(--vscode-button-foreground);
        }
        #session-bar {
            display: flex;
            gap: 6px;
            align-items: center;
            padding: 6px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
        }
        #session-bar button {
            background: none;
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-editor-foreground);
            padding: 3px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            white-space: nowrap;
        }
        #session-bar button:hover {
            background: var(--vscode-button-hoverBackground);
            color: var(--vscode-button-foreground);
        }
        #session-select {
            flex: 1;
            background: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            padding: 3px 6px;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            min-width: 0;
        }
        #chat-container {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .message {
            max-width: 85%;
            padding: 10px 14px;
            border-radius: 8px;
            line-height: 1.5;
            font-size: 13px;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        .message.user {
            align-self: flex-end;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-bottom-right-radius: 2px;
        }
        .message.assistant {
            align-self: flex-start;
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-panel-border);
            border-bottom-left-radius: 2px;
        }
        .message.system {
            align-self: center;
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            color: var(--vscode-inputValidation-warningForeground);
            font-size: 12px;
            max-width: 90%;
            text-align: center;
        }
        .message .cmd-block {
            background: var(--vscode-terminal-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 12px;
            margin: 8px 0;
            font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
            font-size: 12px;
            overflow-x: auto;
            white-space: pre;
        }
        .message .cmd-block .cmd-label {
            display: block;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .message .cmd-block .cmd-text {
            color: var(--vscode-terminal-foreground);
        }
        .message .cmd-block .run-btn {
            display: inline-block;
            margin-top: 8px;
            padding: 4px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
        }
        .message .cmd-block .run-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .message .cmd-block .run-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        .message .cmd-output {
            background: var(--vscode-terminal-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px 12px;
            margin: 8px 0;
            font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
            font-size: 11px;
            white-space: pre-wrap;
            max-height: 200px;
            overflow-y: auto;
        }
        .message .cmd-output .output-label {
            display: block;
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .message .cmd-output.success {
            border-left: 3px solid var(--vscode-testing-iconPassed);
        }
        .message .cmd-output.error {
            border-left: 3px solid var(--vscode-testing-iconFailed);
        }
        .typing-indicator {
            align-self: flex-start;
            display: flex;
            gap: 4px;
            padding: 12px 16px;
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            border-bottom-left-radius: 2px;
        }
        .typing-indicator span {
            width: 8px;
            height: 8px;
            background: var(--vscode-editor-foreground);
            border-radius: 50%;
            animation: bounce 1.4s infinite ease-in-out;
        }
        .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
        .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes bounce {
            0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
            40% { transform: scale(1); opacity: 1; }
        }
        #input-container {
            padding: 12px 16px;
            border-top: 1px solid var(--vscode-panel-border);
            background: var(--vscode-editor-background);
            flex-shrink: 0;
        }
        #input-row {
            display: flex;
            gap: 8px;
            align-items: flex-end;
        }
        #message-input {
            flex: 1;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            padding: 8px 12px;
            font-family: inherit;
            font-size: 13px;
            resize: none;
            min-height: 36px;
            max-height: 120px;
            outline: none;
        }
        #message-input:focus {
            border-color: var(--vscode-focusBorder);
        }
        #send-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 6px;
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            min-height: 36px;
            display: flex;
            align-items: center;
            gap: 4px;
        }
        #send-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        #send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #stop-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 6px;
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            min-height: 36px;
        }
        #stop-btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        #stop-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .welcome-message {
            text-align: center;
            padding: 40px 20px;
            color: var(--vscode-descriptionForeground);
        }
        .welcome-message h2 {
            font-size: 20px;
            margin-bottom: 8px;
            color: var(--vscode-editor-foreground);
        }
        .welcome-message p {
            font-size: 13px;
            line-height: 1.6;
        }
        .welcome-message .features {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 16px;
            text-align: left;
            max-width: 400px;
            margin-left: auto;
            margin-right: auto;
        }
        .welcome-message .features .feature {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 12px;
        }
        .welcome-message .features .feature .check {
            color: var(--vscode-testing-iconPassed);
        }
        .error-message {
            color: var(--vscode-errorForeground);
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
        }
        .response-stats {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-top: 6px;
            padding-top: 4px;
            border-top: 1px solid var(--vscode-panel-border);
            opacity: 0.8;
        }
        .response-stats .model-name {
            font-weight: 600;
            color: var(--vscode-foreground);
            opacity: 1;
        }
        .response-stats .ctx-size {
            font-weight: 500;
            color: var(--vscode-charts-blue);
        }
        .approval-prompt {
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            border-radius: 6px;
            padding: 10px 14px;
            margin: 8px 0;
            max-width: 85%;
            align-self: flex-start;
        }
        .approval-prompt .approval-label {
            font-size: 12px;
            color: var(--vscode-inputValidation-warningForeground);
            margin-bottom: 8px;
        }
        .approval-prompt .approval-cmd {
            font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
            font-size: 12px;
            background: var(--vscode-terminal-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 6px 10px;
            margin-bottom: 8px;
            white-space: pre-wrap;
            word-break: break-all;
        }
        .approval-prompt .approval-buttons {
            display: flex;
            gap: 8px;
        }
        .approval-prompt .approval-buttons button {
            padding: 4px 14px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
        }
        .approval-prompt .approval-buttons .approve-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .approval-prompt .approval-buttons .approve-btn:hover {
            background: var(--vscode-button-hoverBackground);
        }
        .approval-prompt .approval-buttons .deny-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .approval-prompt .approval-buttons .deny-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .approval-prompt .approval-buttons button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
    </style>
</head>
<body>
    <div id="header">
        <h1><span class="icon">🤖</span> Local Copilot</h1>
        <div id="header-controls">
            <select id="provider-select">
                <option value="ollama">Ollama (Local)</option>
                <option value="lmstudio">LM Studio (Local)</option>
                <option value="janai">JAN AI (Local)</option>
                <option value="openai">OpenAI</option>
                <option value="copilot-web">GitHub Copilot</option>
            </select>
            <select id="model-select" style="display:none;">
                <option value="">Loading models...</option>
            </select>
            <select id="approval-select">
                <option value="safe">Auto: Safe Only</option>
                <option value="all">Auto: All</option>
                <option value="ask">Always Ask</option>
            </select>
            <button id="compress-btn" title="Compress chat history to reduce context usage">Compress</button>
            <button id="clear-btn">Clear</button>
        </div>
    </div>
    <div id="session-bar">
        <button id="new-session-btn">+ New</button>
        <button id="save-session-btn">&#128190; Save</button>
        <select id="session-select">
            <option value="">No sessions</option>
        </select>
        <button id="delete-session-btn">&#128465;</button>
    </div>
    <div id="chat-container">
        <div id="debug-status" style="text-align:center;padding:4px;font-size:10px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-panel-border);">Initializing script...</div>
        <div class="welcome-message">
            <h2>Welcome to Local Copilot</h2>
            <p>Your AI assistant with local command execution capabilities.</p>
            <div class="features">
                <div class="feature"><span class="check">&#10003;</span> Chat with AI models (Ollama, LM Studio, JAN AI, OpenAI, Copilot)</div>
                <div class="feature"><span class="check">&#10003;</span> Execute commands directly in VS Code terminal</div>
                <div class="feature"><span class="check">&#10003;</span> Read and analyze files in your workspace</div>
                <div class="feature"><span class="check">&#10003;</span> Install packages and run scripts</div>
            </div>
            <p style="margin-top: 16px; font-size: 12px;">Type a message below to get started!</p>
        </div>
    </div>
    <div id="input-container">
        <div id="input-row">
            <textarea id="message-input" placeholder="Ask me anything... (Shift+Enter for new line)" rows="1"></textarea>
            <button id="send-btn">Send</button>
            <button id="stop-btn">Stop</button>
        </div>
    </div>

    <script src="${scriptUri}"></script>
</body>
</html>`;
}