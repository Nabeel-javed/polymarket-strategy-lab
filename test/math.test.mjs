import test from "node:test";
import assert from "node:assert/strict";
import {
  applyQueueTrade,
  consumeAsksForBudget,
  estimatedRewardShare,
  feeEquivalent,
  makerRebate,
  maxPairedBidShares,
  mergeCompleteSets,
  orderScoreFactor,
} from "../src/math.mjs";

test("crypto fee equivalent and maker rebate at 50 cents", () => {
  assert.ok(Math.abs(feeEquivalent(20, 0.5) - 0.35) < 1e-12);
  assert.ok(Math.abs(makerRebate(20, 0.5) - 0.07) < 1e-12);
});

test("LP score is one quarter at half of maximum spread", () => {
  assert.ok(Math.abs(orderScoreFactor(4, 0.5, 0.48) - 0.25) < 1e-12);
  assert.equal(orderScoreFactor(4, 0.5, 0.46), 0);
});

test("reward share is pro rata", () => {
  assert.equal(estimatedRewardShare(100, 900), 0.1);
  assert.equal(estimatedRewardShare(0, 900), 0);
});

test("paired bid allocation respects total active budget", () => {
  assert.equal(maxPairedBidShares(30, 0.49, 0.49), 30.61);
});

test("inventory acquisition includes the resting bid reserve", () => {
  const result = consumeAsksForBudget(
    [
      { price: 0.046, size: 1_000 },
      { price: 0.047, size: 1_000 },
    ],
    0.045,
    60,
  );
  assert.ok(Math.abs(result.shares - 659.3406593406594) < 1e-8);
  assert.ok(Math.abs(result.inventoryCost + result.bidReserve - 60) < 1e-8);
});

test("queue-ahead prevents optimistic fills", () => {
  const original = { price: 0.49, remaining: 20, queueAhead: 100 };
  const first = applyQueueTrade(original, 60, false);
  assert.equal(first.filled, 0);
  assert.equal(first.order.queueAhead, 40);
  const second = applyQueueTrade(first.order, 50, false);
  assert.equal(second.filled, 10);
  assert.equal(second.order.remaining, 10);
});

test("a trade deeper than our order implies our order was consumed", () => {
  const result = applyQueueTrade({ price: 0.49, remaining: 20, queueAhead: 100 }, 1, true);
  assert.equal(result.filled, 20);
  assert.equal(result.order.remaining, 0);
});

test("complete outcome sets merge one-for-one into cash", () => {
  assert.deepEqual(mergeCompleteSets(12, 8), {
    merged: 8,
    firstPosition: 4,
    secondPosition: 0,
    cashReleased: 8,
  });
});
