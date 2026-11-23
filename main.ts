// btc-race-24h — a cbBTC/USDC trend bot for agent-fun/bars-replay/v1.
//
// The hello message carries the universe, the capital, the caps and the fees.
// Each batch carries one bar (the minute that just closed), the fills of the
// orders sent on the previous batch, and the account. The bot answers every
// batch with exactly one reply echoing its seq, carrying zero or one order.
//
// Strategy: dual-momentum trend following, long only, one position at a time.
//   * Enter (all cash) when BOTH the 60-bar return is at least +80 bps AND
//     the 240-bar return is at least +120 bps: a genuine multi-hour uptrend,
//     not a one-minute blip. A cooldown of 180 bars after any exit keeps the
//     bot out of chop.
//   * Exit on a trailing stop (200 bps below the highest close since entry)
//     or when the 60-bar return turns to -60 bps (momentum reversal).
//   * Late probe: if the bot has still made no trade by bar 1200, it buys
//     25% of cash once. A flat-to-drifting window may never trigger the
//     trend entry; the probe guarantees at least one real trade (the
//     guardrail needs one) at small, bounded cost.
// Every round trip costs ~26 bps in fee, slippage and pool impact, so the
// entry thresholds are set well above that. No wall clock, no randomness,
// no network, no files: every decision is a pure function of the bars seen,
// so two runs on the same data produce byte-identical action logs.

const SYMBOL = "CBBTC";

// Strategy parameters (basis points and bar counts).
const SHORT_LOOKBACK = 60;
const SHORT_ENTRY_BPS = 80;
const LONG_LOOKBACK = 240;
const LONG_ENTRY_BPS = 120;
const TRAIL_BPS = 200;
const REVERSAL_BPS = -60;
const COOLDOWN_BARS = 180;
const PROBE_BAR = 1200;
const PROBE_CASH_BPS = 2500; // 25% of cash
const MAX_SLIPPAGE_BPS = 300;
const MIN_NOTIONAL_UNITS = 1000000n; // 1 USDC in quote units

type Order = {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

// Runtime state, all derived from the hello message and the batches.
let priceScale = 5;
let qtyScale = 8;
let quoteScale = 6;
let warmupBars = 0;
let cash = 0n;
let positionQty = 0n;
let closes: number[] = [];
let batchIndex = 0;
let orderCounter = 0;
let fillsSeen = 0;
let lastSellBar = -1000000;
let entryClose = 0;
let peakClose = 0;
let wasInPosition = false;
let lastBuyFillPrice = 0;

function returnBps(now: number, back: number): number {
  if (closes.length <= back) return 0;
  const then = closes[closes.length - 1 - back];
  if (then <= 0) return 0;
  return ((now - then) / then) * 10000;
}

function decide(): Order[] {
  const orders: Order[] = [];
  if (batchIndex < warmupBars) return orders;
  if (closes.length === 0) return orders;
  const close = closes[closes.length - 1];
  const inPosition = positionQty > 0n;

  if (!inPosition) {
    const shortRet = returnBps(close, SHORT_LOOKBACK);
    const longRet = returnBps(close, LONG_LOOKBACK);
    const cooledDown = batchIndex - lastSellBar > COOLDOWN_BARS;
    if (
      closes.length > LONG_LOOKBACK &&
      shortRet >= SHORT_ENTRY_BPS &&
      longRet >= LONG_ENTRY_BPS &&
      cooledDown &&
      cash >= MIN_NOTIONAL_UNITS
    ) {
      orderCounter += 1;
      orders.push({
        side: "buy",
        client_id: `buy-${orderCounter}`,
        symbol: SYMBOL,
        notional_quote_units: cash.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      return orders;
    }
    // Late probe: no trade yet and the window is almost over.
    if (fillsSeen === 0 && batchIndex >= PROBE_BAR && cash >= MIN_NOTIONAL_UNITS) {
      const notional = (cash * BigInt(PROBE_CASH_BPS)) / 10000n;
      if (notional >= MIN_NOTIONAL_UNITS) {
        orderCounter += 1;
        orders.push({
          side: "buy",
          client_id: `probe-${orderCounter}`,
          symbol: SYMBOL,
          notional_quote_units: notional.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
    return orders;
  }

  // In a position: update the peak and check the exits.
  if (close > peakClose) peakClose = close;
  const drawdownBps = peakClose > 0 ? ((peakClose - close) / peakClose) * 10000 : 0;
  const shortRet = returnBps(close, SHORT_LOOKBACK);
  if (drawdownBps >= TRAIL_BPS || shortRet <= REVERSAL_BPS) {
    orderCounter += 1;
    orders.push({
      side: "sell",
      client_id: `sell-${orderCounter}`,
      symbol: SYMBOL,
      qty: positionQty.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    lastSellBar = batchIndex;
  }
  return orders;
}

function handleMessage(msg: any): void {
  if (msg.type === "hello") {
    const sym = (msg.symbols && msg.symbols[0]) || {};
    if (typeof sym.price_scale === "number") priceScale = sym.price_scale;
    if (typeof sym.qty_scale === "number") qtyScale = sym.qty_scale;
    if (msg.capital && typeof msg.capital.quote_scale === "number") {
      quoteScale = msg.capital.quote_scale;
    }
    if (typeof msg.warmup_bars === "number") warmupBars = msg.warmup_bars;
    if (msg.capital && typeof msg.capital.quote_units === "string") {
      cash = BigInt(msg.capital.quote_units);
    }
    return;
  }
  if (msg.type === "done") {
    process.exit(0);
  }
  if (msg.type !== "batch") return;

  batchIndex += 1;
  const seq = typeof msg.seq === "number" ? msg.seq : 0;

  // Count our own fills (the harness's own flatten fills start with "_"),
  // and remember the latest buy fill price: the peak of a new position
  // starts at what the fill actually paid, not at the next bar's close.
  if (Array.isArray(msg.fills)) {
    for (const f of msg.fills) {
      if (
        f.status === "filled" &&
        typeof f.client_id === "string" &&
        !f.client_id.startsWith("_")
      ) {
        fillsSeen += 1;
        if (f.side === "buy" && typeof f.price === "string") {
          lastBuyFillPrice = Number(f.price) / Math.pow(10, priceScale);
        }
      }
    }
  }

  // Authoritative account state for this batch.
  if (msg.account) {
    if (typeof msg.account.cash_quote_units === "string") {
      cash = BigInt(msg.account.cash_quote_units);
    }
    positionQty = 0n;
    if (Array.isArray(msg.account.positions)) {
      for (const p of msg.account.positions) {
        if (p.symbol === SYMBOL && typeof p.qty === "string") {
          positionQty = BigInt(p.qty);
        }
      }
    }
  }

  // Record this batch's bar close (price in USDC, from its integer units).
  if (Array.isArray(msg.bars)) {
    for (const b of msg.bars) {
      if (b.symbol === SYMBOL && typeof b.c === "string") {
        const raw = Number(b.c);
        closes.push(raw / Math.pow(10, priceScale));
      }
    }
  }

  // Track entry and peak from the position itself, so a rejected order
  // never leaves the bot believing it holds something it does not.
  const inPosition = positionQty > 0n;
  if (inPosition && !wasInPosition && closes.length > 0) {
    entryClose =
      lastBuyFillPrice > 0 ? lastBuyFillPrice : closes[closes.length - 1];
    peakClose = Math.max(entryClose, closes[closes.length - 1]);
  }
  if (!inPosition) {
    entryClose = 0;
    peakClose = 0;
  }
  wasInPosition = inPosition;

  const orders = decide();
  const reply = { type: "reply", seq, orders };
  process.stdout.write(JSON.stringify(reply) + "\n");
}

// Read newline-delimited JSON from stdin, one line at a time.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line.length > 0) {
      try {
        handleMessage(JSON.parse(line));
      } catch {
        // A malformed line is never expected from the harness; stay alive
        // and keep answering later batches rather than crashing the run.
      }
    }
    idx = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (buffer.trim().length > 0) {
    try {
      handleMessage(JSON.parse(buffer.trim()));
    } catch {
      // ignore a trailing partial line
    }
  }
});
