#!/usr/bin/env bash
set -euo pipefail

if ! command -v code &>/dev/null; then
    echo "VS Code not installed. Please run install_vscode.sh first."
    exit 1
fi

# Check if extension is already installed
if code --list-extensions | grep -q "aider.aider"; then
    echo "Aider extension already installed"
else
    code --install-extension aider.aider
fi
