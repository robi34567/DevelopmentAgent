#!/usr/bin/env bash
set -euo pipefail

# Install Python 3 and pip
if command -v python3 &>/dev/null; then
    echo "Python3 already installed"
else
    sudo apt-get update
    sudo apt-get install -y python3 python3-pip python3-venv
fi
