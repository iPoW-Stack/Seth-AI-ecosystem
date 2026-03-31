#Requires -Version 5.1
<#
.SYNOPSIS
  Build and upgrade-deploy seth_bridge on devnet via WSL (anchor build + solana program deploy --use-rpc).

.DESCRIPTION
  Runs contracts/solana/scripts/deploy-wsl.sh inside your WSL distro.
  Prereqs inside WSL: anchor-cli 0.32.x, solana CLI, Rust, deployer-keypair.json in contracts/solana.

.PARAMETER Distro
  WSL distribution name (default: Ubuntu-24.04, or $env:WSL_DISTRO_NAME).

.PARAMETER AnchorDeployRpc
  Optional devnet JSON-RPC URL. Overrides Helius default in deploy-wsl.sh.
  Example: https://devnet.helius-rpc.com/?api-key=YOUR_KEY

.EXAMPLE
  .\deploy-via-wsl.ps1

.EXAMPLE
  $env:ANCHOR_DEPLOY_RPC = 'https://your-devnet-rpc'
  .\deploy-via-wsl.ps1
#>
param(
    [string] $Distro = $(if ($env:WSL_DISTRO_NAME) { $env:WSL_DISTRO_NAME } else { 'Ubuntu-24.04' }),
    [string] $AnchorDeployRpc = $env:ANCHOR_DEPLOY_RPC
)

$ErrorActionPreference = 'Stop'

function ConvertTo-WslPath {
    param([Parameter(Mandatory)][string]$WindowsPath)
    $full = [System.IO.Path]::GetFullPath($WindowsPath)
    if ($full -notmatch '^([A-Za-z]):\\(.*)$') {
        throw "Path is not a D:\ style path: $full"
    }
    $drive = $Matches[1].ToLower()
    $tail = ($Matches[2].TrimEnd('\')) -replace '\\', '/'
    "/mnt/$drive/$tail"
}

$ScriptDir = $PSScriptRoot
$solanaWin = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$wslSolana = ConvertTo-WslPath $solanaWin

if ($AnchorDeployRpc -and $AnchorDeployRpc.Contains("'")) {
    throw 'ANCHOR_DEPLOY_RPC must not contain single quotes; use another URL or set it inside WSL.'
}

$lines = @(
    '#!/usr/bin/env bash'
    'set -euo pipefail'
)
if ($AnchorDeployRpc) {
    $lines += "export ANCHOR_DEPLOY_RPC='$AnchorDeployRpc'"
}
$lines += @(
    'export HOME=/root'
    'export PATH=/root/.cargo/bin:/root/.local/share/solana/install/active_release/bin:/usr/bin:/bin'
    "cd `"$wslSolana`""
    "sed -i 's/\r$//' scripts/deploy-wsl.sh"
    'exec bash scripts/deploy-wsl.sh'
)
$sh = ($lines -join "`n") + "`n"

$runnerWin = Join-Path $ScriptDir '_wsl-deploy-once.sh'
[System.IO.File]::WriteAllText($runnerWin, $sh, [System.Text.UTF8Encoding]::new($false))

$runnerWsl = ConvertTo-WslPath $runnerWin

try {
    Write-Host "[deploy-via-wsl] Distro=$Distro"
    Write-Host "[deploy-via-wsl] Solana dir (WSL): $wslSolana"
    if ($AnchorDeployRpc) { Write-Host '[deploy-via-wsl] Using custom ANCHOR_DEPLOY_RPC' }
    & wsl.exe -d $Distro -- bash -lc "bash '$runnerWsl'"
    if ($LASTEXITCODE -ne 0) { throw "wsl exited with code $LASTEXITCODE" }
} finally {
    Remove-Item $runnerWin -Force -ErrorAction SilentlyContinue
}
