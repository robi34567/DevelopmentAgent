if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host "Git already installed"
} else {
    winget install Git.Git --accept-package-agreements --accept-source-agreements
}
