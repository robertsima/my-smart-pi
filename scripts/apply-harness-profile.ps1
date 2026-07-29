[CmdletBinding()]
param(
    [string]$AgentDir = (Join-Path $HOME ".pi\agent"),
    [switch]$SkipNpmInstall,
    [switch]$SkipRuntimePatches
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ProfilePath = Join-Path $RepoRoot "config\harness-profile.json"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Read-Utf8([string]$Path) {
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}
function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}
$profile = Read-Utf8 $ProfilePath | ConvertFrom-Json

function Get-PackageSource($entry) {
    if ($entry -is [string]) { return [string]$entry }
    if ($null -ne $entry.source) { return [string]$entry.source }
    return ""
}

function Get-PackageIdentity([string]$source) {
    if (-not $source.StartsWith("npm:")) { return $source }
    $raw = $source.Substring(4)
    if ($raw.StartsWith("@")) {
        $slash = $raw.IndexOf("/")
        if ($slash -lt 0) { return "npm:$raw" }
        $versionAt = $raw.IndexOf("@", $slash + 1)
    } else {
        $versionAt = $raw.IndexOf("@")
    }
    if ($versionAt -ge 0) { $raw = $raw.Substring(0, $versionAt) }
    return "npm:$raw"
}

function Set-PackageExtensionFilters([object]$entry, [object]$filterConfig) {
    $source = Get-PackageSource $entry
    $identity = Get-PackageIdentity $source
    $match = $filterConfig.PSObject.Properties | Where-Object { $_.Name -eq $identity } | Select-Object -First 1
    if ($null -eq $match) { return $entry }

    $result = [ordered]@{ source = $source }
    if ($entry -isnot [string]) {
        foreach ($property in $entry.PSObject.Properties) {
            if ($property.Name -notin @("source", "extensions")) { $result[$property.Name] = $property.Value }
        }
    }
    $result.extensions = @($match.Value)
    return [pscustomobject]$result
}

New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
$npmDir = Join-Path $AgentDir "npm"
New-Item -ItemType Directory -Force -Path $npmDir | Out-Null

$npmPackage = [ordered]@{
    private = $true
    dependencies = [ordered]@{}
    overrides = [ordered]@{
        "apache-arrow" = "18.1.0"
        "@lancedb/lancedb" = "0.33.0"
        "pi-vault-mind" = [ordered]@{ "apache-arrow" = "18.1.0" }
    }
}
foreach ($property in $profile.npmDependencies.PSObject.Properties) {
    $npmPackage.dependencies[$property.Name] = [string]$property.Value
}
$npmPackagePath = Join-Path $npmDir "package.json"
Write-Utf8NoBom $npmPackagePath ($npmPackage | ConvertTo-Json -Depth 10)
if (-not $SkipNpmInstall) {
    # Preserve currently installed legacy Pi plugins whose peer ranges lag current Pi.
    & npm install --prefix $npmDir --no-audit --no-fund --legacy-peer-deps
    if ($LASTEXITCODE -ne 0) { throw "npm install failed: $LASTEXITCODE" }
}

$settingsPath = Join-Path $AgentDir "settings.json"
if (Test-Path -LiteralPath $settingsPath) {
    $settings = Read-Utf8 $settingsPath | ConvertFrom-Json
} else {
    $settings = [pscustomobject]@{}
}
if ($null -eq $settings.PSObject.Properties["packages"]) {
    $settings | Add-Member -NotePropertyName packages -NotePropertyValue @()
}
$managedByIdentity = @{}
foreach ($source in $profile.managedPackages) { $managedByIdentity[(Get-PackageIdentity ([string]$source))] = [string]$source }
$removedByIdentity = @{}
foreach ($source in @($profile.removedPackages)) { $removedByIdentity[(Get-PackageIdentity ([string]$source))] = $true }
$preserved = @()
foreach ($entry in @($settings.packages)) {
    $source = Get-PackageSource $entry
    $identity = Get-PackageIdentity $source
    if ($managedByIdentity.ContainsKey($identity) -or $removedByIdentity.ContainsKey($identity)) { continue }
    $preserved += $entry
}
$managedEntries = @($profile.managedPackages | ForEach-Object { [ordered]@{ source = [string]$_ } })
$settings.packages = @($preserved + $managedEntries) | ForEach-Object {
    Set-PackageExtensionFilters $_ $profile.packageExtensionFilters
}
Write-Utf8NoBom $settingsPath ($settings | ConvertTo-Json -Depth 20)

Write-Utf8NoBom (Join-Path $AgentDir "subagents.json") ($profile.subagents | ConvertTo-Json -Depth 10)
$routingPath = Join-Path $AgentDir "agent-routing.local.json"
if (-not (Test-Path -LiteralPath $routingPath)) {
    throw "Missing machine-local routing config: $routingPath (copy config\agent-routing.example.json and bind existing models)"
}
$routing = Read-Utf8 $routingPath | ConvertFrom-Json
$enabledModels = @($settings.enabledModels | ForEach-Object { [string]$_ })
$localProvider = [string]$profile.routingPolicy.localProvider
$apiProviders = @($profile.routingPolicy.apiProviders | ForEach-Object { [string]$_ })
$apiRoles = @($profile.routingPolicy.apiRoles | ForEach-Object { [string]$_ })
$localRoles = @($profile.routingPolicy.localRoles | ForEach-Object { [string]$_ })
if ([string]::IsNullOrWhiteSpace($localProvider)) { throw "Profile routingPolicy.localProvider is not configured." }
if ($apiProviders.Count -eq 0) { throw "Profile routingPolicy.apiProviders must not be empty." }
if ([string]::IsNullOrWhiteSpace([string]$routing.local.switchKey) -or [string]$routing.local.switchKey -match '<|>') { throw "Routing local.switchKey is not configured in $routingPath." }
if ([int]$routing.local.maxParallel -ne [int]$profile.routingPolicy.maxLocalParallel) { throw "Routing local.maxParallel must be $($profile.routingPolicy.maxLocalParallel); harness starts at most one local child." }
$agentsDir = Join-Path $AgentDir "agents"
New-Item -ItemType Directory -Force -Path $agentsDir | Out-Null
$localLines = New-Object System.Collections.Generic.List[string]
foreach ($property in $profile.agentTemplates.PSObject.Properties) {
    $role = $property.Name
    $templateName = [string]$property.Value
    $binding = $routing.roles.$role
    $model = [string]$binding.model
    $thinking = [string]$binding.thinking
    if ([string]::IsNullOrWhiteSpace($model)) { throw "Machine-local model binding missing for role: $role" }
    $provider = $model.Split('/', 2)[0]
    $usesLocalProvider = $provider.Equals($localProvider, [System.StringComparison]::OrdinalIgnoreCase)
    if ($role -in $apiRoles -and $apiProviders -notcontains $provider) { throw "Role '$role' must use an allowed API provider: $($apiProviders -join ', ')." }
    if ($role -in $localRoles -and -not $usesLocalProvider) { throw "Role '$role' must use local provider '$localProvider'." }
    if ($enabledModels.Count -gt 0 -and $enabledModels -notcontains $model) { throw "Role '$role' uses model outside current enabledModels: $model" }
    foreach ($pattern in @($routing.forbiddenModelPatterns)) {
        if ($model -like [string]$pattern) { throw "Role '$role' uses forbidden local model pattern '$pattern': $model" }
    }
    $rendered = (Read-Utf8 (Join-Path $RepoRoot "agents\$templateName")).Replace("{{MODEL}}", $model).Replace("{{THINKING}}", $thinking)
    Write-Utf8NoBom (Join-Path $agentsDir $templateName) $rendered
    $localLines.Add("- ${role}: ${model}")
}

$managedBlock = Read-Utf8 (Join-Path $RepoRoot "config\APPEND_SYSTEM.managed.md")
$managedBlock = $managedBlock.Replace("{{LOCAL_ROUTING}}", ($localLines -join "`r`n")).Replace("{{LOCAL_SWITCH_KEY}}", [string]$routing.local.switchKey)
$appendPath = Join-Path $AgentDir "APPEND_SYSTEM.md"
$append = if (Test-Path -LiteralPath $appendPath) { Read-Utf8 $appendPath } else { "" }
$start = "<!-- my-smart-pi:agent-routing:start -->"
$end = "<!-- my-smart-pi:agent-routing:end -->"
$startIndex = $append.IndexOf($start)
$endIndex = $append.IndexOf($end)
if ($startIndex -ge 0 -and $endIndex -gt $startIndex) {
    $endIndex += $end.Length
    $append = $append.Substring(0, $startIndex).TrimEnd() + "`r`n`r`n" + $managedBlock.Trim() + "`r`n" + $append.Substring($endIndex).TrimStart()
} else {
    $append = $append.TrimEnd() + "`r`n`r`n" + $managedBlock.Trim() + "`r`n"
}
Write-Utf8NoBom $appendPath $append

# Pi executes extensions from its installed git package cache. Keep that cache
# aligned with this working checkout so profile changes take effect immediately;
# fresh installs receive the same files from the committed package.
$installedHarnessRoot = Join-Path $AgentDir "git\github.com\robertsima\my-smart-pi"
if (Test-Path -LiteralPath $installedHarnessRoot) {
    foreach ($relativePath in @("extensions\vault-autoindex.ts", "extensions\harness-routing-guard.ts")) {
        $sourcePath = Join-Path $RepoRoot $relativePath
        $destinationPath = Join-Path $installedHarnessRoot $relativePath
        if ((Test-Path -LiteralPath $sourcePath) -and (Test-Path -LiteralPath (Split-Path -Parent $destinationPath))) {
            [System.IO.File]::WriteAllText($destinationPath, (Read-Utf8 $sourcePath), $Utf8NoBom)
        }
    }
}

if (-not $SkipRuntimePatches) {
    & (Join-Path $PSScriptRoot "patch-runtime-packages.ps1") -AgentDir $AgentDir
}

Write-Host "Applied harness profile. Restart Pi to load package, model, agent, and UI changes."
