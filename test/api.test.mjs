import test from "node:test";
import assert from "node:assert/strict";
import { cryptoSlug, normalizeBook, parseJsonArray } from "../src/api.mjs";

test("crypto slug rounds down to the current interval", () => {
  assert.equal(cryptoSlug(15, 1_787_956_948), "btc-updown-15m-1787956200");
  assert.equal(cryptoSlug(5, 1_787_956_948), "btc-updown-5m-1787956800");
});

test("book normalization sorts the economically best levels first", () => {
  const book = normalizeBook({
    asset_id: "token",
    bids: [{ price: "0.4", size: "2" }, { price: "0.5", size: "1" }],
    asks: [{ price: "0.7", size: "2" }, { price: "0.6", size: "1" }],
    tick_size: "0.01",
    min_order_size: "5",
    timestamp: "123",
  });
  assert.equal(book.bestBid, 0.5);
  assert.equal(book.bestAsk, 0.6);
  assert.equal(book.bids[0].size, 1);
});

test("JSON array fields fail closed", () => {
  assert.deepEqual(parseJsonArray('["Up","Down"]'), ["Up", "Down"]);
  assert.deepEqual(parseJsonArray("bad"), []);
});
