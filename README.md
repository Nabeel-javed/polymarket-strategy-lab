# Polymarket Strategy Lab

Read-only paper trading for two strategies with a virtual $200 portfolio:

- $100 long-duration liquidity rewards
- $100 BTC 15-minute maker rebates

The runner performs only unauthenticated HTTP `GET` requests. It has no order-signing,
wallet, allowance, deposit, or order-submission code.

Fill events come from Polymarket's current public market WebSocket at
`wss://ws-subscriptions-clob.polymarket.com/ws/market`. REST trade history is not
used during a normal run because it can backfill old trades after a delay.

## Model

Long-duration LP:

- discovers active cheap-outcome markets with a daily reward pool;
- excludes wide spreads and markets ending in fewer than seven days;
- simulates purchasing inventory from executable asks;
- posts a bid and ask at the visible book;
- joins behind visible queue depth;
- accrues an estimated pro-rata reward only while both legs qualify;
- marks inventory at the executable bid.

BTC maker rebates:

- discovers the current or next BTC 15-minute market;
- posts paired outcome bids using no more than $30 active capital;
- joins behind visible queue depth and fills only from subsequent public trades;
- cancels directional replenishment after a fill and quotes only the hedge;
- merges complete outcome sets for $1;
- stops quoting 90 seconds before expiry;
- estimates rebates with the market's live fee schedule.

Public books cannot reveal per-maker LP reward attribution or exact queue identity.
Results are estimates and must not be treated as executable profits.

## Run

```sh
npm test
npm run smoke
npm run dry-run
```

Options:

```sh
node src/paper-runner.mjs \
  --duration 1200 \
  --poll 5 \
  --total 200 \
  --crypto-window 15 \
  --lp-active 60 \
  --crypto-active 30
```

Each run writes `metadata.json`, `events.jsonl`, and `summary.json` under `runs/`.

## Seven-day GitHub experiment

The workflow in `.github/workflows/week-paper-test.yml` runs the same virtual
$200 portfolio for seven days without requiring a laptop to stay online. GitHub-hosted
jobs are capped at six hours, so each job runs for five and a half hours, checkpoints
the strategy state, then dispatches a fresh continuation. The handoff is conservative:
orders rejoin the visible queue and no rewards or fills are credited during the gap.

Every BTC 15-minute market is settled before its ending equity becomes the starting
equity for the next market. Long-LP inventory, cash, reward estimates, and order sizes
carry across jobs. Raw per-segment evidence is retained as a workflow artifact for 14
days; cumulative state and the dashboard data are committed to the repository.

Start it manually with the workflow input `reset=true`. Continuations use
`reset=false` automatically. The static dashboard is deployed from `docs/` by the
same workflow. It is a display only: GitHub Pages never executes the simulator.
