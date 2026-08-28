const MARKET_SOCKET = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

export class MarketRealtimeFeed {
  constructor(assetIds) {
    this.assetIds = [...new Set(assetIds.map(String))];
    this.socket = null;
    this.buffers = new Map();
    this.connected = false;
    this.connectedAt = null;
    this.messages = 0;
    this.trades = 0;
    this.errors = [];
    this.pingTimer = null;
  }

  async connect({ timeoutMs = 10_000 } = {}) {
    if (this.assetIds.length === 0) throw new Error("Realtime feed requires asset ids");
    const socket = new WebSocket(MARKET_SOCKET);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket connection timed out")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        this.connected = true;
        this.connectedAt = Date.now();
        socket.send(JSON.stringify({ assets_ids: this.assetIds, type: "market" }));
        this.pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send("PING");
        }, 10_000);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        const error = new Error("Polymarket market WebSocket failed");
        this.errors.push(error.message);
        reject(error);
      }, { once: true });
    });
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", (event) => {
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (event.code !== 1000) this.errors.push(`WebSocket closed: ${event.code} ${event.reason}`);
    });
    return this.status();
  }

  handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      this.messages += 1;
      if (message?.event_type !== "last_trade_price") continue;
      const conditionId = String(message.market ?? "");
      if (!conditionId) continue;
      const trade = {
        conditionId,
        asset: String(message.asset_id),
        price: Number(message.price),
        size: Number(message.size),
        side: String(message.side ?? "BUY").toUpperCase(),
        timestamp: Number(message.timestamp),
        transactionHash: String(message.transaction_hash ?? ""),
        source: "clob_websocket",
      };
      if (!this.buffers.has(conditionId)) this.buffers.set(conditionId, []);
      this.buffers.get(conditionId).push(trade);
      this.trades += 1;
    }
  }

  drainTrades(conditionId) {
    const key = String(conditionId);
    const trades = this.buffers.get(key) ?? [];
    this.buffers.set(key, []);
    return trades;
  }

  status() {
    return {
      url: MARKET_SOCKET,
      connected: this.connected,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : null,
      assets: this.assetIds.length,
      messages: this.messages,
      trades: this.trades,
      errors: [...this.errors],
    };
  }

  close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "paper run complete");
    }
  }
}
