import { Contract, JsonRpcProvider, ZeroAddress } from "ethers";
import { LocalMintPlan, SEADROP_ADDRESS } from "./seadrop-public";

const NFT_STATS_ABI = [
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
];

const SEADROP_SAFETY_ABI = [
  "function getCreatorPayoutAddress(address nftContract) view returns (address)",
];

const DEFAULT_WALLET_RPC_CONCURRENCY = 2;
const DEFAULT_WALLET_RPC_RETRIES = 6;
const DEFAULT_WALLET_RPC_BACKOFF_MS = 350;

export interface WalletMintState {
  address: string;
  minted: bigint;
  currentSupply: bigint;
  maxSupply: bigint;
  walletRemaining: bigint;
  supplyRemaining: bigint;
  eligible: boolean;
  reason?: string;
}

export async function validateMintTarget(
  provider: JsonRpcProvider,
  nftContract: string,
  plan: LocalMintPlan
): Promise<string> {
  const [nftCode, seaDropCode] = await Promise.all([
    provider.getCode(nftContract),
    provider.getCode(SEADROP_ADDRESS),
  ]);

  if (nftCode === "0x") throw new Error(`NFT contract ${nftContract} has no bytecode on the selected chain.`);
  if (seaDropCode === "0x") throw new Error(`SeaDrop ${SEADROP_ADDRESS} has no bytecode on the selected chain.`);
  if (plan.to.toLowerCase() !== SEADROP_ADDRESS.toLowerCase()) {
    throw new Error(`Transaction target is not the expected SeaDrop singleton: ${plan.to}`);
  }
  if (plan.drop.startTime <= 0 || plan.drop.endTime < plan.drop.startTime) {
    throw new Error("Public drop has an invalid start/end window.");
  }
  if (plan.drop.maxTotalMintableByWallet <= 0) {
    throw new Error("Public drop currently allows zero mints per wallet.");
  }
  if (plan.drop.feeBps < 0 || plan.drop.feeBps > 10_000) {
    throw new Error(`Invalid SeaDrop feeBps: ${plan.drop.feeBps}`);
  }

  const seaDrop = new Contract(SEADROP_ADDRESS, SEADROP_SAFETY_ABI, provider);
  const payout = String(await seaDrop.getCreatorPayoutAddress(nftContract));
  if (plan.value > 0n && payout.toLowerCase() === ZeroAddress.toLowerCase()) {
    throw new Error("Paid mint has a zero creator payout address.");
  }
  return payout;
}

export async function inspectWallets(
  provider: JsonRpcProvider,
  nftContract: string,
  addresses: string[],
  quantity: number,
  maxTotalMintableByWallet: number
): Promise<WalletMintState[]> {
  const token = new Contract(nftContract, NFT_STATS_ABI, provider);
  const quantityBn = BigInt(quantity);
  const cap = BigInt(maxTotalMintableByWallet);
  const output: WalletMintState[] = [];

  const concurrency = readBoundedInt("WALLET_RPC_CONCURRENCY", DEFAULT_WALLET_RPC_CONCURRENCY, 1, 10);
  const retries = readBoundedInt("WALLET_RPC_RETRIES", DEFAULT_WALLET_RPC_RETRIES, 1, 10);
  const backoffMs = readBoundedInt("WALLET_RPC_BACKOFF_MS", DEFAULT_WALLET_RPC_BACKOFF_MS, 50, 5000);

  // Public RPCs frequently throttle large wallet sets. Keep only a small number
  // of eth_call requests in flight and retry each wallet with exponential backoff.
  for (let offset = 0; offset < addresses.length; offset += concurrency) {
    const batch = addresses.slice(offset, offset + concurrency);
    const rows = await Promise.all(batch.map(async (address): Promise<WalletMintState> => {
      const raw = await getMintStatsWithRetry(token, address, retries, backoffMs);
      const minted = BigInt(raw.minterNumMinted ?? raw[0]);
      const currentSupply = BigInt(raw.currentTotalSupply ?? raw[1]);
      const maxSupply = BigInt(raw.maxSupply ?? raw[2]);
      if (currentSupply > maxSupply) throw new Error(`NFT contract returned invalid supply stats: ${currentSupply} > ${maxSupply}.`);

      const walletRemaining = cap > minted ? cap - minted : 0n;
      const supplyRemaining = maxSupply - currentSupply;
      const reasons: string[] = [];
      if (quantityBn > walletRemaining) reasons.push(`wallet quota remaining ${walletRemaining} (already minted ${minted}/${cap})`);
      if (quantityBn > supplyRemaining) reasons.push(`collection supply remaining ${supplyRemaining} (${currentSupply}/${maxSupply})`);

      return { address, minted, currentSupply, maxSupply, walletRemaining, supplyRemaining, eligible: reasons.length === 0, reason: reasons.length ? reasons.join("; ") : undefined };
    }));
    output.push(...rows);

    if (offset + concurrency < addresses.length) {
      await sleep(75);
    }
  }
  return output;
}

async function getMintStatsWithRetry(
  token: Contract,
  address: string,
  maxAttempts: number,
  baseBackoffMs: number
): Promise<any> {
  let lastError: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await token.getMintStats(address);
    } catch (err: any) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      const delayMs = Math.min(baseBackoffMs * Math.pow(2, attempt - 1), 5000);
      await sleep(delayMs);
    }
  }

  const message = lastError?.shortMessage || lastError?.message || String(lastError);
  throw new Error(`Could not read getMintStats(${address}) after ${maxAttempts} SAFE attempt(s): ${message}`);
}

function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertAggregateSupply(states: WalletMintState[], quantity: number, walletCount: number): void {
  if (states.length !== walletCount || states.length === 0) throw new Error("Wallet mint-state set is incomplete.");
  const supplyRemaining = states.reduce((min, s) => s.supplyRemaining < min ? s.supplyRemaining : min, states[0].supplyRemaining);
  const requested = BigInt(quantity) * BigInt(walletCount);
  if (requested > supplyRemaining) {
    throw new Error(`Requested ${requested} NFTs across all wallets, but only ${supplyRemaining} supply remained during preflight.`);
  }
}

export function diffMintPlans(oldPlan: LocalMintPlan, freshPlan: LocalMintPlan): string[] {
  const changes: string[] = [];
  const changed = (label: string, a: unknown, b: unknown) => { if (a !== b) changes.push(`${label}: ${String(a)} -> ${String(b)}`); };
  changed("to", oldPlan.to.toLowerCase(), freshPlan.to.toLowerCase());
  changed("calldata", oldPlan.data, freshPlan.data);
  changed("value", oldPlan.value, freshPlan.value);
  changed("feeRecipient", oldPlan.feeRecipient.toLowerCase(), freshPlan.feeRecipient.toLowerCase());
  changed("mintPrice", oldPlan.drop.mintPrice, freshPlan.drop.mintPrice);
  changed("startTime", oldPlan.drop.startTime, freshPlan.drop.startTime);
  changed("endTime", oldPlan.drop.endTime, freshPlan.drop.endTime);
  changed("maxTotalMintableByWallet", oldPlan.drop.maxTotalMintableByWallet, freshPlan.drop.maxTotalMintableByWallet);
  changed("feeBps", oldPlan.drop.feeBps, freshPlan.drop.feeBps);
  changed("restrictFeeRecipients", oldPlan.drop.restrictFeeRecipients, freshPlan.drop.restrictFeeRecipients);
  return changes;
}
