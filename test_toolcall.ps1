$body = @{
    model = "qwen2.5-coder:14b"
    messages = @(@{role = "user"; content = "What is 2+2?"})
    tools = @(@{type = "function"; function = @{name = "calculate"; description = "Calculate math"; parameters = @{type = "object"; properties = @{expr = @{type = "string"}}}}})
} | ConvertTo-Json -Depth 5

Write-Host "Request body:"
Write-Host $body

try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:11434/v1/chat/completions" -Method Post -Body $body -ContentType "application/json"
    Write-Host "`nResponse:"
    $r | ConvertTo-Json -Depth 5
} catch {
    Write-Host "Error: $($_.Exception.Message)"
}