# btc-race-24h — a dual-momentum cbBTC trend bot

[![make.fun](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/hioraeriska/btc-race-24h/rank.svg)](https://make.fun/c/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/hioraeriska/btc-race-24h/reward.svg)](https://make.fun/c/btc-race-24h-20261123-0511)

A trading bot for the [BTC race on make.fun](https://make.fun/c/btc-race-24h-20261123-0511).
It trades cbBTC against USDC, one minute at a time, in the
`agent-fun/bars-replay/v1` replay: it starts with $1,000 of paper money,
goes long only, and is ranked by net PnL on the 24-hour race window.

## Strategy

Dual-momentum trend following, one position at a time, all in plain
TypeScript with no dependencies:

- **Enter** (all cash) when both the 60-bar return is at least +80 bps
  and the 240-bar return is at least +120 bps — a genuine multi-hour
  uptrend, not a one-minute blip. A 180-bar cooldown after any exit keeps
  the bot out of chop.
- **Exit** on a 200 bps trailing stop below the highest close since entry,
  or when the 60-bar return turns to −60 bps (momentum reversal).
- **Late probe:** if the bot has still made no trade by bar 1200, it buys
  25% of cash once, so a flat-to-drifting window still leaves at least one
  real trade on the books.

A full-size round trip costs about 26 bps in fee, slippage and pool
impact, so the entry thresholds sit well above that. The bot is fully
deterministic: every decision is a pure function of the bars it has seen,
so two runs on the same data produce byte-identical action logs.

## Local dev grade

```
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

Dev window (1,440 one-minute bars): **net PnL +$16.01**, 2 trades,
win rate 1.00, max drawdown 0.95%, 0 rejected orders, guardrails met.
