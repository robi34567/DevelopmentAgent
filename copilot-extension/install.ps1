# Maggot chat VS Code Extension - Installation Script
# This script installs the extension by copying it to the VS Code extensions directory

$ErrorActionPreference = "Stop"

$extensionName = "local-dev.local-copilot"
$extensionDir = "$env:USERPROFILE\.vscode\extensions\$extensionName"

Write-Host "Installing Maggot chat extension..." -ForegroundColor Green

# Remove old version if exists
if (Test-Path $extensionDir) {
    Write-Host "Removing old version..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $extensionDir
}

# Create extension directory
New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null

# Copy compiled output (copy the whole out dir to preserve subfolders like core/)
Write-Host "Copying extension files..." -ForegroundColor Cyan
Copy-Item -Path ".\out" -Destination "$extensionDir\" -Recurse -Force
Copy-Item -Path ".\package.json" -Destination "$extensionDir\" -Force
Copy-Item -Path ".\README.md" -Destination "$extensionDir\" -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "✓ Extension installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "To use Maggot chat:" -ForegroundColor Yellow
Write-Host "  1. Press Ctrl+Shift+P to open the command palette"
Write-Host "  2. Type 'Maggot chat: Open Chat' and press Enter"
Write-Host "  3. Or click the 'Maggot chat' button in the status bar"
Write-Host ""
Write-Host "You can also right-click on selected text and choose 'Maggot chat: Run Selected Command in Terminal'" -ForegroundColor Gray
Write-Host ""
Write-Host "Configuration:" -ForegroundColor Yellow
Write-Host "  - Open VS Code settings (Ctrl+,)"
Write-Host "  - Search for 'local-copilot'"
Write-Host "  - Configure your AI provider (Ollama, OpenAI, or GitHub Copilot)"
Write-Host ""
Write-Host "Note: You may need to reload VS Code window for the extension to activate." -ForegroundColor Gray