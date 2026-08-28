# Initial $200 paper test

Validated run: `runs/2026-08-28T23-03-19-704Z`

- Start: 2026-08-28 23:03:19 UTC
- End: 2026-08-28 23:17:20 UTC
- Virtual capital: $200 total
- Allocation: $100 long LP plus $100 BTC 15-minute maker rebates
- Active limits: $60 long LP and $30 crypto
- Wallets, authentication, orders, and funds: none
- Realtime feed: 147,517 messages, 2,227 trades, zero feed errors

## Long-duration LP rewards

- Market: Will Iran withdraw from the NPT before 2027?
- Cheap-outcome book: 8.8-cent bid / 8.9-cent ask
- Initial inventory acquisition: $30.377176
- Initial executable equity after crossing the book: $99.245648
- Initial spread/mark loss: $0.754352
- Estimated reward rate at the observed competition: $1.605925/day
- Reward accrued during the run: $0.015403
- Fills: 0
- Final equity: $99.261051
- Net P&L: -$0.738949
- Static break-even estimate: about 11.3 hours, if price, pool, competition,
  eligibility, and inventory remain unchanged

This strategy did not become profitable during the short run. It remains a
candidate for a 24-hour paper test because its estimated daily reward exceeded the
$1 payout threshold and its loss was the known inventory-entry spread rather than
an adverse fill.

## BTC 15-minute maker rebates

- Market: Bitcoin Up or Down - August 28, 7:00PM-7:15PM ET
- Simulated maker fills: 19
- Complete sets merged: 238.41
- Estimated rebates: $1.201509
- Peak equity: $101.177598
- Minimum/final equity: $74.923780
- Ending inventory: 30.3 losing Down shares, marked at $0
- Net P&L: -$25.076220
- Peak-to-final drawdown: $26.253818

The passive maker hedge did not fill quickly enough. Rebate income covered less
than 5% of the final loss. This version is a no-go for real money, and the
five-minute variant should not be enabled with the same risk model.

## Combined

- Final equity: $174.184831
- Net P&L: -$25.815169
- Return on the virtual $200: -12.91%

The initial comparison favors continued paper testing of long-duration LP rewards.
It rejects the current short-crypto passive maker strategy.
