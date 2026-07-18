# Install Python 3 via winget
if (Get-Command python -ErrorAction SilentlyContinue) {
    Write-Host "Python already installed"
} else {
    winget install Python.Python.3.12 --accept-package-agreements --accept-source-agreements
}
