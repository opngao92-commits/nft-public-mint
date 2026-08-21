import chalk from "chalk";
import { performance } from "perf_hooks";
import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";
import { blastToAll, parseRpcEndpoints, prepareBlast, waitForReceipt, PreparedBlast, RpcEndpoint } from "./rpc-blast";
import { warmConnections } from "./connection-warmer";
import { waitForMintTime } from "./timer";
import { explorerTx } from "./chains";
import { buildLocalMintPlan, LocalMintPlan, PublicDrop, SEADROP_ADDRESS } from "./seadrop-public";
import { assertAggregateSupply, diffMintPlans, inspectWallets, validateMintTarget } from "./safety";

const WATCH_PUBLIC_ABI = [
  "function getPublicDrop(address nftContract) view returns (tuple(uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients))",
];

interface PreparedWalletTx {
  idx: number;
  address: string;
  blast: PreparedBlast;
}

interface WatchUpdate {
  plan: LocalMintPlan;
  targetStart: Date;
  active: boolean;
}

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
  const wallets = walletKeys.map((key) => new Wallet(key, provider));
  walletKeys.fill("");

  const effectiveGasLimit = gasLimit || 250_000;
  let activePlan = plan;
  let scheduledStart = targetStart ? new Date(targetStart.getTime()) : null;

  // "Wait for on-chain stage" resolves to the exact on-chain start timestamp.
  // Custom Vietnam time can be later, so exact equality lets us upgrade mode 1
  // to a live watcher without changing the wizard's public interface.
  const livePublicWatch = Boolean(
    scheduledStart && scheduledStart.getTime() === plan.drop.startTime * 1000
  );

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

  if (scheduledStart) {
    console.log(chalk.gray(`  Heavy safety preflight: about T-${Math.round(prepareLeadMs / 1000)}s.`));
    console.log(chalk.gray(`  Critical nonce/sign window: about T-${Math.round(signLeadMs / 1000)}s.`));
  }
  if (livePublicWatch && scheduledStart) {
    const pollMs = readBoundedInt("PUBLIC_WATCH_POLL_MS", 1000, 500, 10_000);
    console.log(chalk.bold.green(`  ✓ LIVE PUBLIC WATCH armed (${pollMs}ms poll).`));
    console.log(chalk.gray("    If SeaDrop moves public start earlier, SAFE will adopt it only when startTime is the sole plan change."));
    await warmConnections(rpcUrls);
  }

  // Phase 1: before heavy preflight. In live-watch mode, do not sleep blindly.
  // Poll only getPublicDrop() and immediately react if public is moved earlier.
  if (scheduledStart) {
    if (livePublicWatch) {
      for (;;) {
        const heavyAt = scheduledStart.getTime() - prepareLeadMs;
        const update = await watchUntilDeadline(
          provider, rpcUrls[0], nftContract, quantity, activePlan, heavyAt
        );
        if (!update) break;
        activePlan = update.plan;
        scheduledStart = update.targetStart;
        if (update.active) {
          console.log(chalk.bold.yellow("\n  ⚡ PUBLIC OPENED EARLY — switching to SAFE fast path."));
          await fireUnexpectedEarly({
            provider, endpoints, rpcUrls, wallets, nftContract, quantity,
            plan: activePlan, maxFeePerGas, maxPriorityFee, gasLimit: effectiveGasLimit,
          });
          return;
        }
      }
    } else {
      await waitUntil(scheduledStart.getTime() - prepareLeadMs);
    }
  }

  console.log(chalk.bold.white("\n  SAFE heavy preflight..."));
  const heavyCandidate = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!heavyCandidate) throw new Error("Public SeaDrop config is no longer readable.");

  const heavyReconcile = reconcilePlan(activePlan, heavyCandidate, livePublicWatch, "after confirmation");
  activePlan = heavyReconcile.plan;
  if (heavyReconcile.startMovedEarlier) {
    scheduledStart = new Date(activePlan.drop.startTime * 1000);
  }

  await validateMintTarget(provider, nftContract, activePlan);
  if (Math.floor(Date.now() / 1000) > activePlan.drop.endTime) {
    throw new Error("Public stage ended before final signing.");
  }

  const states = await inspectWallets(
    provider,
    nftContract,
    wallets.map((w) => w.address),
    quantity,
    activePlan.drop.maxTotalMintableByWallet
  );
  const blocked = states.filter((s) => !s.eligible);
  if (blocked.length) {
    for (const state of blocked) console.log(chalk.red(`  ✗ ${state.address}: ${state.reason}`));
    throw new Error("Wallet quota/supply changed before T-0 — nothing signed.");
  }
  assertAggregateSupply(states, quantity, wallets.length);

  const required = BigInt(effectiveGasLimit) * maxFeePerGas + activePlan.value;
  const balances = await Promise.all(wallets.map((w) => provider.getBalance(w.address)));
  if (balances.some((b) => b < required)) {
    throw new Error("At least one wallet became underfunded before final signing.");
  }

  await assertFeeCeiling(provider, maxFeePerGas);
  await warmConnections(rpcUrls);
  console.log(chalk.green(`  ✓ Heavy preflight PASS for ${wallets.length} wallet(s).`));

  // Phase 2: heavy checks are already done. Keep watching until the nonce/sign
  // window; if startTime is pulled forward and is already active, go directly
  // into the critical path instead of repeating the expensive wallet scan.
  if (scheduledStart) {
    if (livePublicWatch) {
      for (;;) {
        const signAt = scheduledStart.getTime() - signLeadMs;
        const update = await watchUntilDeadline(
          provider, rpcUrls[0], nftContract, quantity, activePlan, signAt
        );
        if (!update) break;
        activePlan = update.plan;
        scheduledStart = update.targetStart;
        if (update.active) {
          console.log(chalk.bold.yellow("\n  ⚡ PUBLIC OPENED EARLY after heavy preflight — signing now."));
          break;
        }
      }
    } else {
      await waitUntil(scheduledStart.getTime() - signLeadMs);
    }
  }

  console.log(chalk.bold.white("\n  SAFE critical preflight..."));
  const criticalCandidate = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!criticalCandidate) throw new Error("Public SeaDrop config became unreadable in the critical window.");

  const criticalReconcile = reconcilePlan(activePlan, criticalCandidate, livePublicWatch, "during final wait");
  activePlan = criticalReconcile.plan;
  if (criticalReconcile.startMovedEarlier) {
    scheduledStart = new Date(activePlan.drop.startTime * 1000);
  }

  await validateMintTarget(provider, nftContract, activePlan);
  if (Math.floor(Date.now() / 1000) > activePlan.drop.endTime) {
    throw new Error("Public stage ended before critical signing.");
  }
  await assertFeeCeiling(provider, maxFeePerGas);

  const nonceStart = performance.now();
  const [nonces, network] = await Promise.all([
    readPendingNoncesFast(provider, wallets.map((w) => w.address)),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;
  console.log(chalk.gray(`  ✓ Pending nonces read in ${(performance.now() - nonceStart).toFixed(1)}ms | chainId: ${chainId}`));

  const prepared = await signPreparedTransactions(
    wallets, activePlan, nonces, maxFeePerGas, maxPriorityFee, effectiveGasLimit, chainId
  );

  // Refresh TCP/TLS shortly before T-0 when there is enough headroom. Skip this
  // if we are already too close so connection warming can never delay dispatch.
  if (!scheduledStart || scheduledStart.getTime() - Date.now() > 3_000) {
    await warmConnections(rpcUrls);
  }

  // Phase 3: transactions are already signed. A safe startTime-only move can be
  // adopted without re-signing because startTime is not part of mintPublic calldata.
  if (scheduledStart && livePublicWatch) {
    for (;;) {
      const update = await watchUntilDeadline(
        provider, rpcUrls[0], nftContract, quantity, activePlan, scheduledStart.getTime()
      );
      if (!update) break;
      activePlan = update.plan;
      scheduledStart = update.targetStart;
      if (update.active) break;
    }
  }

  if (scheduledStart) await waitForMintTime(scheduledStart, 0);
  else console.log(chalk.bold.yellow("\n  🚀 Firing immediately..."));

  await broadcastPrepared(
    prepared,
    endpoints,
    rpcUrls,
    chainId,
    scheduledStart ? scheduledStart.getTime() : Date.now()
  );
}

async function fireUnexpectedEarly(args: {
  provider: JsonRpcProvider;
  endpoints: RpcEndpoint[];
  rpcUrls: string[];
  wallets: Wallet[];
  nftContract: string;
  quantity: number;
  plan: LocalMintPlan;
  maxFeePerGas: bigint;
  maxPriorityFee: bigint;
  gasLimit: number;
}): Promise<void> {
  const {
    provider, endpoints, rpcUrls, wallets, nftContract, quantity,
    maxFeePerGas, maxPriorityFee, gasLimit,
  } = args;

  // Full plan read verifies fee recipient and all immutable-to-this-arm fields.
  const fresh = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!fresh) throw new Error("Public SeaDrop config became unreadable after early activation.");
  const reconciled = reconcilePlan(args.plan, fresh, true, "during early activation");
  const plan = reconciled.plan;

  await validateMintTarget(provider, nftContract, plan);
  const nowSec = Math.floor(Date.now() / 1000);
  if (plan.drop.startTime > nowSec || plan.drop.endTime < nowSec) {
    throw new Error("Early-public watcher fired but the public stage is not currently active.");
  }
  await assertFeeCeiling(provider, maxFeePerGas);

  // The full wallet quota/balance scan already passed in the wizard before Fire.
  // Repeating 50-79 wallet eth_calls here can lose a surprise FCFS-to-public race,
  // so the emergency path probes one wallet for fresh global supply and verifies
  // aggregate supply before spending time on the mandatory pending nonces.
  const probe = await inspectWallets(
    provider,
    nftContract,
    [wallets[0].address],
    quantity,
    plan.drop.maxTotalMintableByWallet
  );
  if (!probe[0]?.eligible) {
    throw new Error(`Early-public supply/quota probe failed: ${probe[0]?.reason || "unknown reason"}.`);
  }
  const requested = BigInt(quantity) * BigInt(wallets.length);
  if (requested > probe[0].supplyRemaining) {
    throw new Error(`Early public has only ${probe[0].supplyRemaining} supply remaining, below requested ${requested}.`);
  }

  await warmConnections(rpcUrls);
  const nonceStart = performance.now();
  const [nonces, network] = await Promise.all([
    readPendingNoncesFast(provider, wallets.map((w) => w.address)),
    provider.getNetwork(),
  ]);
  const chainId = network.chainId;
  console.log(chalk.gray(`  ✓ EARLY pending nonces read in ${(performance.now() - nonceStart).toFixed(1)}ms | chainId: ${chainId}`));

  const prepared = await signPreparedTransactions(
    wallets, plan, nonces, maxFeePerGas, maxPriorityFee, gasLimit, chainId
  );

  console.log(chalk.bold.yellow("\n  🚀 EARLY PUBLIC ACTIVE — broadcasting now..."));
  await broadcastPrepared(prepared, endpoints, rpcUrls, chainId, plan.drop.startTime * 1000);
}

async function watchUntilDeadline(
  provider: JsonRpcProvider,
  rpcUrl: string,
  nftContract: string,
  quantity: number,
  baselinePlan: LocalMintPlan,
  deadlineMs: number
): Promise<WatchUpdate | null> {
  const pollMs = readBoundedInt("PUBLIC_WATCH_POLL_MS", 1000, 500, 10_000);

  for (;;) {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return null;

    const observed = await readPublicDropLight(provider, nftContract);
    if (observed && !samePublicDrop(baselinePlan.drop, observed)) {
      const candidate = await buildLocalMintPlan(rpcUrl, nftContract, quantity);
      if (!candidate) {
        throw new Error("Public SeaDrop config changed but could not be fully re-read.");
      }
      const reconciled = reconcilePlan(baselinePlan, candidate, true, "while live-watching public");
      if (reconciled.startMovedEarlier) {
        const targetStart = new Date(candidate.drop.startTime * 1000);
        const active = Date.now() >= targetStart.getTime() && Math.floor(Date.now() / 1000) <= candidate.drop.endTime;
        console.log(chalk.bold.yellow(
          `  ⚡ Public start moved earlier: ${formatWatchTime(baselinePlan.drop.startTime)} → ${formatWatchTime(candidate.drop.startTime)}${active ? " (ACTIVE NOW)" : ""}`
        ));
        return { plan: candidate, targetStart, active };
      }
    }

    const sleepMs = Math.min(pollMs, Math.max(50, deadlineMs - Date.now()));
    await sleep(sleepMs);
  }
}

function reconcilePlan(
  baseline: LocalMintPlan,
  candidate: LocalMintPlan,
  allowEarlierStartOnly: boolean,
  context: string
): { plan: LocalMintPlan; startMovedEarlier: boolean } {
  const changes = diffMintPlans(baseline, candidate);
  if (changes.length === 0) return { plan: candidate, startMovedEarlier: false };

  const startChanges = changes.filter((change) => change.startsWith("startTime:"));
  const otherChanges = changes.filter((change) => !change.startsWith("startTime:"));
  const movedEarlier = candidate.drop.startTime < baseline.drop.startTime;

  if (allowEarlierStartOnly && movedEarlier && startChanges.length === 1 && otherChanges.length === 0) {
    return { plan: candidate, startMovedEarlier: true };
  }

  console.log(chalk.bold.red(`  Mint configuration changed ${context}:`));
  for (const change of changes) console.log(chalk.red(`    - ${change}`));
  throw new Error("SAFE mode refuses to auto-accept this mint-plan change.");
}

async function readPublicDropLight(
  provider: JsonRpcProvider,
  nftContract: string
): Promise<PublicDrop | null> {
  const seadrop = new Contract(SEADROP_ADDRESS, WATCH_PUBLIC_ABI, provider);
  try {
    const raw = await seadrop.getPublicDrop(nftContract);
    const drop: PublicDrop = {
      mintPrice: BigInt(raw.mintPrice),
      startTime: Number(raw.startTime),
      endTime: Number(raw.endTime),
      maxTotalMintableByWallet: Number(raw.maxTotalMintableByWallet),
      feeBps: Number(raw.feeBps),
      restrictFeeRecipients: Boolean(raw.restrictFeeRecipients),
    };
    if (drop.startTime === 0 && drop.endTime === 0 && drop.maxTotalMintableByWallet === 0) return null;
    return drop;
  } catch {
    // A transient watcher read must not disarm the mint. The normal heavy/critical
    // preflights remain fail-closed at their deadlines.
    return null;
  }
}

function samePublicDrop(a: PublicDrop, b: PublicDrop): boolean {
  return a.mintPrice === b.mintPrice
    && a.startTime === b.startTime
    && a.endTime === b.endTime
    && a.maxTotalMintableByWallet === b.maxTotalMintableByWallet
    && a.feeBps === b.feeBps
    && a.restrictFeeRecipients === b.restrictFeeRecipients;
}

async function readPendingNoncesFast(
  provider: JsonRpcProvider,
  addresses: string[]
): Promise<number[]> {
  const concurrency = readBoundedInt("NONCE_RPC_CONCURRENCY", 5, 1, 12);
  const retries = readBoundedInt("NONCE_RPC_RETRIES", 5, 1, 10);
  const backoffMs = readBoundedInt("NONCE_RPC_BACKOFF_MS", 150, 50, 3000);
  const out = new Array<number>(addresses.length);

  for (let offset = 0; offset < addresses.length; offset += concurrency) {
    const indexes = Array.from(
      { length: Math.min(concurrency, addresses.length - offset) },
      (_, i) => offset + i
    );
    await Promise.all(indexes.map(async (index) => {
      const address = addresses[index];
      let lastError: any;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const raw = await provider.send("eth_getTransactionCount", [address, "pending"]);
          const nonce = Number(BigInt(String(raw)));
          if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error(`Invalid nonce ${String(raw)}`);
          out[index] = nonce;
          return;
        } catch (err: any) {
          lastError = err;
          if (attempt >= retries) break;
          await sleep(Math.min(backoffMs * Math.pow(2, attempt - 1), 3000));
        }
      }
      const message = lastError?.shortMessage || lastError?.message || String(lastError);
      throw new Error(`Could not read pending nonce for ${address}: ${message}`);
    }));

    if (offset + concurrency < addresses.length) await sleep(40);
  }

  return out;
}

async function signPreparedTransactions(
  wallets: Wallet[],
  plan: LocalMintPlan,
  nonces: number[],
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
  gasLimit: number,
  chainId: bigint
): Promise<PreparedWalletTx[]> {
  if (nonces.length !== wallets.length) throw new Error("Nonce set is incomplete.");
  const signStart = performance.now();
  const prepared: PreparedWalletTx[] = [];

  for (let i = 0; i < wallets.length; i++) {
    const rawTx = await wallets[i].signTransaction({
      to: plan.to,
      data: plan.data,
      value: plan.value,
      nonce: nonces[i],
      maxFeePerGas,
      maxPriorityFeePerGas,
      gasLimit,
      type: 2,
      chainId,
    });
    prepared.push({ idx: i, address: wallets[i].address, blast: prepareBlast(rawTx) });
  }

  console.log(chalk.green(`  ✓ ${prepared.length} tx(s) signed in ${(performance.now() - signStart).toFixed(1)}ms.`));
  return prepared;
}

async function broadcastPrepared(
  prepared: PreparedWalletTx[],
  endpoints: RpcEndpoint[],
  rpcUrls: string[],
  chainId: bigint,
  stageStartMs: number
): Promise<void> {
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

function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function formatWatchTime(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

async function waitUntil(epochMs: number): Promise<void> {
  const delay = epochMs - Date.now();
  if (delay > 0) await sleep(delay);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
