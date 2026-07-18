#!/usr/bin/env bash
set -euo pipefail

if command -v git &>/dev/null; then
    echo "Git already installed"
else
    sudo apt-get update
    sudo apt-get install -y git
fi
