# Seth-Solana Cross-Chain Bridge Architecture

## Overview

This document describes the complete architecture of the bidirectional cross-chain bridge between **Seth Chain** (EVM-compatible) and **Solana**, including detailed flow diagrams, fee calculations, and exchange rate conversions.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           Cross-Chain Bridge Architecture                                │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│    ┌─────────────────────────────────┐          ┌─────────────────────────────────┐     │
│    │         SETH CHAIN (EVM)        │          │         SOLANA (Anchor)          │     │
│    ├─────────────────────────────────┤          ├─────────────────────────────────┤     │
│    │                                 │          │                                 │     │
│    │  ┌───────────────────────────┐  │          │  ┌───────────────────────────┐  │     │
│    │  │         PoolB.sol         │  │          │  │      Seth Bridge          │  │     │
│    │  │  ┌─────────────────────┐  │  │          │  │  ┌─────────────────────┐  │  │     │
│    │  │  │ • buySETH()         │  │  │          │  │  │ • process_revenue() │  │  │     │
│    │  │  │ • sellSETH()        │  │  │          │  │  │ • process_seth_     │  │  │     │
│    │  │  │ • reserves:         │  │  │          │  │  │   withdrawal()      │  │  │     │
│    │  │  │   - SETH (native)   │  │  │          │  │  │ • DIRM Swap Pool    │  │  │     │
│    │  │  │   - sUSDC (ERC20)   │  │  │          │  │  │ • sUSDC (SPL Token) │  │  │     │
│    │  │  └─────────────────────┘  │  │          │  │  └─────────────────────┘  │  │     │
│    │  └───────────────────────────┘  │          │  └───────────────────────────┘  │     │
│    │                                 │          │                                 │     │
│    │  ┌───────────────────────────┐  │          │  ┌───────────────────────────┐  │     │
│    │  │        sUSDC.sol          │  │          │  │      USDC (SPL Token)     │  │     │
│    │  │  • mint/burn (minters)    │  │          │  │  • Native USDC on Solana  │  │     │
│    │  │  • ERC20 interface        │  │          │  │  • Used for DIRM swaps    │  │     │
│    │  └───────────────────────────┘  │          │  └───────────────────────────┘  │     │
│    │                                 │          │                                 │     │
│    │  Price: SETH/sUSDC = ?         │          │  Price: sUSDC/USDC = ?         │     │
│    │  (from PoolB reserves)         │          │  (from DIRM reserves)          │     │
│    └───────────────┬─────────────────┘          └───────────────┬─────────────────┘     │
│                    │                                            │                       │
│                    │                                            │                       │
│                    │       ┌──────────────────────────┐         │                       │
│                    │       │       PRICE SERVICE      │         │                       │
│                    ├──────►│  ┌────────────────────┐  │◄────────┤                       │
│                    │       │  │ Exchange Rates:    │  │         │                       │
│                    │       │  │ • SOL/USDC         │  │         │                       │
│                    │       │  │ • SETH/sUSDC       │  │         │                       │
│                    │       │  │ • sUSDC/USDC       │  │         │                       │
│                    │       │  └────────────────────┘  │         │                       │
│                    │       │  ┌────────────────────┐  │         │                       │
│                    │       │  │ Data Sources:      │  │         │                       │
│                    │       │  │ • CoinGecko API    │  │         │                       │
│                    │       │  │ • Jupiter API      │  │         │                       │
│                    │       │  │ • Pool Reserves    │  │         │                       │
│                    │       │  └────────────────────┘  │         │                       │
│                    │       └──────────────────────────┘         │                       │
│                    │                                            │                       │
│                    └──────────────────┬─────────────────────────┘                       │
│                                       │                                                 │
│                              ┌────────▼────────┐                                        │
│                              │     RELAYER     │                                        │
│                              │    (Node.js)    │                                        │
│                              ├─────────────────┤                                        │
│                              │ ┌─────────────┐ │                                        │
│                              │ │ Event       │ │                                        │
│                              │ │ Monitoring  │ │                                        │
│                              │ └─────────────┘ │                                        │
│                              │ ┌─────────────┐ │                                        │
│                              │ │ Fee         │ │                                        │
│                              │ │ Calculation │ │                                        │
│                              │ └─────────────┘ │                                        │
│                              │ ┌─────────────┐ │                                        │
│                              │ │ PostgreSQL  │ │                                        │
│                              │ │ Database    │ │                                        │
│                              │ └─────────────┘ │                                        │
│                              └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Flow 1: Solana → Seth (Buy SETH via USDC Payment)

### User Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                    FLOW 1: Solana → Seth (Buy SETH with USDC)                            │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   USER                                                                                   │
│    │                                                                                     │
│    │ 1. process_revenue(usdc_amount, seth_recipient, referrer?)                         │
│    ▼                                                                                     │
│   ┌──────────────────────────────────────────────────────────────────┐                  │
│   │                    SOLANA: process_revenue()                      │                  │
│   │                                                                   │                  │
│   │  Input:                                                           │                  │
│   │  ├── usdc_amount:     USDC to spend                              │                  │
│   │  ├── seth_recipient:  Seth address (20 bytes)                    │                  │
│   │  └── referrer:        Optional referrer for rewards              │                  │
│   │                                                                   │                  │
│   │  Revenue Distribution:                                            │                  │
│   │  ┌─────────────────────────────────────────────────────────────┐ │                  │
│   │  │  10% → L1 Referrer Commission (if exists)                   │ │                  │
│   │  │   5% → L2 Referrer Commission (if exists)                   │ │                  │
│   │  │   5% → Team Wallet                                          │ │                  │
│   │  │  45% → Project Wallet                                       │ │                  │
│   │  │  35% → Cross-chain to Seth (Ecosystem Fund)                 │ │                  │
│   │  └─────────────────────────────────────────────────────────────┘ │                  │
│   │                                                                   │                  │
│   │  Actions:                                                         │                  │
│   │  ├── Transfer USDC from user to vaults                           │                  │
│   │  ├── Record user_info for price tracking                         │                  │
│   │  └── Emit RevenueProcessed event                                 │                  │
│   │                                                                   │                  │
│   │  Event: RevenueProcessed {                                       │                  │
│   │    user, usdc_amount, seth_recipient,                            │                  │
│   │    ecosystem_amount, solana_tx_signature                         │                  │
│   │  }                                                                │                  │
│   └──────────────────────────────────────────────────────────────────┘                  │
│                                    │                                                     │
│                                    │ Event emitted                                       │
│                                    ▼                                                     │
│   ┌──────────────────────────────────────────────────────────────────┐                  │
│   │                        RELAYER                                    │                  │
│   │                                                                   │                  │
│   │  1. Monitor Solana for RevenueProcessed events                   │                  │
│   │  2. Store message in database:                                   │                  │
│   │     ┌────────────────────────────────────────┐                   │                  │
│   │     │ cross_chain_messages table             │                   │                  │
│   │     │ ├── solana_tx_sig                      │                   │                  │
│   │     │ ├── amount (ecosystem_amount)          │                   │                  │
│   │     │ ├── sender_solana                      │                   │                  │
│   │     │ ├── recipient_seth                     │                   │                  │
│   │     │ └── status: pending                    │                   │                  │
│   │     └────────────────────────────────────────┘                   │                  │
│   │  3. Call Seth contract to mint sUSDC                             │                  │
│   └──────────────────────────────────────────────────────────────────┘                  │
│                                    │                                                     │
│                                    │ Call injectEcosystemFunds()                        │
│                                    ▼                                                     │
│   ┌──────────────────────────────────────────────────────────────────┐                  │
│   │                SETH: injectEcosystemFunds()                       │                  │
│   │                                                                   │                  │
│   │  Input:                                                           │                  │
│   │  ├── solana_tx_sig:  Transaction signature (replay protection)   │                  │
│   │  ├── recipient:       Seth address to receive sUSDC              │                  │
│   │  └── amount:          sUSDC amount to mint                       │                  │
│   │                                                                   │                  │
│   │  Actions:                                                         │                  │
│   │  ├── Verify solana_tx_sig not already processed                  │                  │
│   │  ├── Mint sUSDC to recipient                                     │                  │
│   │  ├── Add sUSDC liquidity to PoolB (optional)                     │                  │
│   │  └── Record cross-chain message hash                             │                  │
│   │                                                                   │                  │
│   │  Result:                                                          │                  │
│   │  └── User receives sUSDC on Seth chain                           │                  │
│   └──────────────────────────────────────────────────────────────────┘                  │
│                                    │                                                     │
│                                    │ User now has sUSDC on Seth                         │
│                                    ▼                                                     │
│   ┌──────────────────────────────────────────────────────────────────┐                  │
│   │              OPTIONAL: User calls buySETH() on PoolB              │                  │
│   │                                                                   │                  │
│   │  User can now:                                                    │                  │
│   │  ├── Hold sUSDC on Seth                                          │                  │
│   │  └── Or call buySETH(susdc_amount, min_seth_out, solana_address) │                  │
│   │      to get native SETH (with cross-chain to Solana option)      │                  │
│   └──────────────────────────────────────────────────────────────────┘                  │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Flow 2: Seth → Solana (Sell SETH, Receive sUSDC on Solana)

### User Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                   FLOW 2: Seth → Solana (Sell SETH for sUSDC)                            │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   USER                                                                                   │
│    │                                                                                     │
│    │ 1. sellSETH(min_susdc_out, solana_recipient) + native SETH                         │
│    │    Example: sellSETH(1000000n, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")     │
│    │             with msg.value = 1_000_000_000_000_000_000 wei (1 SETH)                │
│    ▼                                                                                     │
│   ┌──────────────────────────────────────────────────────────────────┐                  │
│   │                    SETH: PoolB.sellSETH()                         │                  │
│   │                                                                   │                  │
│   │  Input:                                                           │                  │
│   │  ├── msg.value:      Native SETH amount to sell                  │                  │
│   │  ├── minSUSDCOut:     Minimum sUSDC expected (slippage)          │                  │
│   │  └── solanaRecipient: Solana address (32 bytes as bytes32)       │                  │
│   │                                                                   │                  │
│   │  Calculation:                                                     │                  │
│   │  ┌─────────────────────────────────────────────────────────────┐ │                  │
│   │  │  amountSUSDCOut = (amountSETHIn * reservesUSDC)             │ │                  │
│   │  │                   / (reserveSETH + amountSETHIn)            │ │                  │
│   │  │                                                             │ │                  │
│   │  │  Example:                                                    │ │                  │
│   │  │  • SETH In:     1.0 SETH                                    │ │                  │
│   │  │  • Reserve SETH: 1000 SETH                                  │ │                  │
│   │  │  • Reserve sUSDC: 2,500,000 sUSDC (2500 USDC)               │ │                  │
│   │  │  • sUSDC Out: (1 * 2,500,000) / (1000 + 1) = 2497.5 sUSDC  │ │                  │
│   │  └─────────────────────────────────────────────────────────────┘ │                  │
│   │                                                                   │                  │
│   │  Actions:                                                         │                  │
│   │  ├── Receive native SETH (msg.value)                             │                  │
│   │  ├── Update pool reserves                                        │                  │
│   │  ├── BURN sUSDC from PoolB balance (cross-chain)                 │                  │
│   │  └── Emit SwapExecuted event                                     │                  │
│   │                                                                   │                  │
│   │  Event: SwapExecuted {                                           │                  │
│   │    user: 0x...,                                                  │                  │
│   │    isBuySETH: false,                                             │                  │
│   │    amountIn: 1000000000000000000,      // 1 SETH (wei)           │                  │
│   │    amountOut: 2497502,                  // ~2497.5 sUSDC          │                  │
│   │    price: 2500000000000000000,          // 2500 sUSDC/SETH       │                  │
│   │    timestamp: 1234567890,                                        │                  │
│   │    solanaRecipient: 0x7xKX... (bytes32)                          │                  │
│   │  }                                                                │                  │
│   └──────────────────────────────────────────────────────────────────┘                  │
│                                    │                                                     │
│                                    │ Event emitted                                       │
│                                    ▼                                                     │
│   ┌──────────────────────────────────────────────────────────────────┐                  │
│   │                        RELAYER                                    │                  │
│   │                                                                   │                  │
│   │  1. Monitor PoolB for SwapExecuted(isBuySETH=false) events       │                  │
│   │                                                                   │                  │
│   │  2. Parse solanaRecipient from event:                            │                  │
│   │     ┌────────────────────────────────────────┐                   │                  │
│   │     │ bytes32 → base58 Solana address        │                   │                  │
│   │     │ 0x7xKX... → "7xKXtg2CW..."             │                   │                  │
│   │     └────────────────────────────────────────┘                   │                  │
│   │                                                                   │                  │
│   │  3. Calculate Cross-Chain Fee:                                   │                  │
│   │     See detailed fee calculation below ↓                         │                  │
│   │                                                                   │                  │
│   │  4. Store in database:                                           │                  │
│   │     ┌────────────────────────────────────────┐                   │                  │
│   │     │ seth_withdrawal_messages table         │                   │                  │
│   │     │ ├── seth_tx_hash                       │                   │                  │
│   │     │ ├── seth_user                          │                   │                  │
│   │     │ ├── solana_recipient                   │                   │                  │
│   │     │ ├── susdc_amount (gross)               │                   │                  │
│   │     │ ├── cross_chain_fee                    │                   │                  │
│   │     │ └── status: pending                    │                   │                  │
│   │     └────────────────────────────────────────┘                   │                  │
│   │                                                                   │                  │
│   │  5. Call Solana process_seth_withdrawal()                       │                  │
│   └──────────────────────────────────────────────────────────────────┘                  │
│                                    │                                                     │
│                                    │ Call process_seth_withdrawal()                     │
│                                    ▼                                                     │
│   ┌──────────────────────────────────────────────────────────────────┐                  │
│   │           SOLANA: process_seth_withdrawal()                       │                  │
│   │                                                                   │                  │
│   │  Input:                                                           │                  │
│   │  ├── seth_tx_hash:    Seth transaction hash (replay protection)  │                  │
│   │  ├── seth_user:       Seth user address (20 bytes)               │                  │
│   │  ├── susdc_amount:    Total sUSDC amount                         │                  │
│   │  └── cross_chain_fee: Fee for relayer (in sUSDC)                 │                  │
│   │                                                                   │                  │
│   │  Accounts:                                                        │                  │
│   │  ├── relayer:            Signed by relayer keypair               │                  │
│   │  ├── config:             Bridge config PDA                       │                  │
│   │  ├── withdrawal_message: PDA for replay protection               │                  │
│   │  ├── solana_recipient:   User's Solana wallet                    │                  │
│   │  ├── susdc_mint:         sUSDC SPL token mint                    │                  │
│   │  ├── user_susdc_account: User's sUSDC token account (ATA)        │                  │
│   │  ├── relayer_susdc_acct: Relayer's sUSDC account (fee receiver)  │                  │
│   │  └── vault_authority:    PDA with mint authority                 │                  │
│   │                                                                   │                  │
│   │  Actions:                                                         │                  │
│   │  ├── Verify seth_tx_hash not already processed                   │                  │
│   │  ├── Initialize withdrawal_message PDA                           │                  │
│   │  ├── Mint (susdc_amount - fee) sUSDC to user                     │                  │
│   │  └── Mint fee sUSDC to relayer (gas subsidy)                     │                  │
│   │                                                                   │                  │
│   │  Result:                                                          │                  │
│   │  ┌─────────────────────────────────────────────────────────────┐ │                  │
│   │  │  Gross Amount: 2,497,502 sUSDC (2.497502 USDC)              │ │                  │
│   │  │  Cross-Chain Fee: ~200 sUSDC (0.0002 USDC)                  │ │                  │
│   │  │  Net to User: 2,497,302 sUSDC (2.497302 USDC)               │ │                  │
│   │  │  Fee to Relayer: 200 sUSDC                                  │ │                  │
│   │  └─────────────────────────────────────────────────────────────┘ │                  │
│   └──────────────────────────────────────────────────────────────────┘                  │
│                                    │                                                     │
│                                    │ User now has sUSDC on Solana                       │
│                                    ▼                                                     │
│   ┌──────────────────────────────────────────────────────────────────┐                  │
│   │          OPTIONAL: User swaps sUSDC → USDC via DIRM               │                  │
│   │                                                                   │                  │
│   │  User can:                                                        │                  │
│   │  ├── Hold sUSDC on Solana                                        │                  │
│   │  └── Swap sUSDC to native USDC using DIRM pool                   │                  │
│   │      (sUSDC/USDC exchange rate from DIRM reserves)               │                  │
│   └──────────────────────────────────────────────────────────────────┘                  │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Cross-Chain Fee Calculation

### Exchange Rate Chain

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                          Exchange Rate Chain                                             │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   The cross-chain fee is calculated to cover Solana gas costs in sUSDC terms.           │
│   This requires a chain of exchange rate conversions:                                    │
│                                                                                          │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │                                                                                 │   │
│   │    SOL ─────────► USDC ─────────► sUSDC ◄──────── SETH                          │   │
│   │     │              │               │              │                             │   │
│   │     │  SOL/USDC    │  USDC/sUSDC   │  SETH/sUSDC  │                             │   │
│   │     │  (Jupiter/   │  (DIRM Pool)  │  (PoolB)     │                             │   │
│   │     │  CoinGecko)  │               │              │                             │   │
│   │     ▼              ▼               ▼              ▼                             │   │
│   │                                                                                 │   │
│   │   Exchange Rate Chain:                                                         │   │
│   │   SOL/SETH = (SOL/USDC) × (USDC/sUSDC) ÷ (SETH/sUSDC)                          │   │
│   │                                                                                 │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Data Sources:                                                                          │
│   ┌────────────────┬────────────────┬───────────────────────────────────────────────┐   │
│   │    Rate        │    Source      │    How to Calculate                           │   │
│   ├────────────────┼────────────────┼───────────────────────────────────────────────┤   │
│   │  SOL/USDC      │ CoinGecko API  │ Direct API call to CoinGecko price endpoint   │   │
│   │                │ Jupiter API    │ Or Jupiter price API for more accurate rate   │   │
│   ├────────────────┼────────────────┼───────────────────────────────────────────────┤   │
│   │  USDC/sUSDC    │ DIRM Pool      │ reserveUSDC / reservesUSDC from DIRM pool     │   │
│   │                │ (Solana)       │ On-chain query via RPC                        │   │
│   ├────────────────┼────────────────┼───────────────────────────────────────────────┤   │
│   │  SETH/sUSDC    │ PoolB          │ reservesUSDC / reserveSETH from PoolB         │   │
│   │                │ (Seth Chain)   │ On-chain query via RPC                        │   │
│   └────────────────┴────────────────┴───────────────────────────────────────────────┘   │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Fee Calculation Formula

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                          Fee Calculation Formula                                         │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   Step 1: Calculate Solana Gas Cost in SOL                                              │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  gas_cost_sol = estimated_compute_units × compute_unit_price                    │   │
│   │                                                                                 │   │
│   │  Example:                                                                       │   │
│   │  • Estimated Compute Units: 200,000                                            │   │
│   │  • Compute Unit Price: 0.000005 SOL (5000 microlamports)                       │   │
│   │  • gas_cost_sol = 200,000 × 0.000005 = 0.001 SOL                               │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Step 2: Get Exchange Rates                                                            │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  Current Market Rates (example):                                                │   │
│   │  • SOL/USDC:  150 USDC per SOL                                                  │   │
│   │  • USDC/sUSDC: 1.0 (DIRM pool, nearly 1:1)                                     │   │
│   │  • SETH/sUSDC: 2500 sUSDC per SETH (from PoolB reserves)                        │   │
│   │                                                                                 │   │
│   │  Cross Rate:                                                                    │   │
│   │  • SOL/SETH = (SOL/USDC) × (USDC/sUSDC) ÷ (SETH/sUSDC)                          │   │
│   │  • SOL/SETH = 150 × 1.0 ÷ 2500 = 0.06 SETH per SOL                             │   │
│   │  • Or: SETH/SOL = 1 ÷ 0.06 = 16.67 SETH per SOL                                │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Step 3: Convert Gas Cost to sUSDC                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  gas_cost_susdc = gas_cost_sol × (SOL/USDC) × (USDC/sUSDC)                      │   │
│   │                                                                                 │   │
│   │  Example:                                                                       │   │
│   │  • gas_cost_susdc = 0.001 SOL × 150 USDC/SOL × 1.0                             │   │
│   │  • gas_cost_susdc = 0.15 USDC = 150,000 sUSDC (microUSDC)                       │   │
│   │                                                                                 │   │
│   │  Wait, this seems high. Let's recalculate properly:                             │   │
│   │  • sUSDC has 6 decimals (microUSDC)                                            │   │
│   │  • 0.15 USDC = 150,000 microUSDC                                               │   │
│   │  • Actually: 0.001 SOL × 150 = 0.15 USDC                                       │   │
│   │  • In microUSDC: 0.15 × 1,000,000 = 150,000                                    │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Step 4: Add Markup                                                                    │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  final_fee = gas_cost_susdc × (1 + markup_percent / 100)                        │   │
│   │                                                                                 │   │
│   │  Example with 10% markup:                                                       │   │
│   │  • final_fee = 150,000 × 1.10 = 165,000 microUSDC                              │   │
│   │  • final_fee = 0.165 USDC                                                       │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Step 5: Apply Minimum Fee Cap                                                         │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  fee = max(final_fee, min_fee)                                                  │   │
│   │  fee = min(fee, max_fee_percent × susdc_amount)  // Cap at 10% of amount        │   │
│   │                                                                                 │   │
│   │  Example:                                                                       │   │
│   │  • User's sUSDC amount: 2,497,502 microUSDC (2.49 USDC)                         │   │
│   │  • Calculated fee: 165,000 microUSDC (0.165 USDC)                              │   │
│   │  • Max fee (10%): 249,750 microUSDC                                            │   │
│   │  • Final fee: 165,000 microUSDC (within cap)                                   │   │
│   │                                                                                 │   │
│   │  Net to user: 2,497,502 - 165,000 = 2,332,502 microUSDC                         │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Price Service Implementation

```javascript
// price-service.js (simplified)

class PriceService {
    async getExchangeRates() {
        // 1. Get SOL/USDC from CoinGecko
        const solUsdc = await this.getCoinGeckoPrice('solana', 'usd');
        
        // 2. Get USDC/sUSDC from DIRM pool (Solana)
        const dirmReserves = await this.getDIRMReserves();
        const usdcSusdc = dirmReserves.reserveUSDC / dirmReserves.reservesUSDC;
        
        // 3. Get SETH/sUSDC from PoolB (Seth)
        const poolBReserves = await this.getPoolBReserves();
        const sethSusdc = poolBReserves.reservesUSDC / poolBReserves.reserveSETH;
        
        return {
            solUsdc,      // e.g., 150.0 USDC per SOL
            usdcSusdc,    // e.g., 1.0 (should be close to 1)
            sethSusdc,    // e.g., 2500.0 sUSDC per SETH
        };
    }
    
    async estimateCrossChainFee(direction, gasUnits) {
        const rates = await this.getExchangeRates();
        
        // Solana gas cost in SOL
        const gasPriceSol = 0.000005; // 5000 microlamports per CU
        const gasCostSol = Number(gasUnits) * gasPriceSol;
        
        // Convert to sUSDC
        const gasCostUsdc = gasCostSol * rates.solUsdc;
        const gasCostSusdc = gasCostUsdc * rates.usdcSusdc;
        
        // Convert to microUSDC (6 decimals)
        const gasCostMicroSusdc = Math.floor(gasCostSusdc * 1_000_000);
        
        // Add markup (default 10%)
        const markup = 1.10;
        const fee = Math.floor(gasCostMicroSusdc * markup);
        
        return {
            gasCostSol,
            gasCostSusdc,
            fee,  // in microUSDC
            exchangeRate: {
                solUsdc: rates.solUsdc,
                usdcSusdc: rates.usdcSusdc,
                sethSusdc: rates.sethSusdc,
            }
        };
    }
}
```

---

## Security Model

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              Security Model                                              │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   Replay Protection                                                                      │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  Solana → Seth:                                                                 │   │
│   │  ├── Seth contract stores processed solana_tx_sig hashes                        │   │
│   │  └── Duplicate submissions are rejected                                         │   │
│   │                                                                                 │   │
│   │  Seth → Solana:                                                                 │   │
│   │  ├── Solana program creates withdrawal_message PDA per seth_tx_hash            │   │
│   │  └── Attempting to process same hash twice fails (account already exists)      │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Relayer Authentication                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  Solana:                                                                         │   │
│   │  ├── Only registered relayer (in bridge config) can call process_seth_withdrawal│   │
│   │  └── Relayer pubkey stored in config PDA                                        │   │
│   │                                                                                 │   │
│   │  Seth:                                                                           │   │
│   │  ├── Only registered relayer can call injectEcosystemFunds                      │   │
│   │  └── Relayer address stored in contract                                         │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Fee Protection                                                                         │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  ├── Fee is capped at 10% of withdrawal amount                                  │   │
│   │  ├── Minimum fee ensures relayer doesn't lose money                             │   │
│   │  └── Fee collected in sUSDC goes to relayer for gas subsidy                     │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
│   Address Validation                                                                     │
│   ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│   │  ├── solanaRecipient must be valid 32-byte pubkey (checked on contract)         │   │
│   │  ├── sethRecipient must be valid 20-byte address                                │   │
│   │  └── Zero addresses are rejected                                                │   │
│   └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              Database Schema                                             │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│   cross_chain_messages (Solana → Seth)                                                   │
│   ┌────────────────┬──────────────┬─────────────────────────────────────────────────┐   │
│   │ Column         │ Type         │ Description                                       │   │
│   ├────────────────┼──────────────┼─────────────────────────────────────────────────┤   │
│   │ id             │ SERIAL       │ Primary key                                       │   │
│   │ solana_tx_sig  │ VARCHAR(88)  │ Solana transaction signature (base58)            │   │
│   │ amount         │ BIGINT       │ sUSDC amount to mint                              │   │
│   │ sender_solana  │ VARCHAR(44)  │ Sender's Solana address                           │   │
│   │ recipient_seth │ VARCHAR(42)  │ Recipient's Seth address                          │   │
│   │ status         │ VARCHAR(20)  │ pending/processing/completed/failed              │   │
│   │ seth_tx_hash   │ VARCHAR(66)  │ Seth transaction hash (after processing)          │   │
│   │ retry_count    │ INTEGER      │ Number of retry attempts                          │   │
│   │ last_error     │ TEXT         │ Last error message                                │   │
│   │ created_at     │ TIMESTAMP    │ Record creation time                              │   │
│   │ processed_at   │ TIMESTAMP    │ Processing completion time                        │   │
│   └────────────────┴──────────────┴─────────────────────────────────────────────────┘   │
│                                                                                          │
│   seth_withdrawal_messages (Seth → Solana)                                               │
│   ┌────────────────┬──────────────┬─────────────────────────────────────────────────┐   │
│   │ Column         │ Type         │ Description                                       │   │
│   ├────────────────┼──────────────┼─────────────────────────────────────────────────┤   │
│   │ id             │ SERIAL       │ Primary key                                       │   │
│   │ seth_tx_hash   │ VARCHAR(66)  │ Seth transaction hash (unique)                    │   │
│   │ seth_user      │ VARCHAR(42)  │ User's Seth address                               │   │
│   │ solana_recipient│ VARCHAR(44) │ Recipient's Solana address                        │   │
│   │ susdc_amount   │ BIGINT       │ Gross sUSDC amount (before fee)                   │   │
│   │ cross_chain_fee│ BIGINT       │ Fee deducted (goes to relayer)                    │   │
│   │ seth_amount_in │ BIGINT       │ SETH amount sold                                  │   │
│   │ seth_price     │ BIGINT       │ SETH price at time of sale                        │   │
│   │ status         │ VARCHAR(20)  │ pending/processing/completed/failed/pending_map   │   │
│   │ solana_tx_sig  │ VARCHAR(88)  │ Solana transaction signature (after processing)   │   │
│   │ retry_count    │ INTEGER      │ Number of retry attempts                          │   │
│   │ next_retry_at  │ TIMESTAMP    │ Next scheduled retry time                         │   │
│   │ last_error     │ TEXT         │ Last error message                                │   │
│   │ created_at     │ TIMESTAMP    │ Record creation time                              │   │
│   │ processed_at   │ TIMESTAMP    │ Processing completion time                        │   │
│   └────────────────┴──────────────┴─────────────────────────────────────────────────┘   │
│                                                                                          │
│   user_address_mapping (Seth ↔ Solana Address Mapping)                                   │
│   ┌──────────────────────┬──────────────┬───────────────────────────────────────────┐   │
│   │ Column               │ Type         │ Description                                 │   │
│   ├──────────────────────┼──────────────┼───────────────────────────────────────────┤   │
│   │ id                   │ SERIAL       │ Primary key                                 │   │
│   │ seth_address         │ VARCHAR(42)  │ Seth address (lowercase, unique)            │   │
│   │ solana_address       │ VARCHAR(44)  │ Solana address (base58)                     │   │
│   │ is_active            │ BOOLEAN      │ Mapping is active                           │   │
│   │ total_withdrawals    │ INTEGER      │ Number of withdrawals processed             │   │
│   │ total_withdrawn_amount│ BIGINT      │ Total sUSDC withdrawn                       │   │
│   │ created_at           │ TIMESTAMP    │ Registration time                           │   │
│   │ last_used_at         │ TIMESTAMP    │ Last withdrawal time                        │   │
│   └──────────────────────┴──────────────┴───────────────────────────────────────────┘   │
│                                                                                          │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Configuration

### Environment Variables

```bash
# Seth Chain
SETH_RPC_URL=http://35.184.150.163:23001
POOL_B_ADDRESS=0x...
SUSDC_ADDRESS=0x...
SETH_RELAYER_PRIVATE_KEY=0x...

# Solana
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
SOLANA_BRIDGE_PROGRAM_ID=...
SOLANA_SUSDC_MINT=...
SOLANA_RELAYER_KEYPAIR_PATH=./relayer-keypair.json

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=bridge_relayer
DB_USER=postgres
DB_PASSWORD=...

# Price Service
COINGECKO_API_KEY=...
FEE_MARKUP_PERCENT=10
ESTIMATED_GAS_UNITS=200000
MIN_CROSS_CHAIN_FEE_SUSDC=100        # 0.0001 USDC
DEFAULT_CROSS_CHAIN_FEE_SUSDC=1000   # 0.001 USDC

# Relayer
POLL_INTERVAL_MS=5000
WITHDRAWAL_RETRY_INTERVAL=60000
MAX_RETRIES=5
```

---

## Summary

This cross-chain bridge enables seamless asset transfers between Seth Chain and Solana:

1. **Solana → Seth**: Users pay USDC on Solana, receive sUSDC on Seth (can be swapped for native SETH via PoolB)

2. **Seth → Solana**: Users sell native SETH on PoolB, receive sUSDC on Solana (can be swapped for USDC via DIRM)

3. **Fee Model**: Cross-chain fees are calculated based on real-time gas prices and exchange rates, with a configurable markup

4. **Security**: Replay protection, relayer authentication, and fee caps ensure secure and fair operations
