if (Get-Command docker -ErrorAction SilentlyContinue) {
    Write-Host "Docker already installed"
} else {
    winget install Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
}
