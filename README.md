# dreamDEX Funding Rate Carry Bot

A fully automated funding rate carry bot for dreamDEX perpetuals on **Somnia Tokyo testnet** (chain 50383, Hideki).

## What it does

1. Scans all active perp markets every 15 s and reads the live funding rate from each pool contract directly (not the cached indexer row).
2. When any market's annualised funding rate clears the `MIN_FUNDING_APR` threshold (default 10%), it opens a position on the **paid side** — the side that collects funding.
3. Holds the position and checks two exit conditions each poll:
   - Funding rate drops below `EXIT_APR` (2%) or flips direction.
   - Mark price comes within `MAX_LIQ_BUFFER` (15%) of the liquidation price.
4. Closes with a **limit-reduce order** (no STT required — avoids the undocumented stop-order STT requirement).

Hideki's 10 ms block time means limit orders fill in under 1 s at normal spread.

## Who it is for

DeFi traders and bot builders who want to harvest funding on dreamDEX perps without manual monitoring. The bot handles market selection, position sizing, and risk management automatically.

## How to run

**Prerequisites:** Node 20+, a funded dreamDEX testnet account (paper USDso via Perps Arena).

```bash
git clone https://github.com/forumevi/dreamdex-funding-bot
cd dreamdex-funding-bot

# Copy and fill in your keys
cp env.example .env
# Set PRIVATE_KEY and optionally OWNER_ADDRESS in .env

# Install dependencies (includes dreamDEX bot-kit perp-core as a local dep)
npm install

# Start the bot
npm start
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `NETWORK` | `hideki` | `hideki` = Tokyo testnet (chain 50383) |
| `PRIVATE_KEY` | — | Wallet or bot key |
| `OWNER_ADDRESS` | — | Trading-key mode: the linked DreamDEX account |
| `MIN_FUNDING_APR` | `0.10` | Minimum annualised rate to open (10%) |
| `EXIT_APR` | `0.02` | Exit when rate drops below (2%) |
| `NOTIONAL_USD` | `50` | USD notional per trade (before leverage) |
| `LEVERAGE` | `3` | Leverage multiplier |
| `POLL_MS` | `15000` | Scan interval in milliseconds |
| `MAX_LIQ_BUFFER` | `0.15` | Emergency close within 15% of liquidation price |

## X posts

- https://x.com/0xReddawn/status/2112303197800763680
- https://x.com/0xReddawn/status/2112303494317170814
- https://x.com/0xReddawn/status/2112303924011049010

## Live orders on Somnia Tokyo testnet

BTC-PERP short placed on Somnia Tokyo testnet (Hideki, chain 50383) via `app.testnet.dreamdex.io` Perps Arena. Account: `0xB7F7e388c55f1fA0d553F8Dc1503D260Cc0129f8`.

- `0xcf78b3671ffb4fe3e89ada4230773e10023117b3c3705d3959e2a0ccad02f86b`

Explorer: https://smk-dev-markets-explorer-hideki-euw4-uzavbo36ra-ez.a.run.app/tx/0xcf78b3671ffb4fe3e89ada4230773e10023117b3c3705d3959e2a0ccad02f86b

The bot identified BTC-PERP funding at 132% APR and selected the short side. Note: during the Perps Arena competition period, USDso deposits are paused ("Temporarily paused for the competition"), so the bot runs in dry-run mode against the live feed and orders are placed manually via the app interface.

## Environment

- Network: Somnia Tokyo testnet (chain 50383, Hideki)
- SDK: `@somnia-chain/markets-sdk` via dreamDEX bot-kit `perp-core`
- Bot kit commit: 2579866

## License

MIT
