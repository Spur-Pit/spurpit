# SPUR Pit (`$SPURPIT`) — 1v1 On-Chain ETH Duels on Robinhood Chain

**Two wallets enter. The chain pays one.**

- **Arena:** https://spurpit.family
- **SpurPit Contract (Robinhood Chain, 4663):** [`0xd4943bd7558d3740b816a620936f7fd9ceded542`](https://robinhoodchain.blockscout.com/address/0xd4943bd7558d3740b816a620936f7fd9ceded542) · [Sourcify `exact_match`](https://repo.sourcify.dev/4663/0xd4943bd7558d3740b816a620936f7fd9ceded542)
- **X:** https://x.com/spurpitfamily
- **Source:** https://github.com/Spur-Pit/spurpit

SPUR Pit (`SpurPit.sol`) is a non-custodial 1v1 ETH escrow arena built directly over `PonsV2LaunchFactory` (`0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`) on **Robinhood Chain (Chain ID 4663)**. Two traders lock equal ETH stakes on live Pons bonding curve outcomes and settle directly from on-chain contract state—zero oracles, zero human referees, zero admin custody over user funds.

## Four Permissionless Fight Modes

1. **`GRADUATION` (Curve Escape)** — Will `tokenA` graduate off its 4.20 ETH Pons bonding curve before `resolveAt`? Instant early KO the exact block `graduated()` flips true.
2. **`CURVE_LINE` (Reserve Over / Under)** — Will `curve.realQuoteReserve()` be `>= targetValue` in ETH at `resolveAt` (or graduate early)?
3. **`CLASH` (Token A vs Token B)** — Head-to-head race between two live Pons launches. First to graduate wins by instant KO; otherwise the higher ETH curve reserve at `resolveAt` takes the pot.
4. **`HAND_CHECK` (Whale / Deployer Accountability)** — Snapshots the `ERC20.balanceOf` of the token deployer or any named whale wallet at opening. If even 1 token leaves before `resolveAt`, `PAPER HANDS` wins by instant KO.

## `$SPURPIT` On-Chain Token Engine (3.00% Pot Fee, Zero Team Wallet Tax)

Every settled bout routes a flat `3.00%` protocol cut inside `SpurPit.sol`:
- **`1.25%` in native ETH → Ringside Stakers:** Distributed block-by-block via `accEthPerShare` to `$SPURPIT` stakers with zero lockup, claimable anytime via `claimEth()`.
- **`1.25%+` in native ETH → Autonomous Buyback & Burn (`ignite()`):** Accumulates in `burnBucket`. Anyone can call `ignite()` to buy `$SPURPIT` on the Pons bonding curve (or Uniswap V4 pool post-graduation) straight to `0x000000000000000000000000000000000000dEaD`, paying a `1.00%` ETH gas tip to the caller.
- **`0.50%` in native ETH → Promoter Cut:** Paid in ETH to bout openers/promoters staking `>= 1,000,000 $SPURPIT`.
- **`50,000 $SPURPIT` Burn → Main Event Pin (`featureBout`):** Burns `50K $SPURPIT` directly to `0x…dEaD` to pin `★ MAIN EVENT` status onto an active bout.

## Build & Test

```bash
# Compile SpurPit.sol + generate Sourcify Standard JSON & deploy.html
node contracts/compile.mjs

# Run 17-case Hardhat fork test suite against live Robinhood Chain (4663)
node contracts/test.mjs

# Run local worker + arena UI
node worker/dev-server.mjs
```

## License

MIT.
