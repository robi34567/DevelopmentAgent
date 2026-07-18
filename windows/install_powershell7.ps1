if (Get-Command pwsh -ErrorAction SilentlyContinue) {
    Write-Host "PowerShell 7 already installed"
} else {
    winget install Microsoft.PowerShell --accept-package-agreements --accept-source-agreements
}
