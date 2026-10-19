/**
 * dreamDEX Funding Rate Carry Bot
 *
 * Scans all perp markets on Somnia Tokyo testnet (Hideki, chain 50383),
 * opens a position on the side that collects funding when the annualised rate
 * clears MIN_FUNDING_APR, and closes when the rate reverses, drops below
 * EXIT_APR, or margin health falls below MIN_HEALTH.
 *
 * Closing uses closePosition() — a limit-reduce that requires no STT.
 * Hideki's 10 ms blocks mean fills land in under 1 s at normal spread.
 */

import { parseUnits, formatUnits } from "viem";
import {
  createExchange,
  loadConfig,
  perpMarkets,
  placePerp,
  sizeOrder,
  closePosition,
  positionIn,
  alignPrice,
  markOf,
  liveMark,
  healthRatio,
  marginSnapshot,
  preflight,
  type PerpContext,
  type PerpMarket,
  ORDER_TYPE,
} from "../../dreamdex-bot-kit/packages/perp-core/src/index.js";
import {
  liveFunding,
} from "../../dreamdex-bot-kit/packages/perp-core/src/funding.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MIN_FUNDING_APR = Number(process.env.MIN_FUNDING_APR ?? "0.10"); // 10% APR
const EXIT_APR        = Number(process.env.EXIT_APR        ?? "0.02"); // 2% APR
const NOTIONAL_USD    = Number(process.env.NOTIONAL_USD    ?? "50");
const LEVERAGE        = Number(process.env.LEVERAGE        ?? "3");
const POLL_MS         = Number(process.env.POLL_MS         ?? "15000");
const MIN_HEALTH      = Number(process.env.MIN_HEALTH      ?? "1.20");
const SLIP_BPS        = 10n; // 0.10% entry slippage

// ── State ─────────────────────────────────────────────────────────────────────

interface HeldPosition {
  market: PerpMarket;
  side: "long" | "short";
  quantity: bigint;
  entryApr: number;
  openedAt: number;
}

let active: HeldPosition | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function aprPct(apr: number) {
  return `${(apr * 100).toFixed(2)}%`;
}

function entryPrice(mark: bigint, side: "long" | "short"): bigint {
  return side === "long"
    ? (mark * (10_000n + SLIP_BPS)) / 10_000n
    : (mark * (10_000n - SLIP_BPS)) / 10_000n;
}

// ── Core loop ─────────────────────────────────────────────────────────────────

async function scan(ctx: PerpContext) {
  const account = ctx.exchange.walletAddress as `0x${string}`;
  const markets  = await perpMarkets(ctx.exchange, /* reload */ true);

  // ── 1. Guard open position ──────────────────────────────────────────────────
  if (active) {
    const refresh = markets.find(m => m.symbol === active!.market.symbol);
    if (!refresh) {
      log(`Market ${active.market.display} delisted — closing`);
      await close(ctx);
      return;
    }

    // Margin health check
    const snap   = await marginSnapshot(ctx.exchange, refresh, account);
    const health = healthRatio(snap);
    if (health < MIN_HEALTH) {
      log(`⚠ Health ${health.toFixed(2)} below ${MIN_HEALTH} on ${active.market.display} — closing`);
      await close(ctx);
      return;
    }

    // Funding exit check
    const funding = await liveFunding(ctx.exchange, refresh);
    const currentApr  = Math.abs(funding.apr);
    const correctSide = funding.paidSide === active.side;

    if (!correctSide || currentApr < EXIT_APR) {
      log(
        `Exiting ${active.market.display} ${active.side}: ` +
        `apr=${aprPct(currentApr)} paidSide=${funding.paidSide} threshold=${aprPct(EXIT_APR)}`
      );
      await close(ctx);
      return;
    }

    log(
      `Holding ${active.market.display} ${active.side} | ` +
      `apr=${aprPct(currentApr)} entry=${aprPct(active.entryApr)} ` +
      `health=${health.toFixed(2)} age=${Math.round((Date.now() - active.openedAt) / 1000)}s`
    );
    return;
  }

  // ── 2. Find best carry opportunity ─────────────────────────────────────────
  const candidates = await Promise.all(
    markets.map(async m => ({
      market: m,
      funding: await liveFunding(ctx.exchange, m),
    }))
  );

  const best = candidates
    .filter(c => c.funding.known && Math.abs(c.funding.apr) >= MIN_FUNDING_APR)
    .sort((a, b) => Math.abs(b.funding.apr) - Math.abs(a.funding.apr))[0];

  if (!best) {
    const rates = candidates
      .filter(c => c.funding.known)
      .map(c => `${c.market.display}=${aprPct(Math.abs(c.funding.apr))}`)
      .join("  ");
    log(`No market cleared ${aprPct(MIN_FUNDING_APR)}. Rates: ${rates || "none"}`);
    return;
  }

  const { market, funding } = best;
  const side = funding.paidSide as "long" | "short";
  log(`Opening ${market.display} ${side} | apr=${aprPct(Math.abs(funding.apr))} notional=$${NOTIONAL_USD}`);
  await open(ctx, market, side, Math.abs(funding.apr));
}

async function open(ctx: PerpContext, market: PerpMarket, side: "long" | "short", apr: number) {
  try {
    const account = ctx.exchange.walletAddress as `0x${string}`;

    // preflight checks the MarginBank has collateral
    await preflight(ctx.exchange, market, account);

    const liveMarkNum = await liveMark(ctx.exchange, market);
    const markNum = liveMarkNum ?? Number(markOf(market));
    const markBig = BigInt(Math.round(markNum * 1e18));

    const wanted = parseUnits(
      String((NOTIONAL_USD * LEVERAGE) / markNum),
      market.info.baseDecimals
    );
    const price = entryPrice(markBig, side);

    const sizing = await sizeOrder(ctx.exchange, {
      market,
      account,
      side,
      price,
      wanted,
      autoPull: true,
    });

    if (!sizing.ok) {
      log(`Cannot size ${market.display}: ${sizing.reason}`);
      return;
    }

    const result = await placePerp({
      ctx,
      market,
      side,
      price,
      quantity: sizing.quantity,
      orderType: ORDER_TYPE.LIMIT,
      label: "carry-open",
    });

    if (!result.sent) {
      log(`Order not sent for ${market.display} (dry-run or no fill)`);
      return;
    }

    log(
      `Opened ${market.display} ${side} ` +
      `qty=${formatUnits(sizing.quantity, market.info.baseDecimals)} ` +
      `orderId=${result.orderId ?? "-"}`
    );
    active = { market, side, quantity: sizing.quantity, entryApr: apr, openedAt: Date.now() };
  } catch (err) {
    log(`Open failed on ${market.display}: ${err}`);
  }
}

async function close(ctx: PerpContext) {
  if (!active) return;
  const { market, side } = active;
  active = null; // clear before await so a second close call doesn't race
  try {
    const account = ctx.exchange.walletAddress as `0x${string}`;
    const result  = await closePosition(ctx, market, account, { label: "carry-close" });
    if (result.sent) {
      log(`Closed ${market.display} ${side} filled=${formatUnits(result.filled, market.info.baseDecimals)}`);
    } else {
      log(`Close not sent for ${market.display} — market may be un-priceable, check manually`);
    }
  } catch (err) {
    log(`Close failed on ${market.display}: ${err}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const ctx    = createExchange({ withSigner: true });

  log("dreamDEX Funding Rate Carry Bot");
  log(`Network  : ${config.network}`);
  log(`Account  : ${ctx.exchange.walletAddress}`);
  log(`Strategy : MIN_APR=${aprPct(MIN_FUNDING_APR)}  EXIT_APR=${aprPct(EXIT_APR)}  HEALTH=${MIN_HEALTH}`);
  log(`Sizing   : $${NOTIONAL_USD} notional × ${LEVERAGE}x leverage  Poll: ${POLL_MS}ms`);

  await scan(ctx);
  const timer = setInterval(() => scan(ctx).catch(e => log(`scan error: ${e}`)), POLL_MS);

  process.on("SIGINT",  async () => { clearInterval(timer); await close(ctx); process.exit(0); });
  process.on("SIGTERM", async () => { clearInterval(timer); await close(ctx); process.exit(0); });
}

main().catch(err => { console.error(err); process.exit(1); });
