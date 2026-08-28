const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const DATA = "https://data-api.polymarket.com";

export async function fetchJson(url, { timeoutMs = 10_000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "polymarket-strategy-lab/0.1 read-only" },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`GET ${url} failed: ${lastError?.message ?? "unknown error"}`);
}

export function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeBook(raw) {
  const levels = (rows) =>
    (rows ?? []).map((row) => ({ price: Number(row.price), size: Number(row.size) }));
  const bids = levels(raw.bids).sort((a, b) => b.price - a.price);
  const asks = levels(raw.asks).sort((a, b) => a.price - b.price);
  return {
    tokenId: raw.asset_id,
    bids,
    asks,
    bestBid: bids[0]?.price ?? 0,
    bestAsk: asks[0]?.price ?? 1,
    tickSize: Number(raw.tick_size),
    minOrderSize: Number(raw.min_order_size),
    timestamp: Number(raw.timestamp),
  };
}

export async function getBook(tokenId) {
  const raw = await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  return normalizeBook(raw);
}

export async function getMarketById(marketId) {
  const market = await fetchJson(`${GAMMA}/markets/${encodeURIComponent(marketId)}`);
  return normalizeMarket(market);
}

export async function getTrades(conditionId, limit = 1000) {
  const url = new URL(`${DATA}/trades`);
  url.searchParams.set("market", conditionId);
  url.searchParams.set("limit", String(limit));
  const rows = await fetchJson(url);
  return Array.isArray(rows) ? rows : [];
}

export function cryptoSlug(windowMinutes, epochSeconds = Date.now() / 1000) {
  const step = windowMinutes * 60;
  return `btc-updown-${windowMinutes}m-${Math.floor(epochSeconds / step) * step}`;
}

export async function getCryptoMarket(windowMinutes = 15, { minimumRemainingSeconds = 240 } = {}) {
  const step = windowMinutes * 60;
  const now = Math.floor(Date.now() / 1000);
  const base = Math.floor(now / step) * step;
  for (const startEpoch of [base, base + step]) {
    const slug = `btc-updown-${windowMinutes}m-${startEpoch}`;
    const events = await fetchJson(`${GAMMA}/events?slug=${slug}`);
    const market = events?.[0]?.markets?.[0];
    if (!market || !market.acceptingOrders) continue;
    const endEpoch = Math.floor(new Date(market.endDate).getTime() / 1000);
    if (endEpoch - now < minimumRemainingSeconds) continue;
    return normalizeMarket(market, { slug, startEpoch, endEpoch });
  }
  throw new Error(`No ${windowMinutes}-minute BTC market with enough time remaining`);
}

export function normalizeMarket(market, extras = {}) {
  const outcomes = parseJsonArray(market.outcomes);
  const prices = parseJsonArray(market.outcomePrices).map(Number);
  const tokenIds = parseJsonArray(market.clobTokenIds).map(String);
  const rewardConfigs = Array.isArray(market.clobRewards) ? market.clobRewards : [];
  return {
    ...extras,
    id: String(market.id),
    conditionId: market.conditionId,
    question: market.question,
    endDate: market.endDate,
    acceptingOrders: Boolean(market.acceptingOrders),
    outcomes,
    prices,
    tokenIds,
    feeSchedule: market.feeSchedule ?? null,
    feesEnabled: Boolean(market.feesEnabled),
    rewardsMinSize: Number(market.rewardsMinSize ?? 0),
    rewardsMaxSpread: Number(market.rewardsMaxSpread ?? 0),
    rewardConfigs,
    dailyRewardPool: rewardConfigs.reduce(
      (sum, config) => sum + Number(config.rewardsDailyRate ?? config.rate_per_day ?? 0),
      0,
    ),
    spread: Number(market.spread ?? 0),
    liquidity: Number(market.liquidityNum ?? market.liquidity ?? 0),
    volume24hr: Number(market.volume24hr ?? 0),
  };
}

export async function discoverLongLpMarkets({ pages = 6, minimumDays = 7 } = {}) {
  const now = Date.now();
  const pageResults = await Promise.all(
    Array.from({ length: pages }, (_, index) =>
      fetchJson(`${GAMMA}/markets?active=true&closed=false&limit=100&offset=${index * 100}`),
    ),
  );
  return pageResults
    .flat()
    .map((market) => normalizeMarket(market))
    .filter((market) => {
      const endMs = new Date(market.endDate).getTime();
      const minPrice = Math.min(...market.prices);
      return (
        market.acceptingOrders &&
        market.tokenIds.length === 2 &&
        market.dailyRewardPool > 0 &&
        market.rewardsMinSize > 0 &&
        market.rewardsMaxSpread > 0 &&
        minPrice >= 0.01 &&
        minPrice < 0.10 &&
        market.spread > 0 &&
        market.spread <= 0.005 &&
        endMs - now >= minimumDays * 86_400_000
      );
    });
}

export function tradeKey(trade) {
  return [
    trade.transactionHash,
    trade.asset,
    trade.timestamp,
    trade.size,
    trade.price,
    trade.side,
  ].join(":");
}

export function levelSizeAt(levels, price, tolerance = 1e-7) {
  return levels.find((level) => Math.abs(level.price - price) <= tolerance)?.size ?? 0;
}
