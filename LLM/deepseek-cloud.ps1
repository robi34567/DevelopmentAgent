#!/usr/bin/env pwsh
# Launch Aider with OpenRouter Deepseek Free Tier
$env:OPENAI_API_KEY = "sk-or-v1-placeholder-replace-with-your-key"
aider --model openai/deepseek/deepseek-chat --openai-api-base https://openrouter.ai/api/v1 --no-show-model-warnings
