$body = '{"model":"qwen2.5-coder:14b","messages":[{"role":"user","content":"What is 2+2?"}],"tools":[{"type":"function","function":{"name":"calculate","description":"Calculate math","parameters":{"type":"object","properties":{"expr":{"type":"string"}},"required":["expr"]}}}],"stream":false}'

try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:11434/v1/chat/completions" -Method Post -Body $body -ContentType "application/json"
    $msg = $r.choices[0].message
    if ($msg.tool_calls) {
        Write-Host "TOOL_CALLS_PRESENT: YES"
        $msg.tool_calls | ConvertTo-Json -Depth 5
    } else {
        Write-Host "TOOL_CALLS_PRESENT: NO"
        Write-Host "CONTENT: $($msg.content)"
        Write-Host "FINISH_REASON: $($r.choices[0].finish_reason)"
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)"
}
