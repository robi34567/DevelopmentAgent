if (Get-Command code -ErrorAction SilentlyContinue) {
    Write-Host "VS Code already installed"
} else {
    winget install Microsoft.VisualStudioCode --accept-package-agreements --accept-source-agreements
}
