#!/usr/bin/env node
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LongLpPaperStrategy } from "./strategies/long-lp.mjs";
import { CryptoMakerPaperStrategy } from "./strategies/crypto-maker.mjs";
import { MarketRealtimeFeed } from "./realtime.mjs";

function parseArgs(argv) {
  const options = {
    duration: 1_200,
    poll: 5,
    total: 200,
    cryptoWindow: 15,
    lpActive: 60,
    cryptoActive: 30,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--duration") options.duration = Number(value);
    if (flag === "--poll") options.poll = Number(value);
    if (flag === "--total") options.total = Number(value);
    if (flag === "--crypto-window") options.cryptoWindow = Number(value);
    if (flag === "--lp-active") options.lpActive = Number(value);
    if (flag === "--crypto-active") options.cryptoActive = Number(value);
    if (flag.startsWith("--")) index += 1;
  }
  if (!(options.duration > 0) || !(options.poll >= 2) || !(options.total >= 20)) {
    throw new Error("Invalid arguments: duration > 0, poll >= 2, and total >= 20 are required");
  }
  if (![5, 15].includes(options.cryptoWindow)) {
    throw new Error("--crypto-window must be 5 or 15");
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function compact(snapshot) {
  return {
    strategy: snapshot.strategy,
    market: snapshot.market,
    equity: snapshot.equity,
    netPnl: snapshot.netPnl,
    fills: snapshot.fills,
    reward: snapshot.rewardsAccrued,
    rebate: snapshot.rebatesAccrued,
    secondsToEnd: snapshot.secondsToEnd,
  };
}

const options = parseArgs(process.argv.slice(2));
const perStrategyBudget = options.total / 2;
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runDirectory = resolve("runs", runId);
await mkdir(runDirectory, { recursive: true });
const eventsPath = resolve(runDirectory, "events.jsonl");
const summaryPath = resolve(runDirectory, "summary.json");

const metadata = {
  runId,
  mode: "paper-only",
  startedAt: new Date().toISOString(),
  options,
  allocation: {
    longLp: perStrategyBudget,
    cryptoMaker: perStrategyBudget,
  },
  safety: {
    authenticatedRequests: false,
    walletUsed: false,
    ordersSubmitted: false,
    allowedHttpMethod: "GET",
  },
};
await writeFile(resolve(runDirectory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

console.log(JSON.stringify({ status: "discovering", runDirectory, allocation: metadata.allocation }));
const [longLp, cryptoMaker] = await Promise.all([
  LongLpPaperStrategy.create({
    budget: perStrategyBudget,
    activeBudget: Math.min(options.lpActive, perStrategyBudget * 0.7),
  }),
  CryptoMakerPaperStrategy.create({
    budget: perStrategyBudget,
    activeBudget: Math.min(options.cryptoActive, perStrategyBudget * 0.4),
    windowMinutes: options.cryptoWindow,
  }),
]);
const strategies = [longLp, cryptoMaker];
const realtime = new MarketRealtimeFeed(strategies.flatMap((strategy) => strategy.market.tokenIds));
metadata.realtime = await realtime.connect();
await writeFile(resolve(runDirectory, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
const histories = new Map(strategies.map((strategy) => [strategy.name, []]));
let errors = 0;
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

for (const strategy of strategies) {
  const snapshot = await strategy.initialize({ realtime: true });
  histories.get(strategy.name).push(snapshot);
  await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...snapshot })}\n`);
  console.log(JSON.stringify({ status: "initialized", ...compact(snapshot) }));
}

const endsAt = Date.now() + options.duration * 1000;
let lastPrintedAt = 0;
while (!stopping && Date.now() < endsAt) {
  const tickStartedAt = Date.now();
  const results = await Promise.allSettled(
    strategies.map((strategy) => strategy.step({
      trades: realtime.drainTrades(strategy.market.conditionId),
    })),
  );
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status === "rejected") {
      errors += 1;
      const errorEvent = {
        at: new Date().toISOString(),
        strategy: strategies[index].name,
        event: "error",
        error: result.reason?.message ?? String(result.reason),
      };
      await appendFile(eventsPath, `${JSON.stringify(errorEvent)}\n`);
      console.error(JSON.stringify(errorEvent));
      continue;
    }
    const snapshot = result.value;
    const history = histories.get(snapshot.strategy);
    const previous = history.at(-1);
    history.push(snapshot);
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), ...snapshot })}\n`);
    const materiallyChanged =
      !previous || previous.fills !== snapshot.fills || previous.market !== snapshot.market;
    if (materiallyChanged || Date.now() - lastPrintedAt >= 30_000) {
      console.log(JSON.stringify({ status: "running", ...compact(snapshot) }));
    }
  }
  if (Date.now() - lastPrintedAt >= 30_000) lastPrintedAt = Date.now();
  const wait = Math.max(0, options.poll * 1000 - (Date.now() - tickStartedAt));
  if (wait > 0) await sleep(wait);
}

const completedAt = new Date().toISOString();
realtime.close();
const strategiesSummary = Object.fromEntries(
  [...histories.entries()].map(([name, history]) => {
    const first = history[0];
    const last = history.at(-1);
    const equities = history.map((snapshot) => snapshot.equity);
    return [name, {
      market: last.market,
      budget: last.budget,
      initialEquity: first.equity,
      finalEquity: last.equity,
      netPnl: last.netPnl,
      minimumEquity: Math.min(...equities),
      maximumEquity: Math.max(...equities),
      fills: last.fills,
      rewardsAccrued: last.rewardsAccrued ?? 0,
      rebatesAccrued: last.rebatesAccrued ?? 0,
      samples: history.length,
      finalState: {
        cash: last.cash,
        position: last.position,
        positions: last.positions,
        inventoryMark: last.inventoryMark,
        mergedSets: last.mergedSets,
        openBidSizes: last.openBidSizes,
        initialEstimatedRewardPerDay: last.initialEstimatedRewardPerDay,
        seedCost: last.seedCost,
        seedAveragePrice: last.seedAveragePrice,
        recentFills: last.recentFills,
      },
    }];
  }),
);
const summary = {
  ...metadata,
  completedAt,
  elapsedSeconds: Math.round((Date.now() - new Date(metadata.startedAt).getTime()) / 1000),
  errors,
  realtime: realtime.status(),
  strategies: strategiesSummary,
  combined: {
    budget: options.total,
    finalEquity: Object.values(strategiesSummary).reduce((sum, item) => sum + item.finalEquity, 0),
    netPnl: Object.values(strategiesSummary).reduce((sum, item) => sum + item.netPnl, 0),
  },
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ status: "complete", summaryPath, summary }));
