import {
  consumeAsksForBudget,
  estimatedRewardShare,
  makerRebate,
  orderScoreFactor,
  roundMoney,
  weightedBookScore,
  applyQueueTrade,
} from "../math.mjs";
import {
  discoverLongLpMarkets,
  getBook,
  getMarketById,
  getTrades,
  levelSizeAt,
  tradeKey,
} from "../api.mjs";

const XI_MARKET_ID = "559651";
const MINIMUM_REWARD_PAYOUT = 1;

function utcDay(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function cheapOutcome(market) {
  const index = market.prices.indexOf(Math.min(...market.prices));
  return {
    index,
    tokenId: market.tokenIds[index],
    complementTokenId: market.tokenIds[index === 0 ? 1 : 0],
    outcome: market.outcomes[index],
  };
}

function currentCompetition(book, market) {
  const midpoint = (book.bestBid + book.bestAsk) / 2;
  return Math.min(
    weightedBookScore(
      book.bids,
      midpoint,
      market.rewardsMaxSpread,
      market.rewardsMinSize,
    ),
    weightedBookScore(
      book.asks,
      midpoint,
      market.rewardsMaxSpread,
      market.rewardsMinSize,
    ),
  );
}

async function evaluateMarket(market, activeBudget) {
  const cheap = cheapOutcome(market);
  if (!cheap.tokenId) return null;
  const book = await getBook(cheap.tokenId);
  if (!(book.bestBid > 0) || !(book.bestAsk < 1)) return null;
  const plan = consumeAsksForBudget(book.asks, book.bestBid, activeBudget, {
    feeRate: market.feesEnabled ? Number(market.feeSchedule?.rate ?? 0) : 0,
    feeExponent: Number(market.feeSchedule?.exponent ?? 1),
  });
  if (plan.shares < market.rewardsMinSize) return null;
  if (plan.averageAsk - book.bestAsk > Math.max(0.002, book.tickSize * 2)) return null;

  const midpoint = (book.bestBid + book.bestAsk) / 2;
  const ownScore = plan.shares * Math.min(
    orderScoreFactor(market.rewardsMaxSpread, midpoint, book.bestBid),
    orderScoreFactor(market.rewardsMaxSpread, midpoint, book.bestAsk),
  );
  const competition = currentCompetition(book, market);
  const estimatedDailyReward =
    market.dailyRewardPool * estimatedRewardShare(ownScore, competition);
  return {
    market,
    cheap,
    book,
    plan,
    competition,
    ownScore,
    estimatedDailyReward,
  };
}

export class LongLpPaperStrategy {
  static async create({
    budget = 100,
    activeBudget = 60,
    maximumCheapPrice = 0.05,
    maintainQuotes = false,
  } = {}) {
    let markets = (await discoverLongLpMarkets()).filter(
      (market) => Math.min(...market.prices) < maximumCheapPrice,
    );
    if (markets.length === 0) {
      const fallbackMarket = await getMarketById(XI_MARKET_ID);
      if (Math.min(...fallbackMarket.prices) >= maximumCheapPrice) {
        throw new Error(`No LP candidate below ${maximumCheapPrice}`);
      }
      markets = [fallbackMarket];
    }
    const evaluations = (
      await Promise.all(markets.slice(0, 30).map((market) => evaluateMarket(market, activeBudget)))
    ).filter(Boolean);
    if (evaluations.length === 0) {
      const fallbackMarket = await getMarketById(XI_MARKET_ID);
      const fallback = Math.min(...fallbackMarket.prices) < maximumCheapPrice
        ? await evaluateMarket(fallbackMarket, activeBudget)
        : null;
      if (!fallback) throw new Error("No safe long-duration LP candidate found");
      evaluations.push(fallback);
    }
    evaluations.sort((a, b) => b.estimatedDailyReward - a.estimatedDailyReward);
    return new LongLpPaperStrategy({
      budget,
      activeBudget,
      evaluation: evaluations[0],
      maximumCheapPrice,
      maintainQuotes,
    });
  }

  static async restore(saved) {
    if (!saved || saved.version !== 1 || !saved.marketId || !saved.cheap?.tokenId) {
      throw new Error("Invalid long LP checkpoint");
    }
    const [market, book] = await Promise.all([
      getMarketById(saved.marketId),
      getBook(saved.cheap.tokenId),
    ]);
    const strategy = Object.create(LongLpPaperStrategy.prototype);
    strategy.name = "long_lp_rewards";
    strategy.budget = Number(saved.budget);
    strategy.activeBudget = Number(saved.activeBudget);
    strategy.maximumCheapPrice = Number(saved.maximumCheapPrice ?? 0.05);
    strategy.maintainQuotes = Boolean(saved.maintainQuotes);
    strategy.market = market;
    strategy.cheap = saved.cheap;
    strategy.book = book;
    strategy.position = Number(saved.position);
    strategy.cash = Number(saved.cash);
    strategy.seedCost = Number(saved.seedCost);
    strategy.seedAveragePrice = Number(saved.seedAveragePrice);
    strategy.takerFeesPaid = Number(saved.takerFeesPaid ?? 0);
    strategy.rewardsPaid = Number(saved.rewardsPaid ?? saved.rewardsAccrued ?? 0);
    strategy.pendingRewardEstimate = Number(saved.pendingRewardEstimate ?? 0);
    strategy.forfeitedRewardEstimate = Number(saved.forfeitedRewardEstimate ?? 0);
    strategy.rewardMinimumPayout = Number(saved.rewardMinimumPayout ?? MINIMUM_REWARD_PAYOUT);
    strategy.rewardEpochDate = saved.rewardEpochDate ?? utcDay(Date.now());
    strategy.rebatesAccrued = Number(saved.rebatesAccrued ?? 0);
    strategy.realizedSpreadPnl = Number(saved.realizedSpreadPnl ?? 0);
    strategy.fills = Array.isArray(saved.fills) ? saved.fills : [];
    strategy.seenTrades = new Set();
    strategy.startedAt = Number(saved.startedAt ?? Date.now());
    strategy.lastStepAt = Date.now();
    strategy.lastMarketRefreshAt = Date.now();
    strategy.initialEstimate = Number(saved.initialEstimate ?? 0);
    strategy.quoteRefreshes = Number(saved.quoteRefreshes ?? 1);
    strategy.bidOrder = strategy.restoreOrder(saved.bidOrder, book.bids);
    strategy.askOrder = strategy.restoreOrder(saved.askOrder, book.asks);
    return strategy;
  }

  constructor({
    budget,
    activeBudget,
    evaluation,
    maximumCheapPrice = 0.05,
    maintainQuotes = false,
  }) {
    this.name = "long_lp_rewards";
    this.budget = budget;
    this.activeBudget = activeBudget;
    this.maximumCheapPrice = maximumCheapPrice;
    this.maintainQuotes = maintainQuotes;
    this.market = evaluation.market;
    this.cheap = evaluation.cheap;
    this.book = evaluation.book;
    this.position = evaluation.plan.shares;
    this.takerFeesPaid = Number(evaluation.plan.takerFees ?? 0);
    this.cash = budget - evaluation.plan.inventoryCost - this.takerFeesPaid;
    this.seedCost = evaluation.plan.inventoryCost;
    this.seedAveragePrice = evaluation.plan.averageAsk;
    this.rewardsPaid = 0;
    this.pendingRewardEstimate = 0;
    this.forfeitedRewardEstimate = 0;
    this.rewardMinimumPayout = MINIMUM_REWARD_PAYOUT;
    this.rewardEpochDate = utcDay(Date.now());
    this.rebatesAccrued = 0;
    this.realizedSpreadPnl = 0;
    this.fills = [];
    this.seenTrades = new Set();
    this.startedAt = Date.now();
    this.lastStepAt = this.startedAt;
    this.lastMarketRefreshAt = this.startedAt;
    const acquiredAtBest = evaluation.plan.fills
      .filter((fill) => Math.abs(fill.price - this.book.bestAsk) < 1e-8)
      .reduce((sum, fill) => sum + fill.size, 0);
    this.bidOrder = {
      price: this.book.bestBid,
      remaining: evaluation.plan.shares,
      queueAhead: levelSizeAt(this.book.bids, this.book.bestBid),
      placedAtMs: Date.now(),
    };
    this.askOrder = {
      price: this.book.bestAsk,
      remaining: evaluation.plan.shares,
      queueAhead: Math.max(0, levelSizeAt(this.book.asks, this.book.bestAsk) - acquiredAtBest),
      placedAtMs: Date.now(),
    };
    this.initialEstimate = evaluation.estimatedDailyReward;
    this.quoteRefreshes = 1;
  }

  restoreOrder(saved, levels) {
    if (!saved || !(Number(saved.remaining) > 0)) return null;
    const price = Number(saved.price);
    return {
      price,
      remaining: Number(saved.remaining),
      queueAhead: levelSizeAt(levels, price),
      placedAtMs: Date.now(),
    };
  }

  exportState() {
    return {
      version: 1,
      budget: this.budget,
      activeBudget: this.activeBudget,
      maximumCheapPrice: this.maximumCheapPrice,
      maintainQuotes: this.maintainQuotes,
      marketId: this.market.id,
      cheap: this.cheap,
      position: this.position,
      cash: this.cash,
      seedCost: this.seedCost,
      seedAveragePrice: this.seedAveragePrice,
      takerFeesPaid: this.takerFeesPaid,
      rewardsPaid: this.rewardsPaid,
      pendingRewardEstimate: this.pendingRewardEstimate,
      forfeitedRewardEstimate: this.forfeitedRewardEstimate,
      rewardMinimumPayout: this.rewardMinimumPayout,
      rewardEpochDate: this.rewardEpochDate,
      rebatesAccrued: this.rebatesAccrued,
      realizedSpreadPnl: this.realizedSpreadPnl,
      fills: this.fills,
      startedAt: this.startedAt,
      initialEstimate: this.initialEstimate,
      quoteRefreshes: this.quoteRefreshes,
      bidOrder: this.bidOrder,
      askOrder: this.askOrder,
    };
  }

  async initialize({ realtime = false } = {}) {
    if (!realtime) {
      for (const trade of await getTrades(this.market.conditionId)) {
        this.seenTrades.add(tradeKey(trade));
      }
    }
    const now = Date.now();
    if (this.bidOrder) {
      this.bidOrder.queueAhead = levelSizeAt(this.book.bids, this.bidOrder.price);
      this.bidOrder.placedAtMs = now;
    }
    if (this.askOrder) {
      this.askOrder.queueAhead = levelSizeAt(this.book.asks, this.askOrder.price);
      this.askOrder.placedAtMs = now;
    }
    this.maintainTwoSidedQuotes();
    return this.snapshot("initialized");
  }

  async step({ trades: realtimeTrades } = {}) {
    const now = Date.now();
    const elapsedSeconds = Math.max(0, (now - this.lastStepAt) / 1000);
    this.lastStepAt = now;
    const shouldRefreshMarket = now - this.lastMarketRefreshAt >= 60_000;
    const [book, fallbackTrades, refreshedMarket] = await Promise.all([
      getBook(this.cheap.tokenId),
      realtimeTrades === undefined ? getTrades(this.market.conditionId) : Promise.resolve([]),
      shouldRefreshMarket ? getMarketById(this.market.id) : Promise.resolve(null),
    ]);
    const trades = realtimeTrades ?? fallbackTrades;
    this.book = book;
    if (refreshedMarket) {
      this.market = refreshedMarket;
      this.lastMarketRefreshAt = now;
    }
    const freshTrades = trades
      .filter((trade) => !this.seenTrades.has(tradeKey(trade)))
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    for (const trade of freshTrades) {
      this.seenTrades.add(tradeKey(trade));
      this.applyTrade(trade);
    }
    this.repriceIfNeeded();
    this.maintainTwoSidedQuotes();
    this.accrueReward(elapsedSeconds, now);
    return this.snapshot("tick");
  }

  applyTrade(trade) {
    const side = String(trade.side).toUpperCase();
    const tradePrice = Number(trade.price);
    const tradeSize = Number(trade.size);
    const asset = String(trade.asset);
    const timestamp = Number(trade.timestamp);
    const tradeTimeMs = timestamp > 1e12 ? timestamp : timestamp * 1000;
    if (side === "BUY" && asset === this.cheap.tokenId && this.askOrder?.remaining > 0) {
      if (tradeTimeMs < this.askOrder.placedAtMs) return;
      if (tradePrice + 1e-7 >= this.askOrder.price) {
        const result = applyQueueTrade(
          this.askOrder,
          tradeSize,
          tradePrice > this.askOrder.price + 1e-7,
        );
        this.askOrder = result.order;
        if (result.filled > 0) this.recordAskFill(result.filled, this.askOrder.price);
      }
    }
    if (side === "BUY" && asset === this.cheap.complementTokenId && this.bidOrder?.remaining > 0) {
      if (tradeTimeMs < this.bidOrder.placedAtMs) return;
      const complementAsk = 1 - this.bidOrder.price;
      if (tradePrice + 1e-7 >= complementAsk) {
        const result = applyQueueTrade(
          this.bidOrder,
          tradeSize,
          tradePrice > complementAsk + 1e-7,
        );
        this.bidOrder = result.order;
        if (result.filled > 0) this.recordBidFill(result.filled, this.bidOrder.price);
      }
    }
    if (side === "SELL" && asset === this.cheap.tokenId && this.bidOrder?.remaining > 0) {
      if (tradeTimeMs < this.bidOrder.placedAtMs) return;
      if (tradePrice <= this.bidOrder.price + 1e-7) {
        const result = applyQueueTrade(
          this.bidOrder,
          tradeSize,
          tradePrice < this.bidOrder.price - 1e-7,
        );
        this.bidOrder = result.order;
        if (result.filled > 0) this.recordBidFill(result.filled, this.bidOrder.price);
      }
    }
  }

  recordAskFill(size, price) {
    this.position -= size;
    this.cash += size * price;
    this.realizedSpreadPnl += size * (price - this.seedAveragePrice);
    const rebate = this.market.feesEnabled
      ? makerRebate(
          size,
          price,
          Number(this.market.feeSchedule?.rate ?? 0),
          Number(this.market.feeSchedule?.rebateRate ?? 0),
          Number(this.market.feeSchedule?.exponent ?? 1),
        )
      : 0;
    this.rebatesAccrued += rebate;
    this.fills.push({ type: "ask", size, price, rebate, at: new Date().toISOString() });
  }

  recordBidFill(size, price) {
    const affordable = Math.min(size, this.cash / price);
    if (affordable <= 0) return;
    this.position += affordable;
    this.cash -= affordable * price;
    const rebate = this.market.feesEnabled
      ? makerRebate(
          affordable,
          price,
          Number(this.market.feeSchedule?.rate ?? 0),
          Number(this.market.feeSchedule?.rebateRate ?? 0),
          Number(this.market.feeSchedule?.exponent ?? 1),
        )
      : 0;
    this.rebatesAccrued += rebate;
    this.fills.push({ type: "bid", size: affordable, price, rebate, at: new Date().toISOString() });
  }

  repriceIfNeeded() {
    const tolerance = Math.max(1e-8, this.book.tickSize / 2);
    if (this.bidOrder?.remaining > 0 && Math.abs(this.bidOrder.price - this.book.bestBid) > tolerance) {
      this.bidOrder.price = this.book.bestBid;
      this.bidOrder.queueAhead = levelSizeAt(this.book.bids, this.book.bestBid);
      this.bidOrder.placedAtMs = Date.now();
    }
    if (this.askOrder?.remaining > 0 && Math.abs(this.askOrder.price - this.book.bestAsk) > tolerance) {
      this.askOrder.price = this.book.bestAsk;
      this.askOrder.queueAhead = levelSizeAt(this.book.asks, this.book.bestAsk);
      this.askOrder.placedAtMs = Date.now();
    }
  }

  maintainTwoSidedQuotes() {
    if (!this.maintainQuotes) return false;
    const minimumSize = this.market.rewardsMinSize;
    const bidRemaining = this.bidOrder?.remaining ?? 0;
    const askRemaining = this.askOrder?.remaining ?? 0;
    if (bidRemaining >= minimumSize && askRemaining >= minimumSize) return false;

    const bid = this.book.bestBid;
    const ask = this.book.bestAsk;
    if (!(bid > 0) || !(ask > bid) || !(this.position > 0) || !(this.cash > 0)) return false;
    const capacity = Math.floor(Math.min(
      this.activeBudget / (bid + ask),
      this.position,
      this.cash / bid,
    ) * 1e6) / 1e6;
    if (capacity < minimumSize) return false;

    const placedAtMs = Date.now();
    this.bidOrder = {
      price: bid,
      remaining: capacity,
      queueAhead: levelSizeAt(this.book.bids, bid),
      placedAtMs,
    };
    this.askOrder = {
      price: ask,
      remaining: capacity,
      queueAhead: levelSizeAt(this.book.asks, ask),
      placedAtMs,
    };
    this.quoteRefreshes += 1;
    return true;
  }

  rollRewardEpoch(now) {
    const nextEpochDate = utcDay(now);
    if (nextEpochDate === this.rewardEpochDate) return false;
    if (this.pendingRewardEstimate >= this.rewardMinimumPayout) {
      this.rewardsPaid += this.pendingRewardEstimate;
    } else {
      this.forfeitedRewardEstimate += this.pendingRewardEstimate;
    }
    this.pendingRewardEstimate = 0;
    this.rewardEpochDate = nextEpochDate;
    return true;
  }

  accrueReward(elapsedSeconds, now = Date.now()) {
    this.rollRewardEpoch(now);
    if (!(this.bidOrder?.remaining > 0) || !(this.askOrder?.remaining > 0)) return;
    if (
      this.bidOrder.remaining < this.market.rewardsMinSize ||
      this.askOrder.remaining < this.market.rewardsMinSize
    ) return;
    const midpoint = (this.book.bestBid + this.book.bestAsk) / 2;
    const ownScore = Math.min(
      this.bidOrder.remaining * orderScoreFactor(
        this.market.rewardsMaxSpread,
        midpoint,
        this.bidOrder.price,
      ),
      this.askOrder.remaining * orderScoreFactor(
        this.market.rewardsMaxSpread,
        midpoint,
        this.askOrder.price,
      ),
    );
    const competition = currentCompetition(this.book, this.market);
    const hourlyRate =
      (this.market.dailyRewardPool * estimatedRewardShare(ownScore, competition)) / 24;
    this.pendingRewardEstimate += hourlyRate * (elapsedSeconds / 3600);
  }

  snapshot(event) {
    const inventoryMark = this.position * this.book.bestBid;
    const eligiblePendingReward = this.pendingRewardEstimate >= this.rewardMinimumPayout
      ? this.pendingRewardEstimate
      : 0;
    const rewardsAccrued = this.rewardsPaid + eligiblePendingReward;
    const grossRewardEstimate =
      this.rewardsPaid + this.pendingRewardEstimate + this.forfeitedRewardEstimate;
    const equity = this.cash + inventoryMark + rewardsAccrued + this.rebatesAccrued;
    return {
      event,
      strategy: this.name,
      market: this.market.question,
      conditionId: this.market.conditionId,
      outcome: this.cheap.outcome,
      budget: this.budget,
      dailyPool: this.market.dailyRewardPool,
      bid: this.book.bestBid,
      ask: this.book.bestAsk,
      position: roundMoney(this.position),
      cash: roundMoney(this.cash),
      bidRemaining: roundMoney(this.bidOrder?.remaining ?? 0),
      askRemaining: roundMoney(this.askOrder?.remaining ?? 0),
      rewardsAccrued: roundMoney(rewardsAccrued),
      rewardsPaid: roundMoney(this.rewardsPaid),
      pendingRewardEstimate: roundMoney(this.pendingRewardEstimate),
      forfeitedRewardEstimate: roundMoney(this.forfeitedRewardEstimate),
      grossRewardEstimate: roundMoney(grossRewardEstimate),
      rewardMinimumPayout: this.rewardMinimumPayout,
      rewardEpochDate: this.rewardEpochDate,
      rebatesAccrued: roundMoney(this.rebatesAccrued),
      inventoryMark: roundMoney(inventoryMark),
      equity: roundMoney(equity),
      netPnl: roundMoney(equity - this.budget),
      fills: this.fills.length,
      quoteRefreshes: this.quoteRefreshes,
      takerFeesPaid: roundMoney(this.takerFeesPaid),
      seedTotalCost: roundMoney(this.seedCost + this.takerFeesPaid),
      initialEstimatedRewardPerDay: roundMoney(this.initialEstimate),
      seedCost: roundMoney(this.seedCost),
      seedAveragePrice: roundMoney(this.seedAveragePrice),
      recentFills: this.fills.slice(-3),
    };
  }
}
