# Meridian

Meridian DLMM, also known as Bandor, is a standalone Meteora liquidity bot for Solana. It screens token/SOL pools, combines signals from tracked LP wallets, and manages positions with rule-based entries, exits, and SOL settlement. It supports Shadow simulation, live trading, and position and PnL reporting through Slack and Telegram.

## Credits

Meridian DLMM originated as a fork of [yunus-0x/meridian](https://github.com/yunus-0x/meridian). Thanks to Yunus and the upstream contributors for the original project.

## Flow

1. Watch tracked LP wallets through Solana WebSocket notifications, with signature backfill for missed events.
2. Count distinct wallets adding meaningful quote-side liquidity to the same **mint address**, across pools, within a rolling window (default: two wallets in 120 seconds).
3. Screen that mint and its eligible token/SOL pools using Meteora and Jupiter data and on-chain token checks.
4. Recheck exposure, price movement, balances, and transaction safety before entry. Failed screening waits within a bounded deadline.
5. Monitor positions independently and execute rule-based closes and fee claims.

Shadow mode is the default and forces `DRY_RUN=true` for all transaction paths. It records proposals without submitting them. Read [user-config.example.json](user-config.example.json) for supported settings. Monitoring and screening implementation details are in [standalone/](standalone/).

## Setup

Use Node.js 22.13 or newer and a Solana RPC provider supporting WebSocket subscriptions and transaction history.

```sh
npm install
npm run setup
node cli.js wallets add --wallet ADDRESS --name NAME
node cli.js wallets add --wallet OTHER_ADDRESS --name OTHER_NAME
npm start
```

Setup writes `user-config.json` and starts with shadow mode enabled. It preserves existing settings when prompts are left blank. Set credentials in your environment or local `.env`; see [.env.example](.env.example). For read-only operation, `WALLET_ADDRESS` / `walletAddress` can identify the portfolio without a private key. Live signing requires `WALLET_PRIVATE_KEY`.

Supported infrastructure overrides:

| Variable | Purpose |
|---|---|
| `RPC_URL` | Default Solana endpoint and transaction submission |
| `MONITOR_RPC_URL`, `MONITOR_WS_URL` | Wallet monitoring endpoints |
| `BALANCE_RPC_URL` | Standard SOL and token balance reads |
| `FALLBACK_RPC_URL` | Fallback for monitor/balance reads |
| `PNL_SOURCE` | `meteora` (default) or `rpc` |
| `PNL_RPC_URL` | Optional on-chain PnL engine endpoint |
| `JUPITER_API_KEY` | Jupiter price and swap access |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional Telegram notifications |
| `TELEGRAM_ALLOWED_USER_IDS` | Enables Telegram admin commands for the listed users |

Balances use standard RPC, including SPL Token and Token-2022. PnL defaults to Meteora portfolio and position APIs, with an on-chain fallback. Jupiter supplies prices, token data, and swaps. Both Telegram and Slack support the standalone admin console.

### Optional discovery watchlist

Set `GMGN_API_KEY` for Solana trending tokens or `HELIUS_API_KEY` for confirmed Pump.fun launch and migration logs, then restart. Both can run together. GMGN needs read access only. Helius discovery uses standard WebSockets with its own key independently of the wallet monitor.

The watchlist combines recent token/SOL DLMM pools and active pools from Meteora with the optional GMGN and Helius feeds. It screens up to six mints per minute through the existing Jupiter, on-chain, and Meteora filters. Candidates with incomplete screening retry after 2, 5 and 10 minutes within a 30-minute queue lifetime. Matches go to the configured Slack owner DM and Telegram notifications. Discovery is advisory in live mode, where entry still requires wallet convergence and a full-size token-to-SOL exit quote.

Example mainnet RPC configuration. Replace the Helius placeholders with your endpoint key.

```dotenv
MONITOR_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
MONITOR_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
BALANCE_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
FALLBACK_RPC_URL=https://api.mainnet.solana.com
```

The public Solana HTTP endpoint is rate-limited. The HTTP fallback serves RPC reads. It does not replace the configured WebSocket subscription.

Set `researchEnabled: true` in Shadow mode to compare discovery strategies and a separate wallet-convergence baseline. Convergence uses regular screening, exposure and price rechecks, sizing from a simulated bankroll, and the full-size exit quote. The paper executor supports SOL-only positions and estimates counterfactual per-bin shares against observed Meteora reserves and cumulative fee growth. Jupiter minimum-out quotes value token inventory and token-denominated fees. The simulation does not change on-chain liquidity or reproduce its market impact, and charges an estimated 0.001 SOL round-trip cost. Incomplete bin or quote observations invalidate the daily return sample. Existing paper records remain historical; old open positions without an entry bin snapshot are archived.

Each variant has a separate bankroll (`paperBankrollSol`), a daily loss admission limit (`paperDailyLossLimitPct`) and a drawdown admission limit (`paperDrawdownLimitPct`). Exits remain active when admission is blocked. Daily return uses SOL equity across complete WIB days, including idle capital. Baseline starts collecting observations when qualifying wallet-convergence signals arrive. Challenger settings adjust range, first range wait, or max hold. Recommendations require at least 20 paired unique mints in training and 10 in a later validation window. They never update configuration automatically.

With `strategy: "auto"`, Shadow records matched Spot, Curve and Bid Ask trials. The screening trial tags the Mirror outcome using the last two completed five-minute volume candles and a one-hour pool fee-to-active-TVL estimate. The tag is for comparison and does not change entry screening.

`autoRebalance` defaults to true and adds a Shadow trial paired with the unchanged Mirror entry. It checks every three minutes and requires three consecutive qualifying observations and a 30-minute cooldown after a move. The trial only redistributes SOL in initialized bins below the active price inside the existing range. It estimates the fee advantage from recent per-bin fee growth, charges a simulated 0.00010 SOL per move, and yields to exits. Live Auto selects the shape at entry.

`paperTokenRunner` defaults to true in Shadow. At an eligible profitable Mirror exit, it simulates selling most of the withdrawn token immediately and keeping about 15% of the exit value in token, capped at 20%. Admission requires a majority-token inventory valued with a Jupiter sell quote and a rising trend in completed five-minute candles. It samples sell quotes every 15 seconds and exits the remainder on a 10% trailing decline, a break below the five-minute swing low, or after 30 minutes. An unavailable quote leaves the exit pending. Status reports the net difference versus selling everything at LP exit, including an extra 0.00003 SOL simulated swap cost.

`paperCapitalSol` and `paperMaxHoldMinutes` configure paper sizing and maximum hold. `paperMinExitRatio` is the minimum quoted liquidation value as a fraction of the current mark in both modes. Live close notifications distinguish confirmed LP closure from the subsequent token-to-SOL swap.

Paper waits up to `paperInitialRangeWaitMinutes` (45 by default) for first range contact. After contact, a non-profitable discretionary exit needs a continuous `paperLossGraceMinutes` buffer (20 by default). Stop loss and maximum hold still apply. A paper close message lists up to `paperCloseListLimit` variants (3 by default); every result is recorded.

Set `lifecycleReportMinutes` to a positive interval to send wallet balance, open positions and reported open-position PnL to the configured Slack DM and Telegram destination. A report also runs at startup. Edit the interval from the admin menu and restart. Zero disables reports.

Runtime storage is split into `.meridian-data/shadow.sqlite` and `.meridian-data/live.sqlite`. Shadow stores the paper ledger, NAV, research, and its PnL reset. Live stores tracked positions, closed-position PnL, decisions, and pool memory. Both keep separate monitor checkpoints and history. The first open of each database imports applicable legacy JSON records. Old files remain as migration sources. Pending signals are rebuilt from fresh wallet baselines. Settings, credentials, and the smart-wallet list remain shared. Switch modes from the admin console to save the selected mode and perform a supervised restart.

To enable live trading, review your thresholds, wallet list, and shadow results, set `shadowMode` to `false`, remove any `DRY_RUN=true` override, and restart. Configuration edits take effect after restart.

### Slack DM console

Create a dedicated Slack app from [slack-manifest.yaml](slack-manifest.yaml), install it in
the workspace, and generate an app-level token with `connections:write`.
Set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_APP_ID`, `SLACK_TEAM_ID`, and
`SLACK_OWNER_USER_ID` in the server `.env` and restart Meridian. Use separate tokens
from any other Socket Mode listener. The app opens a DM with the configured owner.

Type `menu`, `status`, `wallets`, `addwallet ADDRESS NAME`, `removewallet ADDRESS`, or
`cancel` in that DM. The manifest also registers corresponding `/meridian-…` commands.
The same console supports trigger, screening, risk, position sizing, strategy, exits,
RPC, PnL, wallet status and public address settings. Settings that need a restart are
marked. Start, stop, entry proposals, and confirmed deploy, close and swap notices
go to the owner DM. Menu buttons expire after five minutes and are replaced as the
card is updated.

Keep signing keys and Jupiter credentials in the private server `.env`. The Slack
console shows signing status and the public deposit address. Public RPC base URLs
can be edited from the console. Put endpoints with credentials or custom paths in
`.env` and restart. Slack live mode requires a valid local signing key,
`SLACK_ALLOW_LIVE=true`, `DRY_RUN=false`, and explicit owner confirmation.
The Restart button uses the standalone process supervisor.

## Commands

```sh
node cli.js help
node cli.js status
node cli.js balance
node cli.js positions
node cli.js screen --mint ADDRESS
node cli.js pool --pool ADDRESS
node cli.js manage --dry-run
node cli.js close --position ADDRESS --dry-run
node cli.js performance
```

`screen --mint` is read-only and never deploys. New entries are available only through wallet convergence. Manual close, claim, and swap operations remain available; run `help` for arguments. The CLI no longer writes skills into your home directory.

For a managed daemon:

```sh
npm run pm2:start
npm run pm2:logs
```

## Local state

Wallets, settings, position state, signal checkpoints, decisions, and logs stay local and are ignored by Git. `performance.js` retains closed-position accounting in the existing `lessons.json` file so historical records remain readable; it does not generate LLM lessons or contact HiveMind. Pool history and cooldowns remain in `pool-memory.json`.

A `submitting` attempt left by a restart needs on-chain reconciliation before that mint can be attempted again. Do not erase recovery state to bypass it.

## Validation

```sh
npm test
```

This checks JavaScript syntax, the standalone signal/rule tests, module imports, CLI behavior, and the Meteora PnL path with mocked data. Tests do not submit transactions.

## Legacy archive

The local **`legacy` branch** preserves the complete pre-cleanup snapshot at **`fd835b7`**, including the earlier LLM runtime in its history. The branch was advanced without rewriting any commits. No archive directory is loaded by the new application.

```sh
git show legacy:agent.js
git show legacy:tools/screening.js
git log legacy
```

The archive includes the old prompts/tool catalog, broad scanning, HiveMind and lesson evolution, LPAgent/Meridian relays, top-LPer studies, chart indicators, GMGN enrichment, Discord listener, Claude agent presets, and old setup/CLI. It has not been pushed automatically.
