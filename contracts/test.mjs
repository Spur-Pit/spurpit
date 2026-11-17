// End-to-end Hardhat fork test of SpurPit against live Robinhood Chain (4663) & real Pons V2 curves.
import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";
import { readFileSync } from "node:fs";

const RPC = process.env.RPC || "http://127.0.0.1:8548";
const { abi, bytecode } = JSON.parse(readFileSync(new URL("./build/SpurPit.json", import.meta.url)));
const chain = {
  id: 4663,
  name: "rh-fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 60_000 }) });
const raw = (method, params = []) => pub.request({ method, params });

const DEAD = "0x000000000000000000000000000000000000dEaD";
const TOKEN_A = "0x7e270fbd339c5b6cbddb8db6821ec94184f902fb"; // real Pons V2 token on curve (~0.90 ETH reserve)
const CURVE_A = "0xe88b21bef099BDF8536080c0e01a6770168e0333";
const TOKEN_B = "0x2fe05351f36c229651ebbc7a95dddea00eb3f709"; // real Pons V2 token on curve

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address, uint256) returns (bool)",
  "function approve(address, uint256) returns (bool)",
]);
const CURVE_ABI = parseAbi([
  "function buy(uint256 quoteIn, uint256 minOut, address recipient) payable returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function graduated() view returns (bool)",
]);

let fails = 0;
let passes = 0;
const ok = (name, good, detail = "") => {
  if (good) passes++;
  else fails++;
  console.log(`${good ? "PASS" : "FAIL"} ${name}${detail ? " | " + detail : ""}`);
};

const wallet = async (ethAmt = "50") => {
  const account = privateKeyToAccount(generatePrivateKey());
  await raw("hardhat_setBalance", [account.address, "0x" + parseEther(ethAmt).toString(16)]);
  return { account, w: createWalletClient({ account, chain, transport: http(RPC, { timeout: 60_000 }) }) };
};

const send = async (who, to, data, value = 0n) => {
  const hash = await who.w.sendTransaction({ to, data, value, gas: 1_200_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("tx reverted: " + hash);
  return r;
};

const reason = async (who, to, data, value = 0n) => {
  try {
    await pub.call({ account: who.account.address, to, data, value });
    return "no revert";
  } catch (e) {
    const d = e?.cause?.data || e?.data || e?.details?.match(/0x[0-9a-f]+/)?.[0] || e?.walk?.((x) => x?.data)?.data;
    try {
      return decodeErrorResult({ abi, data: typeof d === "string" ? d : d?.data }).errorName;
    } catch {
      return (e.shortMessage || e.message).slice(0, 90);
    }
  }
};

const jump = async (secs) => {
  await raw("evm_increaseTime", [secs]);
  await raw("evm_mine", []);
};

const bal = (t, a) => pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [a] });
const eth = (a) => pub.getBalance({ address: a });
const callPit = (fn, args = []) => encodeFunctionData({ abi, functionName: fn, args });
const readPit = (pit, fn, args = []) => pub.readContract({ address: pit, abi, functionName: fn, args });

// Deploy SpurPit
const deployer = await wallet();
const deployTx = await deployer.w.deployContract({ abi, bytecode, args: [], gas: 4_500_000n });
const pit = (await pub.waitForTransactionReceipt({ hash: deployTx })).contractAddress;
ok("0a SpurPit deployed on Robinhood Chain fork", Boolean(pit), pit);

// Bind a real Pons V2 token ($TOKEN_A acts as our live curve-backed $SPUR stand-in on fork)
const alice = await wallet();
const bob = await wallet();
const carol = await wallet(); // Ringside staker
const promo = await wallet(); // Promoter (>= 1M staked)
const keeper = await wallet();

ok(
  "0b non-deployer cannot bindSpur",
  (await reason(alice, pit, callPit("bindSpur", [TOKEN_A]))) === "OnlyDeployer",
);
await send(deployer, pit, callPit("bindSpur", [TOKEN_A]));
ok(
  "0c bindSpur locks permanently after first call",
  (await reason(deployer, pit, callPit("bindSpur", [TOKEN_B]))) === "AlreadyBound",
);

// Buy real curve tokens for promo, carol, and whale so staking, feature burns, and HAND_CHECK use 100% live Pons curve tokens
await send(promo, CURVE_A, encodeFunctionData({ abi: CURVE_ABI, functionName: "buy", args: [parseEther("0.15"), 0n, promo.account.address] }), parseEther("0.15"));
await send(carol, CURVE_A, encodeFunctionData({ abi: CURVE_ABI, functionName: "buy", args: [parseEther("0.08"), 0n, carol.account.address] }), parseEther("0.08"));
const promoTokBal = await bal(TOKEN_A, promo.account.address);
const carolTokBal = await bal(TOKEN_A, carol.account.address);
ok("0d bought real tokens from Pons bonding curve", promoTokBal > parseEther("2000000") && carolTokBal > parseEther("1000000"));

// Stake in Ringside: promo stakes 1.5M (>= 1M PROMOTER_MIN), carol stakes 500K (total 2.0M staked -> 75% / 25% split)
await send(promo, TOKEN_A, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [pit, 2n ** 256n - 1n] }));
await send(carol, TOKEN_A, encodeFunctionData({ abi: ERC20, functionName: "approve", args: [pit, 2n ** 256n - 1n] }));
await send(promo, pit, callPit("stakeSpur", [parseEther("1500000")]));
await send(carol, pit, callPit("stakeSpur", [parseEther("500000")]));
ok("0e Ringside staking active", (await readPit(pit, "totalStaked")) === parseEther("2000000"));

// ─── 1. Open & Cancel unmatched bout (100% refund, zero fee) ──────────────────
{
  const stake = parseEther("0.2");
  await send(alice, pit, callPit("openBout", [{
    mode: 0, makerSideA: true, tokenA: TOKEN_B, tokenB: "0x0000000000000000000000000000000000000000",
    opponent: bob.account.address, promoter: "0x0000000000000000000000000000000000000000",
    targetValue: 0n, joinWindow: 600n, duration: 3600n, callout: "Bet you will not take this",
  }]), stake);

  ok(
    "1a named rival blocks strangers from matching",
    (await reason(carol, pit, callPit("matchBout", [1n]), stake)) === "ReservedForRival",
  );
  ok(
    "1b stranger cannot cancel before joinBy",
    (await reason(carol, pit, callPit("cancelBout", [1n]))) === "JoinWindowStillOpen",
  );
  const a0 = await eth(alice.account.address);
  const r = await send(alice, pit, callPit("cancelBout", [1n]));
  const gasCost = r.gasUsed * r.effectiveGasPrice;
  const a1 = await eth(alice.account.address);
  ok("1c maker cancel refunds exact 100% stake", a1 + gasCost - a0 === stake);
}

// ─── 2. Mode.HAND_CHECK — Instant Early KO when watched whale dumps 1 token ───
{
  const stake = parseEther("1");
  // Carol holds real tokens; Alice bets DUMP (makerSideA = false), Bob matches HOLD
  await send(alice, pit, callPit("openBout", [{
    mode: 3, makerSideA: false, tokenA: TOKEN_A, tokenB: carol.account.address,
    opponent: "0x0000000000000000000000000000000000000000", promoter: promo.account.address,
    targetValue: 0n, joinWindow: 600n, duration: 7200n, callout: "Whale dumps within 2h",
  }]), stake);

  await send(bob, pit, callPit("matchBout", [2n]), stake);

  // Feature burn: promo burns 50K tokens to pin Main Event
  const dead0 = await bal(TOKEN_A, DEAD);
  await send(promo, pit, callPit("featureBout", [2n]));
  const dead1 = await bal(TOKEN_A, DEAD);
  ok("2a featureBout burns 50,000 tokens straight to 0x...dEaD", dead1 - dead0 === parseEther("50000"));

  // Cannot settle before deadline while whale holds
  ok("2b cannot settle HAND_CHECK while whale still holds before deadline", (await reason(alice, pit, callPit("settle", [2n]))) === "TooEarlyToSettle");

  // Carol transfers just 1 wei of token -> instant KO!
  await send(carol, TOKEN_A, encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [bob.account.address, 1n] }));

  const aBefore = await eth(alice.account.address);
  const sTx = await send(keeper, pit, callPit("settle", [2n]));
  const aAfter = await eth(alice.account.address);

  // Pot = 2 ETH; Fee = 3% = 0.06 ETH; Alice payout = 1.94 ETH
  ok("2c instant early KO pays DUMP bettor 1.94 ETH without waiting for deadline", aAfter - aBefore === parseEther("1.94"), `gas ${sTx.gasUsed}`);

  // Verify exact fee split:
  // Promoter cut = 0.5% of 2 ETH = 0.01 ETH (to promo)
  // Ringside cut = 1.25% of 2 ETH = 0.025 ETH (75% promo = 0.01875, 25% carol = 0.00625)
  // Burn bucket  = 1.25% of 2 ETH = 0.025 ETH
  const [promoRing, promoDirect] = await readPit(pit, "earnedEth", [promo.account.address]);
  const [carolRing] = await readPit(pit, "earnedEth", [carol.account.address]);
  const bucket = await readPit(pit, "burnBucket");
  ok(
    "2d fee split routes exact ETH to Promoter, Ringside stakers, and Burn Bucket",
    promoDirect === parseEther("0.01") &&
      promoRing === parseEther("0.01875") &&
      carolRing === parseEther("0.00625") &&
      bucket === parseEther("0.025"),
  );
}

// ─── 3. Autonomous Buyback & Burn (ignite) on real Pons bonding curve + ETH claims ───
{
  const deadBefore = await bal(TOKEN_A, DEAD);
  const kBefore = await eth(keeper.account.address);
  const igTx = await send(keeper, pit, callPit("ignite", []));
  const igGas = igTx.gasUsed * igTx.effectiveGasPrice;
  const kAfter = await eth(keeper.account.address);
  const deadAfter = await bal(TOKEN_A, DEAD);

  const tipExpected = parseEther("0.00025"); // 1% of 0.025 ETH
  ok(
    "3a ignite() buys real tokens from Pons curve straight to 0x...dEaD and pays 1% caller tip",
    deadAfter > deadBefore && kAfter + igGas - kBefore === tipExpected && (await readPit(pit, "burnBucket")) === 0n,
    `burned ${(deadAfter - deadBefore) / 10n ** 18n} tokens`,
  );

  // Promo claims both Ringside ETH + Promoter Cut ETH in one tx (0.01875 + 0.01 = 0.02875 ETH)
  const p0 = await eth(promo.account.address);
  const cTx = await send(promo, pit, callPit("claimEth", []));
  const cGas = cTx.gasUsed * cTx.effectiveGasPrice;
  const p1 = await eth(promo.account.address);
  ok("3b staker/promoter claims real ETH yield cleanly", p1 + cGas - p0 === parseEther("0.02875"));
}

// ─── 4. Mode.CLASH (Token A vs Token B) + Mode.GRADUATION early KO on real Pons curve ───
{
  const stake = parseEther("0.1");
  // Bout 3: CLASH TOKEN_A vs TOKEN_B (Alice picks TOKEN_A, Bob picks TOKEN_B)
  await send(alice, pit, callPit("openBout", [{
    mode: 2, makerSideA: true, tokenA: TOKEN_A, tokenB: TOKEN_B,
    opponent: "0x0000000000000000000000000000000000000000", promoter: "0x0000000000000000000000000000000000000000",
    targetValue: 0n, joinWindow: 300n, duration: 1200n, callout: "TOKEN_A reserve crushes TOKEN_B",
  }]), stake);
  await send(bob, pit, callPit("matchBout", [3n]), stake);

  await jump(1205);
  const a0 = await eth(alice.account.address);
  await send(keeper, pit, callPit("settle", [3n]));
  const a1 = await eth(alice.account.address);
  ok("4a CLASH settles by realQuoteReserve() on Pons curves", a1 - a0 === parseEther("0.194"));

  // Bout 4: GRADUATION on TOKEN_A — push TOKEN_A curve past 4.2 ETH graduation threshold and verify instant early KO!
  await send(alice, pit, callPit("openBout", [{
    mode: 0, makerSideA: true, tokenA: TOKEN_A, tokenB: "0x0000000000000000000000000000000000000000",
    opponent: "0x0000000000000000000000000000000000000000", promoter: "0x0000000000000000000000000000000000000000",
    targetValue: 0n, joinWindow: 600n, duration: 86400n, callout: "Graduates today",
  }]), stake);
  await send(bob, pit, callPit("matchBout", [4n]), stake);

  // Whale buys 5 ETH on TOKEN_A curve -> triggers real Pons graduation on the fork!
  await send(carol, CURVE_A, encodeFunctionData({ abi: CURVE_ABI, functionName: "buy", args: [parseEther("5"), 0n, carol.account.address] }), parseEther("5"));
  const isGrad = await pub.readContract({ address: CURVE_A, abi: CURVE_ABI, functionName: "graduated" });
  ok("4b real Pons bonding curve graduated on fork", isGrad === true);

  // Settle immediately (23 hours BEFORE resolveAt!) -> early KO works!
  const aBeforeKo = await eth(alice.account.address);
  await send(keeper, pit, callPit("settle", [4n]));
  const aAfterKo = await eth(alice.account.address);
  ok("4c GRADUATION settles immediately by early KO the block curve graduates", aAfterKo - aBeforeKo === parseEther("0.194"));
}

console.log(`\nSummary: ${passes} passed, ${fails} failed`);
if (fails > 0) process.exit(1);
