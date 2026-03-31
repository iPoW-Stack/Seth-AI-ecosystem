# Redeploy Seth stack, mint sUSDC to Treasury, inject initial PoolB liquidity.
#
# sUSDC 使用 6 位小数 raw（与 deploy_seth / inject_pool_b 一致）。
#
# 本脚本按用户指定：
#   Mint to Treasury:   100000000000 raw sUSDC（6 位小数）
#   Inject to PoolB:    100 raw sUSDC + 100 个原生 SETH（SETH 为整数）
#
# 前置：
#   pip install -r requirements-seth-deploy.txt
#   $env:DEPLOYER_PRIVATE_KEY = "0x..."   # 账户需有足够 Seth 原生币：部署预付费 + 注入用的 100 SETH
#   可选：RELAYER_PRIVATE_KEY / RELAYER_ADDRESS（默认同 deployer）
#
# 成功后：
#  1) 把 deployment-info.json 里 SethBridge 写入 relayer/.env 的 SETH_BRIDGE_ADDRESS
#  2) 可直接验证原生出金路径（新逻辑：SethBridge -> PoolB）：
#     python request_withdraw_to_solana_from_seth.py --amount-seth 100 --solana-recipient-hex <64_hex> --min-susdc-raw-exact 1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

if (-not $env:DEPLOYER_PRIVATE_KEY) {
    Write-Host "ERROR: Set DEPLOYER_PRIVATE_KEY (0x... deployer with Seth native balance)." -ForegroundColor Red
    exit 1
}

$mintRaw = '100000000000'
$injectSusdcRaw = '100'
$injectSeth = '100'

Write-Host "Mint to Treasury (raw, 6 decimals): $mintRaw"
Write-Host "Inject PoolB sUSDC (raw):           $injectSusdcRaw"
Write-Host "Inject PoolB native SETH (count):     $injectSeth"
Write-Host ""

python deploy_seth.py `
    --bootstrap-pool-liquidity `
    --mint-susdc-raw $mintRaw `
    --inject-susdc-raw $injectSusdcRaw `
    --inject-seth $injectSeth

if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Done. Set relayer/.env SETH_BRIDGE_ADDRESS from deployment-info.json (SethBridge)." -ForegroundColor Green
Write-Host "Verify native withdraw path (Bridge -> PoolB):" -ForegroundColor Green
Write-Host "  python request_withdraw_to_solana_from_seth.py --amount-seth 100 --solana-recipient-hex <64_hex> --min-susdc-raw-exact 1" -ForegroundColor Green
Write-Host "Then start relayer: cd ../../relayer; npm start" -ForegroundColor Green
