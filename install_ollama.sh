#!/usr/bin/env bash
set -euo pipefail

if command -v ollama &>/dev/null; then
    echo "Ollama already installed"
else
    curl -fsSL https://ollama.com/install.sh | sh
fi
