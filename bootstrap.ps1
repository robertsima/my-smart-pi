#Requires -Version 5.1
<#
.SYNOPSIS
  Set up the my-smart-pi harness against a local Pi install.

.DESCRIPTION
  Idempotent. Safe to re-run after a Pi reinstall, a new machine, or a
  settings.json that drifted. It:

    1. verifies pi is on PATH
    2. writes ~/.pi/agent/my-smart-pi.config.json (vault paths)
    3. writes ~/.pi/agent/extensions/guardrails.json (path allowlist)
    4. registers git:github.com/robertsima/my-smart-pi@<Ref> in settings.json
    5. prunes dead entries from settings.json "extensions"
    6. installs the required npm packages with the apache-arrow pin

  settings.json is merged, never overwritten -- your provider, model, auth
  and context prefs are preserved. A timestamped backup is written first.

  Machine-specific paths are not baked into this script. They come from
  bootstrap.local.json (gitignored) next to this file, or from parameters, or
  from an interactive prompt on first run. Answers are saved back to
  bootstrap.local.json so later runs are zero-argument.

.PARAMETER VaultRoot
  Obsidian vault root, e.g. D:\Vault.

.PARAMETER AllowPaths
  Extra directories guardrails may touch, on top of the vault, the Pi agent
  dir, and the Node/npm dirs.

.PARAMETER ReadOnlySubdir
  Vault subdirectory to protect as read-only (your hand-authored notes).
  Pass '' to skip the rule.

.PARAMETER Ref
  Git ref of this package to install. Default main.

.PARAMETER SkipNpm
  Skip the npm install step.

.PARAMETER Reconfigure
  Ignore saved answers and prompt again.

.EXAMPLE
  .\bootstrap.ps1
.EXAMPLE
  .\bootstrap.ps1 -VaultRoot D:\Vault -AllowPaths D:\Development -ReadOnlySubdir 'Vault Mind'
#>
[CmdletBinding()]
param(
  [string]   $VaultRoot,
  [string[]] $AllowPaths,
  [string]   $ReadOnlySubdir,
  [string]   $Ref = 'main',
  [switch]   $SkipNpm,
  [switch]   $Reconfigure
)

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "    ! $m" -ForegroundColor Yellow }

# --------------------------------------------------------- saved answers
# Keeps personal paths out of Git while still making re-runs zero-argument.
$LocalCfgPath = Join-Path $PSScriptRoot 'bootstrap.local.json'
$saved = $null
if ((Test-Path $LocalCfgPath) -and -not $Reconfigure) {
  try { $saved = Get-Content $LocalCfgPath -Raw | ConvertFrom-Json }
  catch { Warn "Could not parse bootstrap.local.json; ignoring it." }
}

function Resolve-Setting {
  param($Explicit, $SavedValue, [string]$Prompt, $Default)
  # Explicit parameter wins, then the saved answer, then ask.
  if ($PSBoundParameters.ContainsKey('Explicit') -and $Explicit) { return $Explicit }
  if ($null -ne $SavedValue -and "$SavedValue" -ne '') { return $SavedValue }
  $hint = if ($Default) { " [$Default]" } else { '' }
  $ans = Read-Host "    $Prompt$hint"
  if (-not $ans) { return $Default }
  return $ans
}

$VaultRoot = Resolve-Setting -Explicit $VaultRoot -SavedValue $saved.vaultRoot `
  -Prompt 'Vault root' -Default (Join-Path $HOME 'Vault')

if (-not $AllowPaths) {
  if ($saved -and $saved.PSObject.Properties['allowPaths']) {
    $AllowPaths = @($saved.allowPaths)
  } else {
    $raw = Read-Host '    Extra allowed dirs, comma-separated (blank for none)'
    $AllowPaths = if ($raw) { $raw -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { @() }
  }
}

if (-not $PSBoundParameters.ContainsKey('ReadOnlySubdir')) {
  if ($saved -and $saved.PSObject.Properties['readOnlySubdir']) {
    $ReadOnlySubdir = $saved.readOnlySubdir
  } else {
    $ReadOnlySubdir = Read-Host '    Vault subdir to keep read-only (blank for none)'
  }
}

$AgentDir  = Join-Path $HOME '.pi\agent'
$ExtDir    = Join-Path $AgentDir 'extensions'
$NpmDir    = Join-Path $AgentDir 'npm'
$Settings  = Join-Path $AgentDir 'settings.json'
$PkgRef    = "git:github.com/robertsima/my-smart-pi@$Ref"
$Stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'

# Pi's JSON parser rejects a UTF-8 BOM ("Unexpected token '﻿'"), and
# PowerShell 5.1's `Set-Content -Encoding utf8` always writes one. Go through
# .NET with a BOM-less encoder instead.
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Json($Path, $Object) {
  $json = $Object | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json, $script:Utf8NoBom)
}

# ---------------------------------------------------------------- 1. pi present
Step 'Checking for pi'
$pi = Get-Command pi -ErrorAction SilentlyContinue
if (-not $pi) {
  throw "pi not found on PATH. Install it first: npm i -g @earendil-works/pi-coding-agent"
}
Ok "pi $(& pi --version 2>$null | Select-Object -First 1) at $($pi.Source)"

if (-not (Test-Path $AgentDir)) { New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null }
if (-not (Test-Path $ExtDir))   { New-Item -ItemType Directory -Force -Path $ExtDir   | Out-Null }

if (-not (Test-Path $VaultRoot)) {
  Warn "Vault root '$VaultRoot' does not exist yet -- writing config anyway."
}

# ------------------------------------------------------- 2. my-smart-pi config
# Both vault-autoindex.ts and global-vault-collections.ts read this file.
# Forward slashes here: the extensions join these with POSIX separators.
Step 'Writing my-smart-pi.config.json'
$vaultFwd = $VaultRoot -replace '\\', '/'
$smpConfig = [ordered]@{
  vaultAutoindex = [ordered]@{
    vaultRoot           = $vaultFwd
    watchRoots          = @('Vault Mind', 'AI Mind')
    vaultMindConfigPath = '.vault-mind/vault-mind.config.json'
    statePath           = '.vault-mind/autoindex-state.json'
    defaultCollection   = 'notes'
    collections         = @('notes', 'projects')
    collectionRules     = @(
      [ordered]@{ pattern = '^(AI Mind|Vault Mind)/Projects/'; collection = 'projects' }
    )
    debounceMs    = 2000
    maxChunkChars = 1500
  }
  globalVaultCollections = [ordered]@{
    vaultRoot           = $vaultFwd
    vaultMindConfigPath = '.vault-mind/vault-mind.config.json'
    promptLabel         = 'main vault'
  }
}
Write-Json (Join-Path $AgentDir 'my-smart-pi.config.json') $smpConfig
Ok "vaultRoot = $vaultFwd"

# ------------------------------------------------------------- 3. guardrails
# @aliou/pi-guardrails resolves its config to <agentDir>/extensions/guardrails.json.
# Without this file it falls back to onboarding and blocks paths -- this is the
# single most common cause of "pi lost its permissions" after a reinstall.
Step 'Writing guardrails.json'
$nodeDir = Split-Path (Get-Command node).Source -Parent
$npmGlobal = Join-Path $env:APPDATA 'npm'

$allowed = @($VaultRoot) + $AllowPaths + @((Join-Path $HOME '.pi'), $npmGlobal, $nodeDir)
$allowed = $allowed | Where-Object { $_ } | Select-Object -Unique

# Stamping `version` matters: without it guardrails runs its v0-format upgrade on
# first load, rewriting the file and dropping a guardrails.v0.json backup each time.
$guard = [ordered]@{
  '$schema'            = 'https://unpkg.com/@aliou/pi-guardrails@0.16.0/schema.json'
  applyBuiltinDefaults = $true
  version              = '0.13.0-20260619'
  onboarding = [ordered]@{
    completed   = $true
    completedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  }
  features = [ordered]@{ pathAccess = $true; policies = $true }
  pathAccess = [ordered]@{
    mode         = 'block'
    allowedPaths = @($allowed | ForEach-Object { [ordered]@{ kind = 'directory'; path = $_ } })
  }
}

if ($ReadOnlySubdir) {
  $ro = "$vaultFwd/$ReadOnlySubdir"
  $guard.policies = [ordered]@{
    rules = @(
      [ordered]@{
        id           = 'vault-source-read-only'
        name         = 'User-authored vault source read-only'
        description  = 'Allow reading hand-authored notes but prevent modifications.'
        patterns     = @([ordered]@{ pattern = $ro }, [ordered]@{ pattern = "$ro/**" })
        protection   = 'readOnly'
        onlyIfExists = $false
        enabled      = $true
      }
    )
  }
}

$guardPath = Join-Path $ExtDir 'guardrails.json'
if (Test-Path $guardPath) { Copy-Item $guardPath "$guardPath.bak-$Stamp" }
Write-Json $guardPath $guard
foreach ($p in $allowed) { Ok "allow $p" }
if ($ReadOnlySubdir) { Ok "read-only $vaultFwd/$ReadOnlySubdir" }

# --------------------------------------------------------------- 4. settings
# Merge, never clobber: settings.json holds provider/model/auth/context prefs
# that this package knows nothing about.
Step 'Updating settings.json'
if (Test-Path $Settings) {
  Copy-Item $Settings "$Settings.bak-$Stamp"
  Ok "backup -> settings.json.bak-$Stamp"
  $s = Get-Content $Settings -Raw | ConvertFrom-Json
} else {
  Warn 'No settings.json found; creating a minimal one.'
  $s = [pscustomobject]@{}
}

$requiredPkgs = @(
  'npm:pi-llama-switch'
  'npm:pi-caveman'
  'npm:@aliou/pi-guardrails'
  'npm:pi-web-access'
  'npm:pi-context'
  'npm:pi-vault-mind'
  'npm:@kylebrodeur/pi-model-discovery'
  'npm:@kylebrodeur/pi-model-router'
  $PkgRef
)

$pkgs = @()
if ($s.PSObject.Properties['packages']) { $pkgs = @($s.packages) }
# Drop any my-smart-pi entry pinned to a different ref before adding ours.
$pkgs = $pkgs | Where-Object { $_ -notlike 'git:github.com/robertsima/my-smart-pi@*' }
foreach ($p in $requiredPkgs) { if ($pkgs -notcontains $p) { $pkgs += $p } }
$s | Add-Member -NotePropertyName packages -NotePropertyValue @($pkgs) -Force
Ok "packages: $($pkgs.Count) entries (incl. $PkgRef)"

# Extensions now ship via the package's pi.extensions glob. Any absolute path
# left in settings.extensions that no longer exists is a load error at startup.
$exts = @()
if ($s.PSObject.Properties['extensions']) { $exts = @($s.extensions) }
$dead = $exts | Where-Object { $_ -and -not (Test-Path $_) }
$live = $exts | Where-Object { $_ -and (Test-Path $_) }
if ($dead) { foreach ($d in $dead) { Warn "pruned missing extension: $d" } }
$s | Add-Member -NotePropertyName extensions -NotePropertyValue @($live) -Force

Write-Json $Settings $s

# --------------------------------------------------------------------- 5. npm
# apache-arrow must stay at 18.1.0: LanceDB tables already written under 18
# fail to open against arrow 21.
if (-not $SkipNpm) {
  Step 'Installing npm packages (apache-arrow pinned to 18.1.0)'
  if (-not (Test-Path $NpmDir)) { New-Item -ItemType Directory -Force -Path $NpmDir | Out-Null }
  $npmPkg = [ordered]@{
    name    = 'pi-extensions'
    private = $true
    dependencies = [ordered]@{
      '@aliou/pi-guardrails'              = '^0.16.0'
      '@kylebrodeur/pi-model-discovery'   = '^0.7.24'
      '@kylebrodeur/pi-model-router'      = '^0.3.0'
      '@ollama/pi-web-search'             = '^0.0.5'
      '@xenova/transformers'              = '^2.17.2'
      'apache-arrow'                      = '18.1.0'
      'pi-caveman'                        = '^1.0.7'
      'pi-context'                        = '^2.1.2'
      'pi-llama-switch'                   = '^1.0.2'
      'pi-vault-mind'                     = '^0.16.25'
      'pi-web-access'                     = '^0.15.0'
    }
    overrides = [ordered]@{
      'pi-vault-mind' = [ordered]@{ 'apache-arrow' = '18.1.0' }
    }
  }
  Write-Json (Join-Path $NpmDir 'package.json') $npmPkg

  # npm writes deprecation/allow-scripts warnings to stderr; same NativeCommandError
  # problem as git above, so drop to Continue for the duration of the install.
  Push-Location $NpmDir
  $prevNpm = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & npm install --no-audit --no-fund 2>&1 | Out-Null
    $arrowPkg = Join-Path $NpmDir 'node_modules\apache-arrow\package.json'
    if (Test-Path $arrowPkg) {
      $arrow = (Get-Content $arrowPkg -Raw | ConvertFrom-Json).version
      if ($arrow -eq '18.1.0') { Ok "apache-arrow $arrow" } else { Warn "apache-arrow resolved to $arrow, expected 18.1.0" }
    } else { Warn 'apache-arrow not installed; check npm output.' }
  } finally {
    $ErrorActionPreference = $prevNpm
    $global:LASTEXITCODE = 0
    Pop-Location
  }
} else {
  Warn 'Skipped npm install (-SkipNpm)'
}

# ------------------------------------------------------------------ 6. fetch
# git writes clone/fetch progress to stderr, which PowerShell 5.1 surfaces as
# NativeCommandError and would abort us under $ErrorActionPreference='Stop'.
Step "Fetching package $PkgRef"
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $out = & pi install $PkgRef 2>&1
  $out | Where-Object { $_ -match '^\s*(Installed|Installing)' } | ForEach-Object { Ok ($_ -replace '\s+$', '') }
  # -notmatch on an array filters instead of returning a bool; negate -match.
  if (-not ($out -match 'Installed')) { Warn "pi install did not confirm; run 'pi list' to check." }
} finally {
  $ErrorActionPreference = $prev
  $global:LASTEXITCODE = 0
}

# ------------------------------------------------------------ 7. save answers
Step 'Saving answers'
Write-Json $LocalCfgPath ([ordered]@{
  vaultRoot      = $VaultRoot
  allowPaths     = @($AllowPaths)
  readOnlySubdir = $ReadOnlySubdir
})
Ok "bootstrap.local.json (gitignored) -- re-run with no arguments to reapply"

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'Start pi, then run /reload if it was already running.'
Write-Host "Verify with:  pi list"
