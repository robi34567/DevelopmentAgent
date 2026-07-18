if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Ollama not installed. Please run install_ollama.ps1 first."
    exit 1
}
$models = @("deepseek-coder:6.7b", "llama3:8b", "qwen2:7b")
foreach ($model in $models) {
    $list = ollama list 2>$null
    if ($list -match $model) {
        Write-Host "Model $model already pulled"
    } else {
        ollama pull $model
    }
}
