[CmdletBinding()]
param([string]$AgentDir = (Join-Path $HOME ".pi\agent"))

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
function Read-Utf8([string]$Path) { return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) }
$profile = Read-Utf8 (Join-Path $RepoRoot "config\harness-profile.json") | ConvertFrom-Json
$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
function Fail([string]$message) { $failures.Add($message) }
function Pass([string]$message) { Write-Host "PASS $message" -ForegroundColor Green }
function Source-Of($entry) { if ($entry -is [string]) { return [string]$entry }; return [string]$entry.source }
function Package-Identity([string]$source) {
    if ($source -notmatch '^npm:') { return $source }
    if ($source -match '^(npm:@[^/]+/[^@]+)@') { return $Matches[1] }
    if ($source -match '^(npm:[^@]+)@') { return $Matches[1] }
    return $source
}

try { Pass "Pi $(& pi --version)" } catch { Fail "pi unavailable: $($_.Exception.Message)" }
try { Pass "Node $(& node --version)" } catch { Fail "node unavailable: $($_.Exception.Message)" }

$settingsPath = Join-Path $AgentDir "settings.json"
$routingPath = Join-Path $AgentDir "agent-routing.local.json"
$subagentsPath = Join-Path $AgentDir "subagents.json"
foreach ($path in @($settingsPath, $routingPath, $subagentsPath, (Join-Path $AgentDir "model-switcher.json"), (Join-Path $AgentDir "APPEND_SYSTEM.md"))) {
    if (Test-Path -LiteralPath $path) { Pass $path } else { Fail "Missing $path" }
}

if ((Test-Path $settingsPath) -and (Test-Path $routingPath)) {
    $settings = Read-Utf8 $settingsPath | ConvertFrom-Json
    $routing = Read-Utf8 $routingPath | ConvertFrom-Json
    $localProvider = [string]$profile.routingPolicy.localProvider
    $apiProviders = @($profile.routingPolicy.apiProviders | ForEach-Object { [string]$_ })
    $apiRoles = @($profile.routingPolicy.apiRoles | ForEach-Object { [string]$_ })
    $localRoles = @($profile.routingPolicy.localRoles | ForEach-Object { [string]$_ })
    if ([string]::IsNullOrWhiteSpace($localProvider)) { Fail "Profile routingPolicy.localProvider is missing" }
    if ($apiProviders.Count -eq 0) { Fail "Profile routingPolicy.apiProviders is empty" }
    if ([string]::IsNullOrWhiteSpace([string]$routing.local.switchKey)) { Fail "Routing local.switchKey is missing" }
    if ([int]$routing.local.maxParallel -ne [int]$profile.routingPolicy.maxLocalParallel) { Fail "Routing local.maxParallel must be $($profile.routingPolicy.maxLocalParallel)" }
    $enabled = @($settings.enabledModels | ForEach-Object { [string]$_ })
    foreach ($property in $routing.roles.PSObject.Properties) {
        $role = $property.Name
        $model = [string]$property.Value.model
        if ([string]::IsNullOrWhiteSpace($model)) { Fail "Role '$role' has no model"; continue }
        $provider = $model.Split('/', 2)[0]
        $usesLocalProvider = $provider.Equals($localProvider, [System.StringComparison]::OrdinalIgnoreCase)
        if ($role -in $apiRoles -and $apiProviders -notcontains $provider) { Fail "Role '$role' must use an allowed API provider: $($apiProviders -join ', ')" }
        if ($role -in $localRoles -and -not $usesLocalProvider) { Fail "Role '$role' must use local provider '$localProvider'" }
        if ($enabled.Count -gt 0 -and $enabled -notcontains $model) { Fail "Role '$role' model not present in current enabledModels: $model" }
        foreach ($pattern in @($routing.forbiddenModelPatterns)) {
            if ($model -like [string]$pattern) { Fail "Role '$role' matches forbidden model pattern '$pattern': $model" }
        }
    }
    $sources = @($settings.packages | ForEach-Object { Source-Of $_ })
    foreach ($required in $profile.managedPackages) {
        if ($sources -notcontains [string]$required) { Fail "Managed package missing: $required" }
    }
    foreach ($filter in $profile.packageExtensionFilters.PSObject.Properties) {
        $entry = @($settings.packages | Where-Object { (Package-Identity (Source-Of $_)) -eq $filter.Name }) | Select-Object -First 1
        if ($null -eq $entry -or $entry -is [string]) { Fail "Package extension filter missing: $($filter.Name)"; continue }
        foreach ($pattern in @($filter.Value)) {
            if (@($entry.extensions) -notcontains [string]$pattern) { Fail "Package extension filter '$pattern' missing: $($filter.Name)" }
        }
    }
}

$installedRoot = Join-Path $AgentDir "git\github.com\robertsima\my-smart-pi"
$runtimeExtensionsMatch = $true
foreach ($extensionName in @("vault-autoindex.ts", "harness-routing-guard.ts")) {
    $sourceExtension = Join-Path $RepoRoot "extensions\$extensionName"
    $installedExtension = Join-Path $installedRoot "extensions\$extensionName"
    if (-not (Test-Path -LiteralPath $installedExtension)) { $runtimeExtensionsMatch = $false; Fail "Installed extension missing: $installedExtension"; continue }
    if ((Get-FileHash -LiteralPath $sourceExtension -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $installedExtension -Algorithm SHA256).Hash) {
        $runtimeExtensionsMatch = $false
        Fail "Installed extension differs from source: $extensionName"
    }
}
if ($runtimeExtensionsMatch) { Pass "installed runtime extensions match source" }

if (Test-Path $subagentsPath) {
    $subagents = Read-Utf8 $subagentsPath | ConvertFrom-Json
    if ($subagents.maxConcurrent -eq 2 -and $subagents.defaultMaxTurns -eq 18 -and $subagents.toolDescriptionMode -eq "compact") { Pass "bounded compact subagent config" } else { Fail "subagents.json differs from bounded harness profile" }
}

if (Test-Path $routingPath) {
    $routing = Read-Utf8 $routingPath | ConvertFrom-Json
    foreach ($property in $profile.agentTemplates.PSObject.Properties) {
        $role = $property.Name
        $name = [string]$property.Value
        $path = Join-Path (Join-Path $AgentDir "agents") $name
        if (-not (Test-Path $path)) { Fail "Rendered agent missing: $name"; continue }
        $text = Read-Utf8 $path
        if (-not $text.StartsWith("---")) { Fail "Agent lacks YAML frontmatter: $name" }
        $expected = [regex]::Escape([string]$routing.roles.$role.model)
        if ($text -notmatch "model:\s*$expected") { Fail "Rendered model mismatch for role '$role'" }
    }
}

$llamaSource = Join-Path $AgentDir "npm\node_modules\pi-llama-switch\src\switcher.ts"
$llamaIndex = Join-Path $AgentDir "npm\node_modules\pi-llama-switch\src\index.ts"
$subagentSource = Join-Path $AgentDir "npm\node_modules\@tintinweb\pi-subagents\src\index.ts"
if ((Test-Path $llamaSource) -and (Get-Content $llamaSource -Raw).Contains("MY_SMART_PI_WINDOWS_PROCESS_SUPPORT") -and (Test-Path $llamaIndex) -and (Get-Content $llamaIndex -Raw).Contains("MY_SMART_PI_WINDOWS_MODEL_DETECTION")) { Pass "Windows local-server patches" } else { Fail "Windows local-server patch missing" }
if ((Test-Path $subagentSource) -and (Get-Content $subagentSource -Raw).Contains("MY_SMART_PI_STRICT_PINNED_MODEL")) { Pass "strict pinned-model patch" } else { Fail "strict pinned-model patch missing" }

if (Test-Path $routingPath) {
    $routing = Read-Utf8 $routingPath | ConvertFrom-Json
    $switchKey = [string]$routing.local.switchKey
    if ([string]::IsNullOrWhiteSpace($switchKey)) { Fail "Machine-local switch key is empty" }
    $modelConfig = Read-Utf8 (Join-Path $AgentDir "model-switcher.json") | ConvertFrom-Json
    if ($null -eq $modelConfig.models.PSObject.Properties[$switchKey]) { Fail "Switch key '$switchKey' missing from current model-switcher.json" } else {
        $port = [int]$modelConfig.server.port
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/models" -TimeoutSec 10
            if ($null -ne $response) { Pass "machine-local model endpoint on port $port" }
            $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
            $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
            if ($process.Name -like "llama-server*") { Pass "port $port owned by llama-server PID $($listener.OwningProcess)" } else { Fail "port $port owner is not llama-server" }
        } catch { Fail "Machine-local endpoint health failed: $($_.Exception.Message)" }
    }
}

try {
    $packageList = (& pi list 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "pi list exited $LASTEXITCODE" }
    if ($packageList -match "Extension .* error|prepareCompaction.*not a function|Cannot find module") { Fail "Pi extension load error detected" } else { Pass "Pi extension load smoke" }
} catch { Fail "Pi list smoke failed: $($_.Exception.Message)" }

$warnings.Add("Vault semantic search requires a fresh Pi process after restart; doctor never renames or drops live Lance tables.")
foreach ($warning in $warnings) { Write-Host "WARN $warning" -ForegroundColor Yellow }
if ($failures.Count -gt 0) {
    foreach ($failure in $failures) { Write-Host "FAIL $failure" -ForegroundColor Red }
    exit 1
}
Write-Host "Harness doctor passed." -ForegroundColor Green
exit 0
