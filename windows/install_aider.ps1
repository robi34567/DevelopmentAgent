# Ensure Python is installed and pip is available
if (python -c "import aider" 2>$null) {
    Write-Host "Aider already installed"
} else {
    python -m pip install --upgrade pip
    python -m pip install aider-chat
}
