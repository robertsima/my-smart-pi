[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$failures = New-Object System.Collections.Generic.List[string]

function Write-Utf8([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Assert([bool]$Condition, [string]$Message) {
    if ($Condition) { Write-Host "PASS  $Message" -ForegroundColor Green }
    else { $failures.Add($Message); Write-Host "FAIL  $Message" -ForegroundColor Red }
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) ("my-smart-pi-test-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp -Force | Out-Null
try {
    $settings = [ordered]@{
        packages = @(
            'npm:@kylebrodeur/pi-model-discovery',
            'npm:@kylebrodeur/pi-model-router'
        )
        enabledModels = @('openai-codex/gpt-test', 'llama-local/qwen')
    }
    Write-Utf8 (Join-Path $temp 'settings.json') ($settings | ConvertTo-Json -Depth 20)

    $routing = [ordered]@{
        roles = [ordered]@{
            planner = [ordered]@{ model = 'openai-codex/gpt-test'; thinking = 'high' }
            verifier = [ordered]@{ model = 'openai-codex/gpt-test'; thinking = 'high' }
            implementer = [ordered]@{ model = 'llama-local/qwen'; thinking = 'medium' }
            reviewer = [ordered]@{ model = 'llama-local/qwen'; thinking = 'medium' }
        }
        local = [ordered]@{ provider = 'llama-local'; switchKey = 'qwen'; maxParallel = 1 }
        forbiddenModelPatterns = @('ollama/qwen')
    }
    Write-Utf8 (Join-Path $temp 'agent-routing.local.json') ($routing | ConvertTo-Json -Depth 20)
    $utf8Probe = "User prefix $([char]0x2014) preserve UTF-8."
    Write-Utf8 (Join-Path $temp 'APPEND_SYSTEM.md') "$utf8Probe`n"

    & (Join-Path $PSScriptRoot 'apply-harness-profile.ps1') -AgentDir $temp -SkipNpmInstall -SkipRuntimePatches

    $result = [System.IO.File]::ReadAllText((Join-Path $temp 'settings.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $discovery = @($result.packages) | Where-Object { $_.source -eq 'npm:@kylebrodeur/pi-model-discovery' } | Select-Object -First 1
    $router = @($result.packages) | Where-Object { $_.source -eq 'npm:@kylebrodeur/pi-model-router' } | Select-Object -First 1
    Assert ($null -ne $discovery -and @($discovery.extensions) -contains '!dist/index.js') 'model discovery extension excluded'
    Assert ($null -ne $router -and @($router.extensions) -contains '!extensions/index.ts') 'model router extension excluded'

    $profile = Get-Content -LiteralPath (Join-Path $RepoRoot 'config\harness-profile.json') -Raw | ConvertFrom-Json
    foreach ($role in @('planner', 'verifier', 'implementer', 'reviewer')) {
        $templateName = [string]$profile.agentTemplates.$role
        $agentPath = Join-Path $temp "agents\$templateName"
        Assert (Test-Path -LiteralPath $agentPath) "$role agent rendered"
        $agent = if (Test-Path -LiteralPath $agentPath) { [System.IO.File]::ReadAllText($agentPath) } else { '' }
        Assert ($agent -match [regex]::Escape([string]$routing.roles.$role.model)) "$role model binding rendered"
    }

    $append = [System.IO.File]::ReadAllText((Join-Path $temp 'APPEND_SYSTEM.md'), [System.Text.Encoding]::UTF8)
    Assert ($append.Contains($utf8Probe)) 'existing APPEND_SYSTEM UTF-8 preserved'
    Assert (-not $append.Contains([char]0xFFFD)) 'managed prompt has no replacement characters'
    Assert ($append.Contains('<!-- my-smart-pi:agent-routing:start -->')) 'managed routing prompt installed'

    $validRoutingText = $routing | ConvertTo-Json -Depth 20
    $badCases = @(
        @{ Name = 'local planner binding rejected'; Mutate = { param($value) $value.roles.planner.model = 'llama-local/qwen' } },
        @{ Name = 'unapproved planner provider rejected'; Mutate = { param($value) $value.roles.planner.model = 'ollama/qwen' } },
        @{ Name = 'API implementer binding rejected'; Mutate = { param($value) $value.roles.implementer.model = 'openai-codex/gpt-test' } },
        @{ Name = 'parallel local children rejected'; Mutate = { param($value) $value.local.maxParallel = 2 } }
    )
    foreach ($case in $badCases) {
        $badRouting = $validRoutingText | ConvertFrom-Json
        $mutator = $case.Mutate
        & $mutator $badRouting
        Write-Utf8 (Join-Path $temp 'agent-routing.local.json') ($badRouting | ConvertTo-Json -Depth 20)
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply-harness-profile.ps1') -AgentDir $temp -SkipNpmInstall -SkipRuntimePatches *> $null
        $applyExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousErrorAction
        Assert ($applyExitCode -ne 0) $case.Name
    }
    Write-Utf8 (Join-Path $temp 'agent-routing.local.json') $validRoutingText

    Assert ($profile.schemaVersion -ge 1) 'harness profile JSON valid'
    Assert (Test-Path -LiteralPath (Join-Path $RepoRoot 'docs\AGENT_ROUTING.md')) 'routing documentation present'
} catch {
    $failures.Add($_.Exception.Message)
    Write-Host "FAIL  $($_.Exception.Message)" -ForegroundColor Red
} finally {
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count -gt 0) {
    Write-Host "`n$($failures.Count) test(s) failed." -ForegroundColor Red
    exit 1
}
Write-Host "`nHarness profile tests passed." -ForegroundColor Green
