#!/usr/bin/env pwsh
# Launch Aider with Deepseek-R1 model
$env:OPENAI_API_KEY = "dummy"
$env:OPENAI_API_BASE = "http://127.0.0.1:11434/v1"
aider --model openai/deepseek-r1:14b --openai-api-base http://127.0.0.1:11434/v1
