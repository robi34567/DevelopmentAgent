#!/usr/bin/env bash
set -euo pipefail

# Aider is a Python package, install via pip
if python3 -c "import aider" 2>/dev/null; then
    echo "Aider already installed"
else
    pip3 install --upgrade pip
    pip3 install aider-chat
fi
