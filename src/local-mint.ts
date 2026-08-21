import chalk from "chalk";
import { performance } from "perf_hooks";
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { buildLocalMintPlan, LocalMintPlan } from "./seadrop-public";
import { assertAggregateSupply, diffMintPlans, inspectWallets, validateMintTarget } from "./safety";

export interface LocalSnipeOpts {
  nftContract: string;
  quantity: number;
  walletKeys: string[];
  rpcUrls: string[];
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
  targetStart: Date | null;
  plan: LocalMintPlan;
}

export async function localPublicSnipe(opts: LocalSnipeOpts): Promise<void> {
  const {
    nftContract, quantity, walletKeys, rpcUrls,
    maxFeePerGas, maxPriorityFee, gasLimit, targetStart, plan,
  } = opts;

  const provider = new JsonRpcProvider(rpcUrls[0]);
  const endpoints = parseRpcEndpoints(rpcUrls);
  const walletCount = walletKeys.length;

  // Large wallet sets need time for throttled/retried RPC reads. Do the expensive
  // safety work early, then keep the T-0 critical path limited to a fresh config
  // read, fee check, pending nonces, signing, and broadcast.
  const configuredHeavyLead = Number(process.env.PREPARE_LEAD_MS || "0");
  const configuredSignLead = Number(process.env.SIGN_LEAD_MS || "0");
  const dynamicSignLead = Math.max(15_000, Math.min(45_000, 10_000 + walletCount * 250));
  const signLeadMs = Number.isFinite(configuredSignLead) && configuredSignLead > 0
    ? Math.max(dynamicSignLead, Math.floor(configuredSignLead))
    : dynamicSignLead;
  const dynamicHeavyLead = Math.max(45_000, 45_000 + walletCount * 1_000, signLeadMs + 30_000);
  const prepareLeadMs = Number.isFinite(configuredHeavyLead) && configuredHeavyLead > 0
    ? Math.max(dynamicHeavyLead, Math.floor(configuredHeavyLead))
    : dynamicHeavyLead;

  console.log(chalk.bold.magenta("\n── SAFE LOCAL PUBLIC MINT ──"));
  console.log(chalk.gray(`  NFT:           ${nftContract}`));
  console.log(chalk.gray(`  SeaDrop:       ${plan.to}`));
  console.log(chalk.gray(`  Fee recipient: ${plan.feeRecipient}`));
  console.log(chalk.gray(`  Price:         ${formatEther(plan.drop.mintPrice)} × ${quantity} = ${formatEther(plan.value)} per wallet`));

  if (targetStart) {
    console.log(chalk.gray(`  Heavy safety preflight: about T-${Math.round(prepareLeadMs / 1000)}s.`));
    console.log(chalk.gray(`  Critical nonce/sign window: about T-${Math.round(signLeadMs / 1000)}s.`));
    await waitUntil(targetStart.getTime() - prepareLeadMs);
  }

  const wallets = walletKeys.map((key) => new Wallet(key, provider));
  walletKeys.fill("");

  console.log(chalk.bold.white("\n  SAFE heavy preflight..."));
  const heavyPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!heavyPlan) throw new Error("Public SeaDrop config is no longer readable.");

  const heavyChanges = diffMintPlans(plan, heavyPlan);
  if (heavyChanges.length > 0) {
    console.log(chalk.bold.red("  Mint configuration changed after confirmation:"));
    for (const change of heavyChanges) console.log(chalk.red(`    - ${change}`));
    throw new Error("SAFE mode refuses to sign a stale mint plan.");
  }

  await validateMintTarget(provider, nftContract, heavyPlan);
  if (Math.floor(Date.now() / 1000) > heavyPlan.drop.endTime) {
    throw new Error("Public stage ended before final signing.");
  }

  const states = await inspectWallets(
    provider,
    nftContract,
    wallets.map((w) => w.address),
    quantity,
    heavyPlan.drop.maxTotalMintableByWallet
  );
  const blocked = states.filter((s) => !s.eligible);
  if (blocked.length) {
    for (const state of blocked) console.log(chalk.red(`  ✗ ${state.address}: ${state.reason}`));
    throw new Error("Wallet quota/supply changed before T-0 — nothing signed.");
  }
  assertAggregateSupply(states, quantity, wallets.length);

  const effectiveGasLimit = gasLimit || 250_000;
  const required = BigInt(effectiveGasLimit) * maxFeePerGas + heavyPlan.value;
  const balances = await Promise.all(wallets.map((w) => provider.getBalance(w.address)));
  if (balances.some((b) => b < required)) {
    throw new Error("At least one wallet became underfunded before final signing.");
  }

  await assertFeeCeiling(provider, maxFeePerGas);
  await warmConnections(rpcUrls);
  console.log(chalk.green(`  ✓ Heavy preflight PASS for ${wallets.length} wallet(s).`));

  if (targetStart) {
    await waitUntil(targetStart.getTime() - signLeadMs);
  }

  console.log(chalk.bold.white("\n  SAFE critical preflight..."));
  const criticalPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!criticalPlan) throw new Error("Public SeaDrop config became unreadable in the critical window.");

  const criticalChanges = diffMintPlans(heavyPlan, criticalPlan);
  if (criticalChanges.length > 0) {
    console.log(chalk.bold.red("  Mint configuration changed during final wait:"));
    for (const change of criticalChanges) console.log(chalk.red(`    - ${change}`));
    throw new Error("SAFE mode refuses to sign after a mint-plan change.");
  }

  await validateMintTarget(provider, nftContract, criticalPlan);
  if (Math.floor(Date.now() / 1000) > criticalPlan.drop.endTime) {
    throw new Error("Public stage ended before critical signing.");
  }
  await assertFeeCeiling(provider, maxFeePerGas);

  const nonceStart = performance.now();
  const [nonces, network] = await Promise.all([
    Promise.all(wallets.map((w) => provider.getTransactionCount(w.address, "pending"))),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;
  console.log(chalk.gray(`  ✓ Pending nonces read in ${(performance.now() - nonceStart).toFixed(1)}ms | chainId: ${chainId}`));

  const signStart = performance.now();
  const prepared: { idx: number; address: string; blast: PreparedBlast }[] = [];
  for (let i = 0; i < wallets.length; i++) {
    const rawTx = await wallets[i].signTransaction({
      to: criticalPlan.to,
      data: criticalPlan.data,
      value: criticalPlan.value,
      nonce: nonces[i],
      maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFee,
      gasLimit: effectiveGasLimit,
      type: 2,
      chainId,
    });
    prepared.push({ idx: i, address: wallets[i].address, blast: prepareBlast(rawTx) });
  }
  console.log(chalk.green(`  ✓ ${prepared.length} tx(s) signed in ${(performance.now() - signStart).toFixed(1)}ms.`));

  // Refresh TCP/TLS shortly before T-0 when there is enough headroom. Skip this
  // if we are already too close so connection warming can never delay dispatch.
  if (!targetStart || targetStart.getTime() - Date.now() > 3_000) {
    await warmConnections(rpcUrls);
  }

  if (targetStart) await waitForMintTime(targetStart, 0);
  else console.log(chalk.bold.yellow("\n  🚀 Firing immediately..."));

  const stageStartMs = targetStart ? targetStart.getTime() : Date.now();
  const dispatchStart = performance.now();
  const fired = prepared.map(({ idx, address, blast }) => {
    const { txHash, responsePromise } = blastToAll(blast, endpoints);
    return { idx, address, txHash, responsePromise };
  });

  const latenessMs = Math.max(0, Date.now() - stageStartMs);
  console.log(chalk.bold.green(`  DISPATCHED ${fired.length} tx(s) (${(performance.now() - dispatchStart).toFixed(2)}ms, +${latenessMs}ms after stage)`));
  for (const f of fired) console.log(chalk.gray(`    [W${f.idx}] ${f.txHash}`));

  const settled = await Promise.all(fired.map(async (f) => ({ ...f, results: await f.responsePromise })));
  const accepted = settled.filter(({ results }) =>
    results.some((r) => r.txHash !== null || (r.error ?? "").includes("already known"))
  );
  const rejected = settled.filter((s) => !accepted.includes(s));

  for (const { idx, results } of rejected) {
    const reasons = [...new Set(results.map((r) => r.error).filter(Boolean))];
    console.log(chalk.bold.red(`\n  ✗ [W${idx}] REJECTED by every RPC.`));
    for (const reason of reasons) console.log(chalk.red(`      ${reason}`));
  }

  if (accepted.length === 0) {
    console.log(chalk.bold.red("\n===== NOTHING WAS BROADCAST =====\n"));
    return;
  }

  console.log(chalk.gray("\n  Waiting for receipts..."));
  await Promise.all(accepted.map(async ({ idx, txHash }) => {
    const receipt = await waitForReceipt(txHash, rpcUrls[0], 60_000);
    if (!receipt) {
      console.log(chalk.yellow(`  [W${idx}] TIMEOUT — check: ${explorerTx(chainId, txHash)}`));
      return;
    }
    const color = receipt.status === "SUCCESS" ? chalk.bold.green : chalk.bold.red;
    console.log(color(`  [W${idx}] Block: ${receipt.block} | Pos: ${receipt.position} | ${receipt.status} | Gas: ${receipt.gasUsed}`));
    console.log(chalk.gray(`  [W${idx}] Track: ${explorerTx(chainId, txHash)}`));
  }));

  console.log(chalk.bold.white("\n===== SAFE LOCAL PUBLIC MINT COMPLETE ====="));
}

async function assertFeeCeiling(provider: JsonRpcProvider, maxFeePerGas: bigint): Promise<void> {
  const latest = await provider.getBlock("latest");
  if (latest?.baseFeePerGas !== null && latest?.baseFeePerGas !== undefined && maxFeePerGas < latest.baseFeePerGas) {
    throw new Error(`Selected max fee is below latest base fee (${latest.baseFeePerGas} wei).`);
  }
}

async function waitUntil(epochMs: number): Promise<void> {
  const delay = epochMs - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}
