import type * as vs from 'vscode';

// The 'vscode' module only exists inside a VS Code extension host, so it is required lazily
// inside getWebviewContent. Loading this module (and getWebUiPageHtml) works in plain Node,
// which the Maggot webUI server relies on.
export function getWebviewContent(extensionUri: vs.Uri, webview: vs.Webview): string {
    const vscode = require('vscode') as typeof import('vscode');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'main.js')).toString();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};`;
    return pageHtml(csp, scriptUri, '', '');
}

// Maggot webUI: same UI, served by the standalone Node server. The browser page loads the
// transport shim before main.js (it provides acquireVsCodeApi over a WebSocket) and gets a
// fallback --vscode-* theme so the panel looks the same as in VS Code.
export function getWebUiPageHtml(): string {
    const csp = `default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src ws: wss: http:;`;
    const theme = `
        <style id="webui-theme">
            :root {
                --vscode-editor-background: #1e1e1e;
                --vscode-editor-foreground: #d4d4d4;
                --vscode-titleBar-activeBackground: #323233;
                --vscode-sideBar-background: #252526;
                --vscode-panel-border: #454545;
                --vscode-dropdown-background: #3c3c3c;
                --vscode-dropdown-foreground: #cccccc;
                --vscode-dropdown-border: #3c3c3c;
                --vscode-input-background: #3c3c3c;
                --vscode-input-foreground: #cccccc;
                --vscode-input-border: #3c3c3c;
                --vscode-button-background: #0e639c;
                --vscode-button-foreground: #ffffff;
                --vscode-button-hoverBackground: #1177bb;
                --vscode-button-secondaryBackground: #3a3d41;
                --vscode-button-secondaryForeground: #ffffff;
                --vscode-button-secondaryHoverBackground: #45494e;
                --vscode-foreground: #cccccc;
                --vscode-descriptionForeground: #9d9d9d;
                --vscode-textLink-foreground: #3794ff;
                --vscode-textBlockQuote-background: #2a2a2a;
                --vscode-list-hoverBackground: #2a2d2e;
                --vscode-focusBorder: #007fd4;
                --vscode-errorForeground: #f48771;
                --vscode-terminal-background: #1e1e1e;
                --vscode-terminal-foreground: #cccccc;
                --vscode-charts-blue: #3794ff;
                --vscode-testing-iconPassed: #73c991;
                --vscode-testing-iconFailed: #f48771;
                --vscode-inputValidation-errorBackground: #5a1d1d;
                --vscode-inputValidation-errorBorder: #be1100;
                --vscode-inputValidation-warningBackground: #352a05;
                --vscode-inputValidation-warningBorder: #b89500;
                --vscode-inputValidation-warningForeground: #ffcc00;
            }
        </style>`;
    return pageHtml(csp, '/static/main.js', '<script src="/static/shim.js"></script>\n    ', theme);
}

function pageHtml(csp: string, scriptSrc: string, preScripts: string, extraHead: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Maggot chat</title>
    ${extraHead}
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
        .thinking-block {
            background: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 6px 10px;
            margin-bottom: 10px;
            font-size: 12px;
        }
        .thinking-block summary {
            cursor: pointer;
            font-size: 11px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            user-select: none;
            padding: 2px 0;
        }
        .thinking-block summary:hover {
            color: var(--vscode-editor-foreground);
        }
        .thinking-block .thinking-content {
            margin-top: 6px;
            padding: 8px;
            background: var(--vscode-terminal-background);
            border-radius: 4px;
            font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
            font-size: 11px;
            line-height: 1.5;
            white-space: pre-wrap;
            max-height: 300px;
            overflow-y: auto;
            color: var(--vscode-terminal-foreground);
            opacity: 0.85;
        }
        #thinking-toggle {
            background: none;
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-editor-foreground);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            white-space: nowrap;
        }
        #thinking-toggle:hover {
            background: var(--vscode-button-hoverBackground);
            color: var(--vscode-button-foreground);
        }
        #thinking-toggle.active {
            border-color: var(--vscode-focusBorder);
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .chat-image {
            max-width: 100%;
            max-height: 400px;
            border-radius: 6px;
            margin: 6px 0;
            cursor: pointer;
            border: 1px solid var(--vscode-panel-border);
        }
        .chat-image:hover {
            opacity: 0.9;
        }
        #image-preview-container {
            display: none;
            flex-wrap: wrap;
            gap: 6px;
            padding: 6px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 6px;
        }
        .image-preview-wrapper {
            position: relative;
            display: inline-block;
        }
        .image-preview-thumb {
            width: 60px;
            height: 60px;
            object-fit: cover;
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }
        .image-preview-remove {
            position: absolute;
            top: -6px;
            right: -6px;
            width: 18px;
            height: 18px;
            border-radius: 50%;
            border: none;
            background: var(--vscode-errorForeground);
            color: white;
            font-size: 12px;
            line-height: 1;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
        }
        .image-preview-remove:hover {
            background: var(--vscode-inputValidation-errorBorder);
        }
        #config-btn {
            background: none;
            border: 1px solid var(--vscode-panel-border);
            color: var(--vscode-editor-foreground);
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            line-height: 1;
        }
        #config-btn:hover {
            background: var(--vscode-button-hoverBackground);
            color: var(--vscode-button-foreground);
        }
        #config-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 100;
            align-items: flex-start;
            justify-content: center;
            overflow-y: auto;
            padding: 40px 16px;
        }
        #config-overlay.open { display: flex; }
        #config-modal {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            width: 100%;
            max-width: 620px;
            padding: 16px 20px;
            box-shadow: 0 8px 30px rgba(0,0,0,0.4);
            max-height: 85vh;
            overflow-y: auto;
        }
        #config-modal h2 {
            font-size: 16px;
            font-weight: 600;
            margin: 0 0 4px 0;
        }
        #config-modal .config-path {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin: 0 0 14px 0;
            word-break: break-all;
        }
        #config-modal .config-section {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-descriptionForeground);
            margin: 14px 0 8px 0;
            border-top: 1px solid var(--vscode-panel-border);
            padding-top: 10px;
        }
        #config-modal label {
            display: block;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin: 8px 0 3px 0;
        }
        #config-modal input[type="text"],
        #config-modal input[type="password"],
        #config-modal select,
        #config-modal textarea {
            width: 100%;
            padding: 5px 8px;
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-size: 12px;
            font-family: inherit;
            box-sizing: border-box;
        }
        #config-modal textarea {
            min-height: 90px;
            resize: vertical;
            line-height: 1.4;
        }
        #config-modal .config-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            margin-top: 16px;
        }
        #config-modal .config-actions button {
            padding: 6px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
        }
        #config-modal .config-actions .save-btn {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        #config-modal .config-actions .save-btn:hover { background: var(--vscode-button-hoverBackground); }
        #config-modal .config-actions .cancel-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        #config-modal .config-actions .cancel-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
        #config-modal .config-status {
            font-size: 11px;
            margin-top: 8px;
            color: var(--vscode-testing-iconPassed);
            min-height: 14px;
        }
        #config-providers {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        #config-add-provider {
            margin-top: 10px;
            padding: 6px 12px;
            border: 1px dashed var(--vscode-panel-border);
            border-radius: 4px;
            background: none;
            color: var(--vscode-editor-foreground);
            cursor: pointer;
            font-size: 12px;
            width: 100%;
        }
        #config-add-provider:hover {
            background: var(--vscode-button-hoverBackground);
            color: var(--vscode-button-foreground);
        }
        .provider-block {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 8px 12px;
            background: var(--vscode-sideBar-background);
        }
        .provider-block-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 6px;
        }
        .provider-name {
            font-size: 12px;
            font-weight: 600;
        }
        .provider-delete {
            background: none;
            border: none;
            color: var(--vscode-errorForeground);
            cursor: pointer;
            font-size: 13px;
            padding: 2px 6px;
            border-radius: 4px;
        }
        .provider-delete:hover { background: var(--vscode-inputValidation-errorBackground); }
        .provider-delete:disabled { opacity: 0.35; cursor: not-allowed; }
        .provider-block .pf-row {
            display: flex;
            gap: 8px;
        }
        .provider-block .pf-row > div { flex: 1; }
        .provider-block .hidden { display: none; }
        .provider-block-hint {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
        }
        .ll {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            vertical-align: baseline;
            text-decoration: none;
            color: var(--vscode-textLink-foreground);
            cursor: pointer;
            border-radius: 4px;
            padding: 1px 3px;
            margin: 1px 0;
            max-width: 100%;
            line-height: 1.35;
        }
        .ll .ll-text {
            word-break: break-all;
        }
        .ll:hover {
            background: var(--vscode-list-hoverBackground);
            text-decoration: underline;
        }
        .ll .ll-badge {
            flex-shrink: 0;
            font-size: 9px;
            line-height: 1;
            border: 1px solid var(--vscode-textLink-foreground);
            border-radius: 3px;
            padding: 1px 4px;
            text-transform: uppercase;
            letter-spacing: 0.4px;
            opacity: 0.85;
        }
    </style>
</head>
<body>
    <div id="header">
        <h1><span class="icon">🤖</span> Maggot chat</h1>
        <div id="header-controls">
            <select id="provider-select">
                <option value="">Loading...</option>
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
            <button id="benchmark-btn" title="Run a predefined benchmark task against the current model">Benchmark</button>
            <input id="batch-tries" type="number" min="1" max="20" value="2" style="width:48px;padding:3px 4px;border-radius:4px;border:1px solid var(--vscode-panel-border);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font-size:11px;text-align:center;" title="Number of tries per model">
            <button id="batch-benchmark-btn" title="Run benchmark against all discovered models">Batch</button>
            <button id="thinking-toggle" class="active" title="Toggle model thinking/reasoning display">🧠 Thinking ON</button>
            <button id="clear-btn">Clear</button>
            <button id="config-btn" title="Provider and settings">&#9881;</button>
        </div>
    </div>
    <div id="config-overlay">
        <div id="config-modal">
            <h2>Settings</h2>
            <p class="config-path">Config file: <span id="config-path"></span></p>
            <div class="config-section">General</div>
            <label for="config-active-provider">Active Provider</label>
            <select id="config-active-provider">
                <option value="">Loading...</option>
            </select>
            <label for="config-approval">Approval Mode</label>
            <select id="config-approval">
                <option value="safe">Auto: Safe Only</option>
                <option value="all">Auto: All</option>
                <option value="ask">Always Ask</option>
            </select>
            <label for="config-system-prompt">System Prompt</label>
            <textarea id="config-system-prompt" placeholder="Leave empty to use the default prompt"></textarea>
            <div class="config-section">Providers</div>
            <div id="config-providers"></div>
            <button id="config-add-provider" type="button" title="Add a new provider">+ Add provider</button>
            <div class="config-actions">
                <button class="save-btn" id="config-save-btn">Save</button>
                <button class="cancel-btn" id="config-cancel-btn">Cancel</button>
            </div>
            <div class="config-status" id="config-status"></div>
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
            <h2>Welcome to Maggot chat</h2>
            <p>Your AI assistant with local command execution capabilities.</p>
            <div class="features">
                <div class="feature"><span class="check">&#10003;</span> Chat with AI models (Ollama, LM Studio, JAN AI, OpenAI, Copilot, VS Code LM)</div>
                <div class="feature"><span class="check">&#10003;</span> Execute commands directly in VS Code terminal</div>
                <div class="feature"><span class="check">&#10003;</span> Read and analyze files in your workspace</div>
                <div class="feature"><span class="check">&#10003;</span> Install packages and run scripts</div>
            </div>
            <p style="margin-top: 16px; font-size: 12px;">Type a message below to get started!</p>
        </div>
    </div>
    <div id="input-container">
        <div id="image-preview-container"></div>
        <div id="input-row">
            <textarea id="message-input" placeholder="Ask me anything... (Shift+Enter for new line)" rows="1"></textarea>
            <button id="send-btn">Send</button>
            <button id="stop-btn">Stop</button>
        </div>
    </div>

    ${preScripts}<script src="${scriptSrc}"></script>
</body>
</html>`;
}