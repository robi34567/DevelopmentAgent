if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "Node.js already installed"
} else {
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
}
