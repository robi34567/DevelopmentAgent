#!/usr/bin/env pwsh
# Launch Aider with Llama 3.1 model
$env:OPENAI_API_KEY = "dummy"
$env:OPENAI_API_BASE = "http://127.0.0.1:11434/v1"
aider --model openai/llama3.1:8b --openai-api-base http://127.0.0.1:11434/v1
