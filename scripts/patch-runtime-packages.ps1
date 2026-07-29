[CmdletBinding()]
param(
    [string]$AgentDir = (Join-Path $HOME ".pi\agent")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Utf8NoBom([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

function Replace-RequiredText {
    param([string]$Text, [string]$Old, [string]$New, [string]$Label)
    if (-not $Text.Contains($Old)) { throw "Upstream drift: missing $Label" }
    return $Text.Replace($Old, $New)
}

$llamaPath = Join-Path $AgentDir "npm\node_modules\pi-llama-switch\src\switcher.ts"
if (-not (Test-Path -LiteralPath $llamaPath)) { throw "Missing pi-llama-switch source: $llamaPath" }
$llama = Get-Content -LiteralPath $llamaPath -Raw
$llamaMarker = "MY_SMART_PI_WINDOWS_PROCESS_SUPPORT"
if (-not $llama.Contains($llamaMarker)) {
    $llama = Replace-RequiredText $llama `
        'import { spawn, execSync, type ChildProcess } from "node:child_process";' `
        'import { spawn, execFileSync, execSync, type ChildProcess } from "node:child_process";' `
        "llama child_process import"

    $oldProcessFunctions = @'
export function isLlamaServer(pid: number): boolean {
  try {
    const comm = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8" }).trim();
    return comm.includes("llama-server");
  } catch {
    return false;
  }
}

export function findLlamaServerPid(port: number): number | null {
  try {
    const output = execSync("pgrep -af llama-server", { encoding: "utf-8", timeout: 3000 }).trim();
    if (!output) return null;
    for (const line of output.split("\n")) {
      const match = line.match(/^(\d+)\s/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (isNaN(pid)) continue;
      if (line.includes(`--port`) && line.includes(String(port))) {
        return pid;
      }
    }
    return null;
  } catch {
    return null;
  }
}
'@
    $newProcessFunctions = @'
// MY_SMART_PI_WINDOWS_PROCESS_SUPPORT
export function isLlamaServer(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const script = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").Name`;
      const name = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      return name.toLowerCase().includes("llama-server");
    }
    const comm = execSync(`ps -p ${pid} -o comm=`, { encoding: "utf-8" }).trim();
    return comm.includes("llama-server");
  } catch {
    return false;
  }
}

export function findLlamaServerPid(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const script = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $c.OwningProcess }`;
      const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const pid = parseInt(raw, 10);
      return !isNaN(pid) && isLlamaServer(pid) ? pid : null;
    }
    const output = execSync("pgrep -af llama-server", { encoding: "utf-8", timeout: 3000 }).trim();
    if (!output) return null;
    for (const line of output.split("\n")) {
      const match = line.match(/^(\d+)\s/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (isNaN(pid)) continue;
      if (line.includes(`--port`) && line.includes(String(port))) return pid;
    }
    return null;
  } catch {
    return null;
  }
}
'@
    $llama = Replace-RequiredText $llama $oldProcessFunctions $newProcessFunctions "llama process helpers"
    $llama = Replace-RequiredText $llama '  let pid = state.activePid;' '  let pid = state.activePid ?? readPidFile();' "llama PID-file recovery"
    $llama = Replace-RequiredText $llama @'
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already dead
    }
'@ @'
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 10000 });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Process already dead
    }
'@ "llama Windows termination"
    Write-Utf8NoBom $llamaPath $llama
    Write-Host "Patched pi-llama-switch Windows process handling."
} else {
    Write-Host "pi-llama-switch Windows process patch already present."
}

$llamaIndexPath = Join-Path $AgentDir "npm\node_modules\pi-llama-switch\src\index.ts"
if (-not (Test-Path -LiteralPath $llamaIndexPath)) { throw "Missing pi-llama-switch index: $llamaIndexPath" }
$llamaIndex = Get-Content -LiteralPath $llamaIndexPath -Raw
$detectMarker = "MY_SMART_PI_WINDOWS_MODEL_DETECTION"
if (-not $llamaIndex.Contains($detectMarker)) {
    $llamaIndex = Replace-RequiredText $llamaIndex `
        'import { execSync } from "node:child_process";' `
        'import { execFileSync, execSync } from "node:child_process";' `
        "llama index child_process import"
    $oldDetect = @'
function detectModelFromPid(config: SwitcherConfig, pid: number): string | null {
  try {
    const args = execSync(`ps -p ${pid} -o args=`, {
      encoding: "utf-8",
      timeout: 1000,
    }).trim();

    for (const [key, model] of Object.entries(config.models)) {
      const ggufArg = model.command.find((arg) => arg.endsWith(".gguf"));
      if (ggufArg && args.includes(ggufArg)) {
        return key;
      }
    }
  } catch {
    // ps not available or other error
  }

  return config.defaultModel || null;
}
'@
    $newDetect = @'
// MY_SMART_PI_WINDOWS_MODEL_DETECTION
function detectModelFromPid(config: SwitcherConfig, pid: number): string | null {
  try {
    const args = process.platform === "win32"
      ? execFileSync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
        ], { encoding: "utf-8", timeout: 3000 }).trim()
      : execSync(`ps -p ${pid} -o args=`, { encoding: "utf-8", timeout: 1000 }).trim();

    for (const [key, model] of Object.entries(config.models)) {
      const ggufArg = model.command.find((arg) => arg.endsWith(".gguf"));
      if (ggufArg && args.includes(ggufArg)) return key;
    }
  } catch {
    // Process disappeared or platform command unavailable.
  }

  return config.defaultModel || null;
}
'@
    $llamaIndex = Replace-RequiredText $llamaIndex $oldDetect $newDetect "llama Windows model detection"
    Write-Utf8NoBom $llamaIndexPath $llamaIndex
    Write-Host "Patched pi-llama-switch Windows model detection."
} else {
    Write-Host "pi-llama-switch Windows model-detection patch already present."
}

$subagentsPath = Join-Path $AgentDir "npm\node_modules\@tintinweb\pi-subagents\src\index.ts"
if (-not (Test-Path -LiteralPath $subagentsPath)) { throw "Missing pi-subagents source: $subagentsPath" }
$subagents = Get-Content -LiteralPath $subagentsPath -Raw
$strictMarker = "MY_SMART_PI_STRICT_PINNED_MODEL"
if (-not $subagents.Contains($strictMarker)) {
    $oldFallback = @'
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
          // config-specified: silent fallback to parent
        } else {
'@
    $newFallback = @'
        if (typeof resolved === "string") {
          // MY_SMART_PI_STRICT_PINNED_MODEL: pinned agents must never inherit parent silently.
          if (resolvedConfig.modelFromParams) return textResult(resolved);
          return textResult(`Pinned agent model unavailable: "${resolvedConfig.modelInput}". ${resolved}`);
        } else {
'@
    $subagents = Replace-RequiredText $subagents $oldFallback $newFallback "subagent pinned-model fallback"
    Write-Utf8NoBom $subagentsPath $subagents
    Write-Host "Patched pi-subagents strict pinned-model handling."
} else {
    Write-Host "pi-subagents strict-model patch already present."
}

& node (Join-Path $PSScriptRoot "patch-pi-subagents-0.14.3.mjs") $AgentDir
if ($LASTEXITCODE -ne 0) { throw "pi-subagents nested Fleet patch failed: $LASTEXITCODE" }
