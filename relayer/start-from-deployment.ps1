# Load SETH_BRIDGE_ADDRESS from contracts/seth/deployment-info.json and start the relayer.
# Requires: npm install, PostgreSQL per .env, dotenv-compatible .env in this folder.
#
# Usage (from repo root):
#   cd relayer
#   .\start-from-deployment.ps1
#
# Or override JSON path:
#   .\start-from-deployment.ps1 -DeploymentJson "D:\path\to\deployment-info.json"

param(
    [string]$DeploymentJson = (Join-Path $PSScriptRoot "..\contracts\seth\deployment-info.json")
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $DeploymentJson)) {
    Write-Host "ERROR: deployment-info.json not found: $DeploymentJson" -ForegroundColor Red
    exit 1
}
$j = Get-Content $DeploymentJson -Raw | ConvertFrom-Json
if (-not $j.SethBridge) {
    Write-Host "ERROR: SethBridge missing in JSON" -ForegroundColor Red
    exit 1
}
$env:SETH_BRIDGE_ADDRESS = [string]$j.SethBridge
Write-Host "SETH_BRIDGE_ADDRESS=$($env:SETH_BRIDGE_ADDRESS)" -ForegroundColor Cyan
Set-Location $PSScriptRoot
npm start
