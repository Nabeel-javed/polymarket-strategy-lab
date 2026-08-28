export const CRYPTO_FEE_RATE = 0.07;
export const CRYPTO_REBATE_RATE = 0.20;

export function feeEquivalent(shares, price, feeRate = CRYPTO_FEE_RATE) {
  return shares * feeRate * price * (1 - price);
}

export function makerRebate(
  shares,
  price,
  feeRate = CRYPTO_FEE_RATE,
  rebateRate = CRYPTO_REBATE_RATE,
) {
  return feeEquivalent(shares, price, feeRate) * rebateRate;
}

export function orderScoreFactor(maxSpreadCents, midpoint, price) {
  const maxSpread = maxSpreadCents / 100;
  if (!(maxSpread > 0)) return 0;
  const distance = Math.abs(midpoint - price);
  if (distance >= maxSpread - 1e-12) return 0;
  return ((maxSpread - distance) / maxSpread) ** 2;
}

export function weightedBookScore(levels, midpoint, maxSpreadCents, minShares) {
  return levels.reduce((total, level) => {
    if (level.size < minShares) return total;
    return total + level.size * orderScoreFactor(maxSpreadCents, midpoint, level.price);
  }, 0);
}

export function estimatedRewardShare(ownTwoSidedScore, visibleTwoSidedCompetition) {
  if (!(ownTwoSidedScore > 0)) return 0;
  return ownTwoSidedScore / (Math.max(0, visibleTwoSidedCompetition) + ownTwoSidedScore);
}

export function maxPairedBidShares(activeBudget, firstBid, secondBid) {
  const costPerPair = firstBid + secondBid;
  if (!(activeBudget > 0) || !(costPerPair > 0)) return 0;
  return Math.floor((activeBudget / costPerPair) * 100) / 100;
}

export function consumeAsksForBudget(asks, bidPrice, budget) {
  let cashLeft = budget;
  let shares = 0;
  let inventoryCost = 0;
  const fills = [];

  for (const level of [...asks].sort((a, b) => a.price - b.price)) {
    const allInPerShare = level.price + bidPrice;
    if (!(allInPerShare > 0) || cashLeft <= 0) break;
    const take = Math.min(level.size, cashLeft / allInPerShare);
    if (take <= 0) continue;
    shares += take;
    inventoryCost += take * level.price;
    cashLeft -= take * allInPerShare;
    fills.push({ price: level.price, size: take });
    if (take < level.size) break;
  }

  return {
    shares,
    inventoryCost,
    bidReserve: shares * bidPrice,
    cashLeft,
    averageAsk: shares > 0 ? inventoryCost / shares : 0,
    fills,
  };
}

export function applyQueueTrade(order, tradedSize, crossesDeeper = false) {
  if (!order || order.remaining <= 0 || tradedSize <= 0) return { filled: 0, order };
  const next = { ...order };
  let available = tradedSize;
  if (!crossesDeeper && next.queueAhead > 0) {
    const consumed = Math.min(next.queueAhead, available);
    next.queueAhead -= consumed;
    available -= consumed;
  } else if (crossesDeeper) {
    next.queueAhead = 0;
    available = Math.max(available, next.remaining);
  }
  const filled = Math.min(next.remaining, available);
  next.remaining -= filled;
  return { filled, order: next };
}

export function mergeCompleteSets(firstPosition, secondPosition) {
  const merged = Math.min(firstPosition, secondPosition);
  return {
    merged,
    firstPosition: firstPosition - merged,
    secondPosition: secondPosition - merged,
    cashReleased: merged,
  };
}

export function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}
