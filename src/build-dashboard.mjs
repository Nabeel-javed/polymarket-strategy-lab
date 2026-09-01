#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const statePath = resolve(process.argv[2] ?? "experiment/state.json");
const outputPath = resolve(process.argv[3] ?? "docs/data.json");
const state = JSON.parse(await readFile(statePath, "utf8"));
const allocation = state.configuration.allocation;
const longLp = state.longLp.latest;
const activeCrypto = state.crypto.activeStats?.last ?? null;
const cryptoEquity = state.configuration.lpOnly
  ? 0
  : activeCrypto?.equity ?? state.crypto.portfolioValue;
const combinedEquity = (longLp?.equity ?? allocation.longLp) + cryptoEquity;
const cryptoPnl = cryptoEquity - allocation.cryptoMaker;
const lpPnl = (longLp?.equity ?? allocation.longLp) - allocation.longLp;

const dashboard = {
  generatedAt: new Date().toISOString(),
  status: state.status,
  startedAt: state.startedAt,
  endsAt: state.endsAt,
  completedAt: state.completedAt,
  mode: state.mode,
  configuration: state.configuration,
  safety: state.safety,
  totals: {
    startingCapital: state.configuration.total,
    currentEquity: combinedEquity,
    netPnl: combinedEquity - state.configuration.total,
  },
  longLp: {
    allocation: allocation.longLp,
    currentEquity: longLp?.equity ?? allocation.longLp,
    netPnl: lpPnl,
    minimumEquity: state.longLp.minimumEquity,
    maximumEquity: state.longLp.maximumEquity,
    market: longLp?.market ?? null,
    rewardsAccrued: longLp?.rewardsAccrued ?? 0,
    rewardsPaid: longLp?.rewardsPaid ?? 0,
    pendingRewardEstimate: longLp?.pendingRewardEstimate ?? 0,
    forfeitedRewardEstimate: longLp?.forfeitedRewardEstimate ?? 0,
    grossRewardEstimate: longLp?.grossRewardEstimate ?? 0,
    rewardMinimumPayout: longLp?.rewardMinimumPayout ?? 1,
    rebatesAccrued: longLp?.rebatesAccrued ?? 0,
    fills: longLp?.fills ?? 0,
    quoteRefreshes: longLp?.quoteRefreshes ?? 0,
    bidRemaining: longLp?.bidRemaining ?? 0,
    askRemaining: longLp?.askRemaining ?? 0,
    bid: longLp?.bid ?? 0,
    ask: longLp?.ask ?? 0,
    dailyPool: longLp?.dailyPool ?? 0,
    initialEstimatedRewardPerDay: longLp?.initialEstimatedRewardPerDay ?? 0,
    seedCost: longLp?.seedCost ?? 0,
    seedTotalCost: longLp?.seedTotalCost ?? longLp?.seedCost ?? 0,
    seedAveragePrice: longLp?.seedAveragePrice ?? 0,
    takerFeesPaid: longLp?.takerFeesPaid ?? 0,
    latest: longLp,
  },
  crypto: {
    allocation: allocation.cryptoMaker,
    currentEquity: cryptoEquity,
    netPnl: cryptoPnl,
    marketsCompleted: state.crypto.markets.length,
    profitableMarkets: state.crypto.markets.filter((market) => market.netPnl > 0).length,
    losingMarkets: state.crypto.markets.filter((market) => market.netPnl < 0).length,
    totalFills: state.crypto.markets.reduce((sum, market) => sum + market.fills, 0) + (activeCrypto?.fills ?? 0),
    totalRebates: state.crypto.markets.reduce((sum, market) => sum + market.rebatesAccrued, 0) + (activeCrypto?.rebatesAccrued ?? 0),
    activeMarket: activeCrypto,
    markets: state.crypto.markets,
  },
  samples: state.samples,
  segments: state.segments,
  limitations: [
    "No real orders are placed, so LP rewards are estimated from visible competition rather than paid by Polymarket.",
    "A daily reward estimate below Polymarket's $1 minimum is tracked as pending and then forfeited, never counted as equity.",
    "Simulated maker fills use public trade messages and visible queue depth; private queue identity is unavailable.",
    "When a reward-eligible leg is depleted, both quotes rejoin the back of the visible queue before rewards resume.",
    "Short gaps can occur while GitHub starts the next hosted runner.",
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(dashboard, null, 2)}\n`);
console.log(JSON.stringify({ status: "dashboard-built", outputPath }));
