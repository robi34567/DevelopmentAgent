if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host "Ollama already installed"
} else {
    # Download and run installer
    $installer = "$env:TEMP\ollama_setup.exe"
    Invoke-WebRequest -Uri https://ollama.com/download/OllamaSetup.exe -OutFile $installer
    Start-Process -FilePath $installer -Wait -NoNewWindow
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
