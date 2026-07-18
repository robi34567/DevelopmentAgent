#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Starting master installation..."

# Order based on dependencies
echo "Step 1: Python"
bash "$SCRIPT_DIR/install_python.sh"

echo "Step 2: Git"
bash "$SCRIPT_DIR/install_git.sh"

echo "Step 3: Aider"
bash "$SCRIPT_DIR/install_aider.sh"

echo "Step 4: Ollama"
bash "$SCRIPT_DIR/install_ollama.sh"

echo "Step 5: Ollama models"
bash "$SCRIPT_DIR/install_ollama_models.sh"

echo "Step 6: VS Code"
bash "$SCRIPT_DIR/install_vscode.sh"

echo "Step 7: VS Code Aider extension"
bash "$SCRIPT_DIR/install_vscode_aider_extension.sh"

echo "All installations completed successfully."
