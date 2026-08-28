import {
  applyQueueTrade,
  makerRebate,
  maxPairedBidShares,
  mergeCompleteSets,
  roundMoney,
} from "../math.mjs";
import {
  getBook,
  getCryptoMarket,
  getMarketById,
  getTrades,
  levelSizeAt,
  tradeKey,
} from "../api.mjs";

export class CryptoMakerPaperStrategy {
  static async create({ budget = 100, activeBudget = 30, windowMinutes = 15 } = {}) {
    const market = await getCryptoMarket(windowMinutes);
    const books = await Promise.all(market.tokenIds.map((token) => getBook(token)));
    return new CryptoMakerPaperStrategy({ budget, activeBudget, windowMinutes, market, books });
  }

  static async restore(saved) {
    if (!saved || saved.version !== 1 || !saved.market?.id) {
      throw new Error("Invalid crypto maker checkpoint");
    }
    const [currentMarket, bookResults] = await Promise.all([
      getMarketById(saved.market.id),
      Promise.allSettled(saved.market.tokenIds.map((token) => getBook(token))),
    ]);
    const books = bookResults.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      if (saved.books?.[index]) return saved.books[index];
      throw result.reason;
    });
    const strategy = Object.create(CryptoMakerPaperStrategy.prototype);
    strategy.name = `btc_${saved.windowMinutes}m_maker_rebates`;
    strategy.budget = Number(saved.budget);
    strategy.activeBudget = Number(saved.activeBudget);
    strategy.windowMinutes = Number(saved.windowMinutes);
    strategy.market = { ...saved.market, ...currentMarket, endEpoch: saved.market.endEpoch };
    strategy.books = books;
    strategy.cash = Number(saved.cash);
    strategy.positions = saved.positions.map(Number);
    strategy.costBasis = saved.costBasis.map(Number);
    strategy.orders = saved.orders.map((order, index) => {
      if (!order || !(Number(order.remaining) > 0)) return null;
      const price = Number(order.price);
      return {
        price,
        remaining: Number(order.remaining),
        queueAhead: levelSizeAt(books[index].bids, price),
        placedAtMs: Date.now(),
      };
    });
    strategy.rebatesAccrued = Number(saved.rebatesAccrued ?? 0);
    strategy.mergedSets = Number(saved.mergedSets ?? 0);
    strategy.fills = Array.isArray(saved.fills) ? saved.fills : [];
    strategy.seenTrades = new Set();
    strategy.startedAt = Number(saved.startedAt ?? Date.now());
    strategy.stopBeforeEndSeconds = Number(saved.stopBeforeEndSeconds ?? 90);
    strategy.maxPairCost = Number(saved.maxPairCost ?? 1.02);
    strategy.closed = Boolean(saved.closed);
    strategy.resolved = Boolean(saved.resolved);
    strategy.winningOutcome = saved.winningOutcome ?? null;
    strategy.lastMarketRefreshAt = 0;
    return strategy;
  }

  constructor({ budget, activeBudget, windowMinutes, market, books }) {
    this.name = `btc_${windowMinutes}m_maker_rebates`;
    this.budget = budget;
    this.activeBudget = activeBudget;
    this.windowMinutes = windowMinutes;
    this.market = market;
    this.books = books;
    this.cash = budget;
    this.positions = [0, 0];
    this.costBasis = [0, 0];
    this.orders = [null, null];
    this.rebatesAccrued = 0;
    this.mergedSets = 0;
    this.fills = [];
    this.seenTrades = new Set();
    this.startedAt = Date.now();
    this.stopBeforeEndSeconds = 90;
    this.maxPairCost = 1.02;
    this.closed = false;
    this.resolved = false;
    this.winningOutcome = null;
    this.lastMarketRefreshAt = Date.now();
    this.refreshOrders();
  }

  exportState() {
    return {
      version: 1,
      budget: this.budget,
      activeBudget: this.activeBudget,
      windowMinutes: this.windowMinutes,
      market: this.market,
      books: this.books,
      cash: this.cash,
      positions: this.positions,
      costBasis: this.costBasis,
      orders: this.orders,
      rebatesAccrued: this.rebatesAccrued,
      mergedSets: this.mergedSets,
      fills: this.fills,
      startedAt: this.startedAt,
      stopBeforeEndSeconds: this.stopBeforeEndSeconds,
      maxPairCost: this.maxPairCost,
      closed: this.closed,
      resolved: this.resolved,
      winningOutcome: this.winningOutcome,
    };
  }

  async initialize({ realtime = false } = {}) {
    if (!realtime) {
      for (const trade of await getTrades(this.market.conditionId)) {
        this.seenTrades.add(tradeKey(trade));
      }
    }
    const now = Date.now();
    for (let index = 0; index < this.orders.length; index += 1) {
      const order = this.orders[index];
      if (!order) continue;
      order.queueAhead = levelSizeAt(this.books[index].bids, order.price);
      order.placedAtMs = now;
    }
    return this.snapshot("initialized");
  }

  secondsToEnd() {
    return this.market.endEpoch - Math.floor(Date.now() / 1000);
  }

  refreshOrders() {
    if (this.closed || this.secondsToEnd() <= this.stopBeforeEndSeconds) {
      this.orders = [null, null];
      return;
    }
    const bids = this.books.map((book) => book.bestBid);
    if (this.positions[0] === 0 && this.positions[1] === 0) {
      const size = maxPairedBidShares(Math.min(this.activeBudget, this.cash), bids[0], bids[1]);
      if (size < Math.max(...this.books.map((book) => book.minOrderSize))) {
        this.orders = [null, null];
        return;
      }
      this.orders = bids.map((price, index) => ({
        price,
        remaining: size,
        queueAhead: levelSizeAt(this.books[index].bids, price),
        placedAtMs: Date.now(),
      }));
      return;
    }

    const exposedIndex = this.positions[0] > 0 ? 0 : 1;
    const hedgeIndex = exposedIndex === 0 ? 1 : 0;
    const averageCost = this.positions[exposedIndex] > 0
      ? this.costBasis[exposedIndex] / this.positions[exposedIndex]
      : 0;
    const hedgeBid = bids[hedgeIndex];
    this.orders[exposedIndex] = null;
    if (averageCost + hedgeBid <= this.maxPairCost && this.cash >= hedgeBid * this.positions[exposedIndex]) {
      this.orders[hedgeIndex] = {
        price: hedgeBid,
        remaining: this.positions[exposedIndex],
        queueAhead: levelSizeAt(this.books[hedgeIndex].bids, hedgeBid),
        placedAtMs: Date.now(),
      };
    } else {
      this.orders[hedgeIndex] = null;
    }
  }

  async step({ trades: realtimeTrades } = {}) {
    const now = Date.now();
    const shouldRefreshMarket =
      now - this.lastMarketRefreshAt >= 30_000 || this.secondsToEnd() <= 120;
    const currentMarket = shouldRefreshMarket
      ? await getMarketById(this.market.id)
      : this.market;
    if (shouldRefreshMarket) this.lastMarketRefreshAt = now;
    this.closed =
      !currentMarket.acceptingOrders || new Date(currentMarket.endDate).getTime() <= now;
    const [bookResults, fallbackTrades] = await Promise.all([
      Promise.allSettled(this.market.tokenIds.map((token) => getBook(token))),
      realtimeTrades === undefined ? getTrades(this.market.conditionId) : Promise.resolve([]),
    ]);
    const books = bookResults.map((result, index) =>
      result.status === "fulfilled" ? result.value : this.books[index]);
    const trades = realtimeTrades ?? fallbackTrades;
    this.books = books;
    const freshTrades = trades
      .filter((trade) => !this.seenTrades.has(tradeKey(trade)))
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    for (const trade of freshTrades) {
      this.seenTrades.add(tradeKey(trade));
      this.applyTrade(trade);
    }
    this.mergePositions();
    this.repriceOrRefresh();
    if (this.closed) this.resolveIfPossible(currentMarket);
    return this.snapshot("tick");
  }

  applyTrade(trade) {
    const assetIndex = this.market.tokenIds.indexOf(String(trade.asset));
    if (assetIndex < 0) return;
    const side = String(trade.side).toUpperCase();
    const makerBidIndex = side === "SELL" ? assetIndex : assetIndex === 0 ? 1 : 0;
    const order = this.orders[makerBidIndex];
    if (!order?.remaining) return;
    const tradePrice = Number(trade.price);
    const timestamp = Number(trade.timestamp);
    const tradeTimeMs = timestamp > 1e12 ? timestamp : timestamp * 1000;
    if (tradeTimeMs < order.placedAtMs) return;
    const threshold = side === "SELL" ? order.price : 1 - order.price;
    const eligible = side === "SELL"
      ? tradePrice <= threshold + 1e-7
      : tradePrice + 1e-7 >= threshold;
    if (!eligible) return;
    const deeper = side === "SELL"
      ? tradePrice < threshold - 1e-7
      : tradePrice > threshold + 1e-7;
    const result = applyQueueTrade(
      order,
      Number(trade.size),
      deeper,
    );
    this.orders[makerBidIndex] = result.order;
    if (result.filled > 0) this.recordFill(makerBidIndex, result.filled, order.price);
  }

  recordFill(index, size, price) {
    const affordable = Math.min(size, this.cash / price);
    if (!(affordable > 0)) return;
    this.cash -= affordable * price;
    this.positions[index] += affordable;
    this.costBasis[index] += affordable * price;
    const feeRate = Number(this.market.feeSchedule?.rate ?? 0.07);
    const rebateRate = Number(this.market.feeSchedule?.rebateRate ?? 0.2);
    const rebate = makerRebate(affordable, price, feeRate, rebateRate);
    this.rebatesAccrued += rebate;
    this.fills.push({
      outcome: this.market.outcomes[index],
      size: affordable,
      price,
      rebate,
      at: new Date().toISOString(),
    });
    this.orders[index] = null;
  }

  mergePositions() {
    const result = mergeCompleteSets(this.positions[0], this.positions[1]);
    if (!(result.merged > 0)) return;
    for (let index = 0; index < 2; index += 1) {
      const averageCost = this.positions[index] > 0
        ? this.costBasis[index] / this.positions[index]
        : 0;
      this.costBasis[index] -= averageCost * result.merged;
      this.positions[index] -= result.merged;
      if (this.positions[index] < 1e-8) {
        this.positions[index] = 0;
        this.costBasis[index] = 0;
      }
    }
    this.cash += result.cashReleased;
    this.mergedSets += result.merged;
    this.orders = [null, null];
  }

  repriceOrRefresh() {
    if (this.closed || this.secondsToEnd() <= this.stopBeforeEndSeconds) {
      this.orders = [null, null];
      return;
    }
    const needsRefresh = this.orders.every((order) => !order?.remaining);
    if (needsRefresh) {
      this.refreshOrders();
      return;
    }
    for (let index = 0; index < 2; index += 1) {
      const order = this.orders[index];
      if (!order?.remaining) continue;
      const nextBid = this.books[index].bestBid;
      const tolerance = Math.max(1e-8, this.books[index].tickSize / 2);
      if (Math.abs(order.price - nextBid) > tolerance) {
        order.price = nextBid;
        order.queueAhead = levelSizeAt(this.books[index].bids, nextBid);
        order.placedAtMs = Date.now();
      }
    }
    if (this.positions[0] > 0 || this.positions[1] > 0) {
      const exposed = this.positions[0] > 0 ? 0 : 1;
      const hedge = exposed === 0 ? 1 : 0;
      this.orders[exposed] = null;
      const averageCost = this.costBasis[exposed] / this.positions[exposed];
      if (!this.orders[hedge] || averageCost + this.orders[hedge].price > this.maxPairCost) {
        this.orders[hedge] = null;
        this.refreshOrders();
      }
    }
  }

  resolveIfPossible(currentMarket) {
    const resolvedIndex = currentMarket.prices.findIndex((price) => Number(price) >= 0.999);
    if (resolvedIndex < 0) return;
    this.cash += this.positions[resolvedIndex];
    this.positions = [0, 0];
    this.costBasis = [0, 0];
    this.resolved = true;
    this.winningOutcome = currentMarket.outcomes[resolvedIndex] ?? String(resolvedIndex);
  }

  snapshot(event) {
    const inventoryMark = this.positions.reduce(
      (sum, position, index) => sum + position * this.books[index].bestBid,
      0,
    );
    const equity = this.cash + inventoryMark + this.rebatesAccrued;
    return {
      event,
      strategy: this.name,
      market: this.market.question,
      conditionId: this.market.conditionId,
      budget: this.budget,
      activeBudget: this.activeBudget,
      secondsToEnd: this.secondsToEnd(),
      bids: this.books.map((book) => book.bestBid),
      asks: this.books.map((book) => book.bestAsk),
      cash: roundMoney(this.cash),
      positions: this.positions.map(roundMoney),
      openBidSizes: this.orders.map((order) => roundMoney(order?.remaining ?? 0)),
      rebatesAccrued: roundMoney(this.rebatesAccrued),
      mergedSets: roundMoney(this.mergedSets),
      inventoryMark: roundMoney(inventoryMark),
      equity: roundMoney(equity),
      netPnl: roundMoney(equity - this.budget),
      fills: this.fills.length,
      closed: this.closed,
      resolved: this.resolved,
      winningOutcome: this.winningOutcome,
      recentFills: this.fills.slice(-3),
    };
  }
}
