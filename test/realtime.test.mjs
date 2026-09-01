import test from "node:test";
import assert from "node:assert/strict";
import { MarketRealtimeFeed } from "../src/realtime.mjs";
import { CryptoMakerPaperStrategy } from "../src/strategies/crypto-maker.mjs";
import { LongLpPaperStrategy } from "../src/strategies/long-lp.mjs";

test("realtime feed keeps only executable trade messages", () => {
  const feed = new MarketRealtimeFeed(["up", "down"]);
  feed.handleMessage(JSON.stringify([
    { event_type: "book", market: "condition", asset_id: "up" },
    {
      event_type: "last_trade_price",
      market: "condition",
      asset_id: "up",
      price: "0.49",
      size: "20",
      side: "SELL",
      timestamp: "1234",
      transaction_hash: "0xtrade",
    },
  ]));
  assert.equal(feed.status().messages, 2);
  assert.equal(feed.status().trades, 1);
  assert.deepEqual(feed.drainTrades("condition"), [{
    conditionId: "condition",
    asset: "up",
    price: 0.49,
    size: 20,
    side: "SELL",
    timestamp: 1234,
    transactionHash: "0xtrade",
    source: "clob_websocket",
  }]);
  assert.deepEqual(feed.drainTrades("condition"), []);
});

test("crypto strategy rejects stale backfilled trades", () => {
  const strategy = new CryptoMakerPaperStrategy({
    budget: 100,
    activeBudget: 30,
    windowMinutes: 15,
    market: {
      id: "1",
      conditionId: "condition",
      question: "test",
      tokenIds: ["up", "down"],
      outcomes: ["Up", "Down"],
      endEpoch: Math.floor(Date.now() / 1000) + 900,
      feeSchedule: { rate: 0.07, rebateRate: 0.2 },
    },
    books: [
      { bestBid: 0.49, bestAsk: 0.5, minOrderSize: 5, tickSize: 0.01, bids: [{ price: 0.49, size: 10 }] },
      { bestBid: 0.49, bestAsk: 0.5, minOrderSize: 5, tickSize: 0.01, bids: [{ price: 0.49, size: 10 }] },
    ],
  });
  strategy.orders[0].placedAtMs = 2_000;
  strategy.applyTrade({ asset: "up", side: "SELL", price: 0.49, size: 100, timestamp: 1 });
  assert.equal(strategy.fills.length, 0);
  strategy.applyTrade({ asset: "up", side: "SELL", price: 0.49, size: 100, timestamp: 3 });
  assert.equal(strategy.fills.length, 1);
});

test("crypto resolution converts only winning inventory to cash", () => {
  const strategy = new CryptoMakerPaperStrategy({
    budget: 100,
    activeBudget: 30,
    windowMinutes: 15,
    market: {
      id: "1",
      conditionId: "condition",
      question: "test",
      tokenIds: ["up", "down"],
      outcomes: ["Up", "Down"],
      endEpoch: Math.floor(Date.now() / 1000) - 1,
      feeSchedule: { rate: 0.07, rebateRate: 0.2 },
    },
    books: [
      { bestBid: 0, bestAsk: 1, minOrderSize: 5, tickSize: 0.01, bids: [] },
      { bestBid: 1, bestAsk: 1, minOrderSize: 5, tickSize: 0.01, bids: [{ price: 1, size: 10 }] },
    ],
  });
  strategy.cash = 70;
  strategy.positions = [5, 20];
  strategy.costBasis = [2.5, 10];
  strategy.resolveIfPossible({ prices: [0, 1], outcomes: ["Up", "Down"] });
  assert.equal(strategy.cash, 90);
  assert.deepEqual(strategy.positions, [0, 0]);
  assert.equal(strategy.resolved, true);
  assert.equal(strategy.winningOutcome, "Down");
});

test("strategy checkpoints contain the capital needed for a conservative resume", () => {
  const market = {
    id: "lp-market",
    conditionId: "lp-condition",
    question: "LP test",
    tokenIds: ["cheap", "other"],
    outcomes: ["Yes", "No"],
    rewardsMinSize: 5,
    rewardsMaxSpread: 3,
    dailyRewardPool: 10,
    feesEnabled: false,
  };
  const book = {
    bestBid: 0.04,
    bestAsk: 0.05,
    tickSize: 0.01,
    minOrderSize: 5,
    bids: [{ price: 0.04, size: 100 }],
    asks: [{ price: 0.05, size: 100 }],
  };
  const lp = new LongLpPaperStrategy({
    budget: 100,
    activeBudget: 60,
    evaluation: {
      market,
      cheap: { index: 0, tokenId: "cheap", complementTokenId: "other", outcome: "Yes" },
      book,
      plan: { shares: 100, inventoryCost: 5, averageAsk: 0.05, fills: [{ price: 0.05, size: 100 }] },
      estimatedDailyReward: 1,
    },
  });
  const savedLp = lp.exportState();
  assert.equal(savedLp.cash, 95);
  assert.equal(savedLp.position, 100);
  assert.equal(savedLp.bidOrder.remaining, 100);

  const crypto = new CryptoMakerPaperStrategy({
    budget: 100,
    activeBudget: 30,
    windowMinutes: 15,
    market: {
      id: "1",
      conditionId: "condition",
      question: "test",
      tokenIds: ["up", "down"],
      outcomes: ["Up", "Down"],
      endEpoch: Math.floor(Date.now() / 1000) + 900,
      feeSchedule: { rate: 0.07, rebateRate: 0.2 },
    },
    books: [
      { bestBid: 0.49, bestAsk: 0.5, minOrderSize: 5, tickSize: 0.01, bids: [{ price: 0.49, size: 10 }] },
      { bestBid: 0.49, bestAsk: 0.5, minOrderSize: 5, tickSize: 0.01, bids: [{ price: 0.49, size: 10 }] },
    ],
  });
  const savedCrypto = crypto.exportState();
  assert.equal(savedCrypto.cash, 100);
  assert.equal(savedCrypto.orders.length, 2);
  assert.equal(savedCrypto.market.conditionId, "condition");
});

test("LP quote maintenance restores two reward-eligible legs conservatively", () => {
  const market = {
    id: "lp-market",
    conditionId: "lp-condition",
    question: "LP test",
    tokenIds: ["cheap", "other"],
    outcomes: ["Yes", "No"],
    rewardsMinSize: 50,
    rewardsMaxSpread: 3,
    dailyRewardPool: 10,
    feesEnabled: false,
  };
  const book = {
    bestBid: 0.028,
    bestAsk: 0.029,
    tickSize: 0.001,
    minOrderSize: 5,
    bids: [{ price: 0.028, size: 1_000 }],
    asks: [{ price: 0.029, size: 1_000 }],
  };
  const strategy = new LongLpPaperStrategy({
    budget: 200,
    activeBudget: 120,
    maximumCheapPrice: 0.05,
    maintainQuotes: true,
    evaluation: {
      market,
      cheap: { index: 0, tokenId: "cheap", complementTokenId: "other", outcome: "Yes" },
      book,
      plan: { shares: 2_000, inventoryCost: 58, averageAsk: 0.029, fills: [{ price: 0.029, size: 2_000 }] },
      estimatedDailyReward: 0.75,
    },
  });
  strategy.askOrder = null;
  const refreshed = strategy.maintainTwoSidedQuotes();
  assert.equal(refreshed, true);
  assert.equal(strategy.quoteRefreshes, 2);
  assert.ok(strategy.bidOrder.remaining >= market.rewardsMinSize);
  assert.equal(strategy.bidOrder.remaining, strategy.askOrder.remaining);
  assert.equal(strategy.bidOrder.queueAhead, 1_000);

  strategy.position = 0;
  strategy.askOrder = null;
  const priorBid = strategy.bidOrder;
  assert.equal(strategy.maintainTwoSidedQuotes(), false);
  assert.equal(strategy.bidOrder, priorBid);
});
