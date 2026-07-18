if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
    Write-Host "VS Code not installed. Please run install_vscode.ps1 first."
    exit 1
}
$extensions = code --list-extensions
if ($extensions -match "aider.aider") {
    Write-Host "Aider extension already installed"
} else {
    code --install-extension aider.aider
}
