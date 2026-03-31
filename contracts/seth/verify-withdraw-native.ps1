# Verify native Seth -> Solana withdraw path (SethBridge -> PoolB).
#
# What it does:
# 1) Reads relayer/.env (USER_PRIVATE_KEY fallback to RELAYER_PRIVATE_KEY)
# 2) Uses current contracts/seth/deployment-info.json
# 3) Sends requestWithdrawToSolanaFromSETH with configurable amount/minOut
# 4) Prints before/after:
#    - totalWithdrawRequests
#    - PoolB.reserveSETH / PoolB.reservesUSDC
#
# Usage:
#   cd contracts/seth
#   .\verify-withdraw-native.ps1 -AmountSETH 100 -MinSusdcRaw 1 -SolanaRecipientHex 1111... (64 hex)

param(
    [int]$AmountSETH = 100,
    [int]$MinSusdcRaw = 1,
    [string]$SolanaRecipientHex = "1111111111111111111111111111111111111111111111111111111111111111",
    [string]$RepoRoot = "D:\code\blockchain\iPoW-Stack\Seth-AI-ecosystem"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Load-DotEnv([string]$envFile) {
    if (-not (Test-Path $envFile)) { return }
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
            $name = $matches[1].Trim()
            $value = $matches[2].Trim().Trim('"')
            Set-Item -Path "Env:$name" -Value $value
        }
    }
}

$envFile = Join-Path $RepoRoot "relayer\.env"
Load-DotEnv $envFile
if (-not $env:USER_PRIVATE_KEY -and $env:RELAYER_PRIVATE_KEY) {
    $env:USER_PRIVATE_KEY = $env:RELAYER_PRIVATE_KEY
}
if (-not $env:USER_PRIVATE_KEY) {
    Write-Host "ERROR: USER_PRIVATE_KEY missing (and RELAYER_PRIVATE_KEY not found)." -ForegroundColor Red
    exit 1
}

if ($SolanaRecipientHex -notmatch '^[0-9a-fA-F]{64}$') {
    Write-Host "ERROR: -SolanaRecipientHex must be exactly 64 hex chars." -ForegroundColor Red
    exit 1
}
if ($AmountSETH -lt 1) {
    Write-Host "ERROR: -AmountSETH must be >= 1" -ForegroundColor Red
    exit 1
}
if ($MinSusdcRaw -lt 0) {
    Write-Host "ERROR: -MinSusdcRaw must be >= 0" -ForegroundColor Red
    exit 1
}

Write-Host "Running native withdraw verification..." -ForegroundColor Cyan
Write-Host "  AmountSETH=$AmountSETH MinSusdcRaw=$MinSusdcRaw"
Write-Host "  SolanaRecipientHex=$SolanaRecipientHex"
Write-Host ""

py.exe .\request_withdraw_to_solana_from_seth.py `
    --amount-seth $AmountSETH `
    --min-susdc-raw-exact $MinSusdcRaw `
    --solana-recipient-hex $SolanaRecipientHex

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Verification FAILED (script exited non-zero)." -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Verification DONE." -ForegroundColor Green

