#!/usr/bin/env node
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LongLpPaperStrategy } from "./strategies/long-lp.mjs";
import { CryptoMakerPaperStrategy } from "./strategies/crypto-maker.mjs";
import { MarketRealtimeFeed } from "./realtime.mjs";

function parseArgs(argv) {
  const options = {
    state: "experiment/state.json",
    days: 7,
    segmentDuration: 19_800,
    poll: 10,
    sample: 300,
    total: 200,
    lpActive: 60,
    cryptoActive: 30,
    cryptoWindow: 15,
    reset: false,
    checkpointAtTarget: false,
    lpOnly: false,
    maintainLpQuotes: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--reset") {
      options.reset = true;
      continue;
    }
    if (flag === "--checkpoint-at-target") {
      options.checkpointAtTarget = true;
      continue;
    }
    if (flag === "--lp-only") {
      options.lpOnly = true;
      continue;
    }
    if (flag === "--maintain-lp-quotes") {
      options.maintainLpQuotes = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--state") options.state = value;
    if (flag === "--days") options.days = Number(value);
    if (flag === "--segment-duration") options.segmentDuration = Number(value);
    if (flag === "--poll") options.poll = Number(value);
    if (flag === "--sample") options.sample = Number(value);
    if (flag === "--total") options.total = Number(value);
    if (flag === "--lp-active") options.lpActive = Number(value);
    if (flag === "--crypto-active") options.cryptoActive = Number(value);
    if (flag === "--crypto-window") options.cryptoWindow = Number(value);
    if (flag.startsWith("--")) index += 1;
  }
  if (
    !(options.days > 0) ||
    !(options.segmentDuration > 0) ||
    !(options.poll >= 5) ||
    !(options.sample >= options.poll) ||
    !(options.total >= 20) ||
    ![5, 15].includes(options.cryptoWindow)
  ) {
    throw new Error("Invalid week-runner arguments");
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

function newExperiment(options) {
  const startedAt = new Date();
  const allocation = options.lpOnly
    ? { longLp: options.total, cryptoMaker: 0 }
    : { longLp: options.total / 2, cryptoMaker: options.total / 2 };
  return {
    version: 1,
    mode: "paper-only",
    status: "active",
    startedAt: startedAt.toISOString(),
    endsAt: new Date(startedAt.getTime() + options.days * 86_400_000).toISOString(),
    completedAt: null,
    configuration: {
      total: options.total,
      allocation,
      lpOnly: options.lpOnly,
      maintainLpQuotes: options.maintainLpQuotes,
      maximumCheapPrice: 0.05,
      lpActive: Math.min(options.lpActive, allocation.longLp * 0.7),
      cryptoActive: Math.min(options.cryptoActive, allocation.cryptoMaker * 0.4),
      cryptoWindow: options.cryptoWindow,
      pollSeconds: options.poll,
      sampleSeconds: options.sample,
    },
    safety: {
      authenticatedRequests: false,
      walletUsed: false,
      ordersSubmitted: false,
      allowedHttpMethod: "GET",
    },
    longLp: {
      checkpoint: null,
      latest: null,
      minimumEquity: allocation.longLp,
      maximumEquity: allocation.longLp,
    },
    crypto: {
      portfolioValue: allocation.cryptoMaker,
      active: null,
      activeStats: null,
      markets: [],
      launchErrors: 0,
    },
    samples: [],
    segments: [],
  };
}

function updateRange(container, equity) {
  container.minimumEquity = Math.min(container.minimumEquity, equity);
  container.maximumEquity = Math.max(container.maximumEquity, equity);
}

function cycleStats(snapshot, prior = null) {
  return {
    startedAt: prior?.startedAt ?? new Date().toISOString(),
    minimumEquity: Math.min(prior?.minimumEquity ?? snapshot.equity, snapshot.equity),
    maximumEquity: Math.max(prior?.maximumEquity ?? snapshot.equity, snapshot.equity),
    last: snapshot,
  };
}

const options = parseArgs(process.argv.slice(2));
const statePath = resolve(options.state);
let state = options.reset ? null : await readJson(statePath);
if (state?.status === "completed") {
  console.log(JSON.stringify({ status: "already-completed", statePath, completedAt: state.completedAt }));
  process.exit(0);
}
if (!state) state = newExperiment(options);
if (state.version !== 1 || state.mode !== "paper-only") throw new Error("Unsupported experiment state");

const segmentStartedAt = new Date();
const segmentId = segmentStartedAt.toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runDirectory = resolve("runs", `week-${segmentId}`);
await mkdir(runDirectory, { recursive: true });
const eventsPath = resolve(runDirectory, "events.jsonl");
const summaryPath = resolve(runDirectory, "summary.json");
const experimentEndsAtMs = new Date(state.endsAt).getTime();
const targetEndsAtMs = Math.min(
  segmentStartedAt.getTime() + options.segmentDuration * 1000,
  experimentEndsAtMs,
);
const hardEndsAtMs = segmentStartedAt.getTime() + (options.segmentDuration + 1_200) * 1000;
let stopping = false;
let errors = 0;
let nextCryptoAttemptAt = 0;
let lastSampleAt = 0;
let lpSnapshot;
let cryptoSnapshot = state.crypto.activeStats?.last ?? null;

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

const allocation = state.configuration.allocation;
const longLp = state.longLp.checkpoint
  ? await LongLpPaperStrategy.restore(state.longLp.checkpoint)
  : await LongLpPaperStrategy.create({
      budget: allocation.longLp,
      activeBudget: state.configuration.lpActive,
      maximumCheapPrice: state.configuration.maximumCheapPrice,
      maintainQuotes: state.configuration.maintainLpQuotes,
    });
longLp.maintainQuotes = Boolean(state.configuration.maintainLpQuotes);
lpSnapshot = await longLp.initialize({ realtime: true });
state.longLp.latest = lpSnapshot;

let activeCrypto = state.crypto.active
  ? await CryptoMakerPaperStrategy.restore(state.crypto.active)
  : null;
if (activeCrypto) cryptoSnapshot = await activeCrypto.initialize({ realtime: true });

let lpFeed = null;
let cryptoFeed = null;

async function connectLpFeed() {
  lpFeed?.close();
  lpFeed = new MarketRealtimeFeed(longLp.market.tokenIds);
  await lpFeed.connect();
  await longLp.initialize({ realtime: true });
}

async function connectCryptoFeed() {
  cryptoFeed?.close();
  if (!activeCrypto) {
    cryptoFeed = null;
    return;
  }
  cryptoFeed = new MarketRealtimeFeed(activeCrypto.market.tokenIds);
  await cryptoFeed.connect();
  cryptoSnapshot = await activeCrypto.initialize({ realtime: true });
  state.crypto.activeStats = cycleStats(cryptoSnapshot, state.crypto.activeStats);
}

async function launchCrypto() {
  if (state.configuration.lpOnly) return;
  if (activeCrypto || Date.now() >= targetEndsAtMs || Date.now() >= experimentEndsAtMs) return;
  if (state.crypto.portfolioValue < 20) return;
  activeCrypto = await CryptoMakerPaperStrategy.create({
    budget: state.crypto.portfolioValue,
    activeBudget: Math.min(
      state.configuration.cryptoActive,
      state.crypto.portfolioValue * 0.4,
    ),
    windowMinutes: state.configuration.cryptoWindow,
  });
  state.crypto.activeStats = null;
  await connectCryptoFeed();
  await appendFile(eventsPath, `${JSON.stringify({
    at: new Date().toISOString(),
    event: "crypto_market_started",
    market: activeCrypto.market.question,
    conditionId: activeCrypto.market.conditionId,
    budget: activeCrypto.budget,
  })}\n`);
}

function finalizeCrypto(snapshot) {
  const stats = state.crypto.activeStats ?? cycleStats(snapshot);
  const result = {
    market: snapshot.market,
    conditionId: snapshot.conditionId,
    startedAt: stats.startedAt,
    completedAt: new Date().toISOString(),
    startingEquity: activeCrypto.budget,
    finalEquity: snapshot.equity,
    netPnl: round(snapshot.equity - activeCrypto.budget),
    minimumEquity: stats.minimumEquity,
    maximumEquity: stats.maximumEquity,
    fills: snapshot.fills,
    rebatesAccrued: snapshot.rebatesAccrued,
    mergedSets: snapshot.mergedSets,
    winningOutcome: snapshot.winningOutcome,
  };
  state.crypto.markets.push(result);
  state.crypto.portfolioValue = snapshot.equity;
  state.crypto.active = null;
  state.crypto.activeStats = null;
  activeCrypto = null;
  cryptoSnapshot = null;
  cryptoFeed?.close();
  cryptoFeed = null;
  return result;
}

await connectLpFeed();
if (activeCrypto) await connectCryptoFeed();

console.log(JSON.stringify({
  status: "segment-started",
  segmentId,
  statePath,
  experimentStartedAt: state.startedAt,
  experimentEndsAt: state.endsAt,
  targetEndsAt: new Date(targetEndsAtMs).toISOString(),
  restored: Boolean(state.longLp.checkpoint),
}));

while (!stopping && Date.now() < hardEndsAtMs) {
  const tickStartedAt = Date.now();
  const finishing = tickStartedAt >= targetEndsAtMs || tickStartedAt >= experimentEndsAtMs;

  if (!lpFeed?.connected) {
    try {
      await connectLpFeed();
    } catch (error) {
      errors += 1;
      await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event: "lp_feed_error", error: error.message })}\n`);
    }
  }

  if (!activeCrypto && !finishing && tickStartedAt >= nextCryptoAttemptAt) {
    try {
      await launchCrypto();
    } catch (error) {
      errors += 1;
      state.crypto.launchErrors += 1;
      nextCryptoAttemptAt = Date.now() + 30_000;
      await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event: "crypto_launch_error", error: error.message })}\n`);
    }
  }

  if (activeCrypto && !cryptoFeed?.connected) {
    try {
      await connectCryptoFeed();
    } catch (error) {
      errors += 1;
      await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event: "crypto_feed_error", error: error.message })}\n`);
    }
  }

  const [lpResult, cryptoResult] = await Promise.allSettled([
    longLp.step({ trades: lpFeed?.drainTrades(longLp.market.conditionId) ?? [] }),
    activeCrypto
      ? activeCrypto.step({ trades: cryptoFeed?.drainTrades(activeCrypto.market.conditionId) ?? [] })
      : Promise.resolve(null),
  ]);

  if (lpResult.status === "fulfilled") {
    lpSnapshot = lpResult.value;
    state.longLp.latest = lpSnapshot;
    updateRange(state.longLp, lpSnapshot.equity);
  } else {
    errors += 1;
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event: "lp_step_error", error: lpResult.reason?.message ?? String(lpResult.reason) })}\n`);
  }

  if (cryptoResult.status === "fulfilled" && cryptoResult.value) {
    cryptoSnapshot = cryptoResult.value;
    state.crypto.activeStats = cycleStats(cryptoSnapshot, state.crypto.activeStats);
    if (cryptoSnapshot.resolved) {
      const finalized = finalizeCrypto(cryptoSnapshot);
      await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event: "crypto_market_finalized", ...finalized })}\n`);
    }
  } else if (cryptoResult.status === "rejected") {
    errors += 1;
    await appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), event: "crypto_step_error", error: cryptoResult.reason?.message ?? String(cryptoResult.reason) })}\n`);
  }

  if (tickStartedAt - lastSampleAt >= options.sample * 1000) {
    const cryptoEquity = state.configuration.lpOnly
      ? 0
      : cryptoSnapshot?.equity ?? state.crypto.portfolioValue;
    const sample = {
      at: new Date().toISOString(),
      longLpEquity: lpSnapshot.equity,
      cryptoEquity,
      combinedEquity: round(lpSnapshot.equity + cryptoEquity),
      longLpRewards: lpSnapshot.rewardsAccrued,
      cryptoMarkets: state.crypto.markets.length,
      cryptoFills: state.crypto.markets.reduce((sum, market) => sum + market.fills, 0) + (cryptoSnapshot?.fills ?? 0),
    };
    state.samples.push(sample);
    lastSampleAt = tickStartedAt;
    await appendFile(eventsPath, `${JSON.stringify({ event: "sample", ...sample })}\n`);
    console.log(JSON.stringify({ status: "running", ...sample }));
  }

  if (finishing && (!activeCrypto || options.checkpointAtTarget)) break;
  const waitMs = Math.max(0, options.poll * 1000 - (Date.now() - tickStartedAt));
  if (waitMs > 0) await sleep(waitMs);
}

lpFeed?.close();
cryptoFeed?.close();
state.longLp.checkpoint = longLp.exportState();
state.crypto.active = activeCrypto?.exportState() ?? null;
const segmentCompletedAt = new Date();
const reachedExperimentEnd = segmentCompletedAt.getTime() >= experimentEndsAtMs;
if (reachedExperimentEnd && !activeCrypto) {
  state.status = "completed";
  state.completedAt = segmentCompletedAt.toISOString();
}

const cryptoLatestEquity = state.configuration.lpOnly
  ? 0
  : cryptoSnapshot?.equity ?? state.crypto.portfolioValue;
const summary = {
  segmentId,
  mode: "paper-only",
  startedAt: segmentStartedAt.toISOString(),
  completedAt: segmentCompletedAt.toISOString(),
  elapsedSeconds: round((segmentCompletedAt.getTime() - segmentStartedAt.getTime()) / 1000),
  errors,
  experimentStatus: state.status,
  experimentEndsAt: state.endsAt,
  longLp: lpSnapshot,
  crypto: {
    portfolioValue: state.crypto.portfolioValue,
    activeMarket: cryptoSnapshot,
    marketsCompleted: state.crypto.markets.length,
  },
  combinedEquity: round(lpSnapshot.equity + cryptoLatestEquity),
  feeds: {
    longLp: lpFeed?.status() ?? null,
    crypto: cryptoFeed?.status() ?? null,
  },
  safety: state.safety,
};
state.segments.push({
  segmentId,
  startedAt: summary.startedAt,
  completedAt: summary.completedAt,
  elapsedSeconds: summary.elapsedSeconds,
  errors,
  combinedEquity: summary.combinedEquity,
});
await writeJsonAtomic(statePath, state);
await writeJsonAtomic(summaryPath, summary);
console.log(JSON.stringify({ status: "segment-complete", statePath, summaryPath, summary }));
