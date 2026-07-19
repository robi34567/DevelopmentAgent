# Local Copilot VS Code Extension - Installation Script
# This script installs the extension by copying it to the VS Code extensions directory

$ErrorActionPreference = "Stop"

$extensionName = "local-dev.local-copilot"
$extensionDir = "$env:USERPROFILE\.vscode\extensions\$extensionName"

Write-Host "Installing Local Copilot extension..." -ForegroundColor Green

# Remove old version if exists
if (Test-Path $extensionDir) {
    Write-Host "Removing old version..." -ForegroundColor Yellow
    Remove-Item -Recurse -Force $extensionDir
}

# Create extension directory
New-Item -ItemType Directory -Path $extensionDir -Force | Out-Null

# Copy compiled output
Write-Host "Copying extension files..." -ForegroundColor Cyan
Copy-Item -Path ".\out\*" -Destination "$extensionDir\out\" -Recurse -Force
Copy-Item -Path ".\package.json" -Destination "$extensionDir\" -Force
Copy-Item -Path ".\README.md" -Destination "$extensionDir\" -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "✓ Extension installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "To use Local Copilot:" -ForegroundColor Yellow
Write-Host "  1. Press Ctrl+Shift+P to open the command palette"
Write-Host "  2. Type 'Local Copilot: Open Chat' and press Enter"
Write-Host "  3. Or click the 'Local Copilot' button in the status bar"
Write-Host ""
Write-Host "You can also right-click on selected text and choose 'Local Copilot: Run Selected Command in Terminal'" -ForegroundColor Gray
Write-Host ""
Write-Host "Configuration:" -ForegroundColor Yellow
Write-Host "  - Open VS Code settings (Ctrl+,)"
Write-Host "  - Search for 'local-copilot'"
Write-Host "  - Configure your AI provider (Ollama, OpenAI, or GitHub Copilot)"
Write-Host ""
Write-Host "Note: You may need to reload VS Code window for the extension to activate." -ForegroundColor Gray