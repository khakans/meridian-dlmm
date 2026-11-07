# Meridian

Standalone wallet-triggered Meteora DLMM bot for Solana. It waits for fresh LP entries by tracked wallets, screens the matching token, and manages positions with deterministic rules. No LLM or Meridian server is required.

## Flow

1. Watch tracked LP wallets through Solana WebSocket notifications, with signature backfill for missed events.
2. Count distinct wallets adding meaningful quote-side liquidity to the same **mint address**, across pools, within a rolling window (default: two wallets in 120 seconds).
3. Screen that mint and its eligible token/SOL pools using Meteora and Jupiter data and on-chain token checks.
4. Recheck exposure, price movement, balances, and transaction safety before entry. Failed screening waits within a bounded deadline.
5. Monitor positions independently and execute rule-based closes and fee claims.

Shadow mode is the default and forces `DRY_RUN=true` for all transaction paths. It records proposals without submitting them. Read [user-config.example.json](user-config.example.json) for supported settings. Monitoring and screening implementation details are in [standalone/](standalone/).

## Setup

Use Node.js 18 or newer and a Solana RPC provider supporting WebSocket subscriptions and transaction history.

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

The watchlist screens up to four unique mints per minute through the existing Jupiter, on-chain, and Meteora filters. Matches go to the configured Slack owner DM and Telegram notifications. Check the `discovery` and `discovery_warn` logs for screening results and provider errors. Discovery is advisory in both modes. Entry still requires wallet convergence.

Example mainnet RPC configuration. Replace the Helius placeholders with your endpoint key.

```dotenv
MONITOR_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
MONITOR_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
BALANCE_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
FALLBACK_RPC_URL=https://api.mainnet.solana.com
```

The public Solana HTTP endpoint is rate-limited. The HTTP fallback serves RPC reads. It does not replace the configured WebSocket subscription.

Set `researchEnabled: true` in Shadow mode to screen discovery candidates using the separate `researchMin*` settings and compare volatility-based Spot, wider Spot, Bid-Ask and Curve with experimental DAKUKERU Spot and Bid-Ask. The Fibonacci variant uses the strongest upward swing in the last 96 closed 15-minute candles and assumed 0.236–0.618 levels. Tokens with insufficient candle history still get the volatility variants. Plans are recorded per mint for 24 hours. They do not simulate fills, fees, or PnL. Actual entry continues to use wallet convergence and the configured shape.

Set `lifecycleReportMinutes` to a positive interval to send wallet balance, open positions and reported open-position PnL to the configured Slack DM and Telegram destination. A report also runs at startup. Edit the interval from the admin menu and restart. Zero disables reports.

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
