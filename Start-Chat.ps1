param(
    [string]$Model = "google/gemma-4-e4b",
    [string]$LmStudioUrl = "http://localhost:1234",
    [int]$MaxTokens = 4096,
    [string]$Message = "",
    [string]$Title = ""
)

function New-StepId { "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds())-0.$([System.Guid]::NewGuid().ToString('N').Substring(0,16))" }

function New-UserMsg($text) {
    @{
        versions = @(
            @{
                type    = "singleStep"
                role    = "user"
                content = @(@{ type = "text"; text = $text })
            }
        )
        currentlySelected = 0
    }
}

function New-AssistantMsg($text, $model) {
    @{
        versions = @(
            @{
                type       = "singleStep"
                role       = "assistant"
                senderInfo = @{ senderName = $model }
                steps      = @(
                    @{
                        type = "contentBlock"
                        stepIdentifier = (New-StepId)
                        content = @(
                            @{
                                type           = "text"
                                text           = $text
                                fromDraftModel = $false
                                tokensCount    = 0
                                isStructural   = $false
                            }
                        )
                        defaultShouldIncludeInContext = $true
                        shouldIncludeInContext = $true
                        prefix = ""
                        suffix = ""
                    }
                )
            }
        )
        currentlySelected = 0
    }
}

$convDir = "$env:USERPROFILE\.lmstudio\conversations"
if (-not (Test-Path $convDir)) { New-Item -ItemType Directory -Path $convDir -Force | Out-Null }

$timestamp = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$msgs = @()
$apiMessages = @()

if ([string]::IsNullOrWhiteSpace($Message)) {
    $Message = Read-Host "You"
    Write-Output ""
}
if ([string]::IsNullOrWhiteSpace($Message)) { Write-Output "No input. Exiting."; return }

if ([string]::IsNullOrWhiteSpace($Title)) {
    $Title = Read-Host "Chat title (enter to auto-generate)"
    Write-Output ""
}
if ([string]::IsNullOrWhiteSpace($Title)) {
    $Title = if ($Message.Length -gt 80) { $Message.Substring(0, 77) + "..." } else { $Message }
}

$conv = @{
    name            = $Title
    pinned          = $false
    createdAt       = $timestamp
    preset          = ""
    tokenCount      = 0
    systemPrompt    = ""
    messages        = $msgs
    usePerChatPredictionConfig       = $true
    perChatPredictionConfig          = @{ fields = @() }
    clientInput                      = ""
    clientInputFiles                 = @()
    userFilesSizeBytes               = 0
    lastUsedModel                    = @{
        identifier                 = $Model
        indexedModelIdentifier     = $Model
        instanceLoadTimeConfig     = @{ fields = @() }
        instanceOperationTimeConfig = @{ fields = @() }
    }
    notes       = @()
    plugins     = @()
    pluginConfigs = @{}
    disabledPluginTools = @()
    looseFiles  = @()
}

$filename = "$timestamp.conversation.json"
$filePath = Join-Path $convDir $filename

$interactive = -not $PSBoundParameters.ContainsKey("Message")

$first = $true

while ($Message -ne $null) {
    if (-not $interactive -and -not $first) { break }
    if ($first) {
        $first = $false
    } else {
        Write-Output "---"
        $Message = Read-Host "You"
        Write-Output ""
        if ([string]::IsNullOrWhiteSpace($Message)) { break }
        if ($Message -in @("exit","quit","/exit","/quit")) { break }
    }

    Write-Output "[model thinking...]"
    $apiMessages += @{ role = "user"; content = $Message }

    $body = @{
        model      = $Model
        messages   = $apiMessages
        max_tokens = $MaxTokens
        stream     = $false
    } | ConvertTo-Json

    try {
        $resp = Invoke-RestMethod -Uri "$LmStudioUrl/v1/chat/completions" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 300
        $reply = $resp.choices[0].message.content
    } catch {
        Write-Error "API call failed: $_"
        break
    }

    $apiMessages += @{ role = "assistant"; content = $reply }

    Write-Output ""
    Write-Output "Model:"
    Write-Output $reply
    Write-Output ""

    $msgs += New-UserMsg $Message
    $msgs += New-AssistantMsg $reply $Model
    $conv.messages = $msgs
    $conv.tokenCount = ($apiMessages | ForEach-Object { $_.content.Length } | Measure-Object -Sum).Sum
    $conv.userLastMessagedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $conv.assistantLastMessagedAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

    $conv | ConvertTo-Json -Depth 10 | Set-Content -Path $filePath -Encoding UTF8
}

Write-Output "Chat saved to: $filename"
Write-Output "Title: $Title"
