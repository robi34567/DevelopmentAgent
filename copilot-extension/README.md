# Maggot chat - VS Code Extension

A Copilot-like chat interface with local command execution capabilities. Access AI models locally via Ollama or remotely via OpenAI/GitHub Copilot APIs.

## Features

- **🤖 Multi-Provider AI Chat**: Supports Ollama (local), OpenAI, and GitHub Copilot
- **⚡ Local Command Execution**: AI can suggest commands that you can run directly in VS Code terminal
- **📂 File Operations**: Read, analyze, and manipulate files in your workspace
- **🔄 Streaming Responses**: See AI responses as they're being generated
- **🎨 VS Code Native UI**: Matches VS Code theme and feels like a native part of the editor

## Quick Start

1. Install the extension
2. Press `Ctrl+Shift+P` → `Maggot chat: Open Chat`
3. Start chatting!

## Configuration

Open VS Code settings (`Ctrl+,`) and search for `local-copilot`:

### AI Provider Options

| Provider | Setting | Description |
|----------|---------|-------------|
| **Ollama** (Default) | `local-copilot.ollamaEndpoint` | Local Ollama API (default: http://localhost:11434) |
| | `local-copilot.ollamaModel` | Model name (default: qwen2.5-coder) |
| **OpenAI** | `local-copilot.openaiApiKey` | Your OpenAI API key |
| | `local-copilot.openaiModel` | Model (default: gpt-4o) |
| **GitHub Copilot** | Requires GitHub Copilot extension installed and signed in |

### System Prompt

Customize the AI's behavior via `local-copilot.systemPrompt`.

## Command Execution

The AI can suggest commands using `[CMD]command[/CMD]` markers. You can:
- Click "Run in Terminal" to execute suggested commands
- Commands run in VS Code's integrated terminal
- The AI will ask for confirmation before executing commands

## Commands

- `Maggot chat: Open Chat` - Opens the chat panel
- `Maggot chat: Run Selected Command in Terminal` - Runs selected text as a command

## Requirements

- VS Code 1.85.0 or higher
- For Ollama: [Ollama](https://ollama.ai) installed and running
- For OpenAI: Valid OpenAI API key
- For GitHub Copilot: GitHub Copilot extension installed and signed in