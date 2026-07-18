#!/usr/bin/env pwsh
# Launch Aider with Qwen2.5-Coder model
$env:OPENAI_API_KEY = "dummy"
$env:OPENAI_API_BASE = "http://127.0.0.1:11434/v1"
aider --model openai/qwen2.5-coder:14b --openai-api-base http://127.0.0.1:11434/v1
