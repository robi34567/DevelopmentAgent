#!/usr/bin/env pwsh
# Launch Aider with local Ollama Deepseek R1 (Reasoning Model)
$env:OPENAI_API_KEY = "dummy"
$env:OPENAI_API_BASE = "http://127.0.0.1:11434/v1"
aider --model openai/deepseek/deepseek-r1 --openai-api-base http://127.0.0.1:11434/v1 --no-show-model-warnings
