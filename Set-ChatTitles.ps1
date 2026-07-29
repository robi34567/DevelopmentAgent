param(
    [switch]$UseOllama,
    [string]$OllamaModel = "qwen2.5-coder:3b",
    [string]$OllamaUrl = "http://localhost:11434",
    [int]$MaxTitleLength = 80
)

$convDir = "$env:USERPROFILE\.lmstudio\conversations"
$files = Get-ChildItem -Path $convDir -Filter "*.conversation.json"
$updated = 0

foreach ($file in $files) {
    $data = Get-Content -Path $file.FullName -Raw | ConvertFrom-Json
    if ($data.name) { continue }

    $firstMsg = $data.messages | Where-Object { $_.versions[0].role -eq "user" } | Select-Object -First 1
    if (-not $firstMsg) { continue }

    $text = $firstMsg.versions[0].content | Where-Object { $_.type -eq "text" } | Select-Object -First 1 -ExpandProperty text
    if (-not $text) { continue }

    if ($UseOllama) {
        try {
            $body = @{
                model   = $OllamaModel
                prompt  = "Generate a short, concise title (max 8 words) for a conversation starting with: $text`n`nReply with ONLY the title."
                stream  = $false
                options = @{ num_predict = 30 }
            } | ConvertTo-Json
            $resp = Invoke-RestMethod -Uri "$OllamaUrl/api/generate" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120
            $title = $resp.response -replace '["\n\r]', '' -replace '\.$', '' -replace '^"|"$', ''
            if ([string]::IsNullOrWhiteSpace($title)) { $title = $text }
        } catch {
            Write-Warning "Ollama failed, using first message: $_"
            $title = $text
        }
    } else {
        $title = $text
    }

    if ($title.Length -gt $MaxTitleLength) { $title = $title.Substring(0, $MaxTitleLength - 3) + "..." }

    $data.name = $title
    $data | ConvertTo-Json -Depth 10 | Set-Content -Path $file.FullName -Encoding UTF8
    Write-Output "  '$title' <- $($file.Name)"
    $updated++
}

Write-Output "Done. $updated conversations titled."
