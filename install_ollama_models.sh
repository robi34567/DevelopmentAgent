#!/usr/bin/env bash
set -euo pipefail

# Ensure Ollama is installed
if ! command -v ollama &>/dev/null; then
    echo "Ollama not installed. Please run install_ollama.sh first."
    exit 1
fi

# Pull models (adjust names as needed)
models=("deepseek-coder:6.7b" "llama3:8b" "qwen2:7b")

for model in "${models[@]}"; do
    if ollama list | grep -q "$model"; then
        echo "Model $model already pulled"
    else
        ollama pull "$model"
    fi
done
