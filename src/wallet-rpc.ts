import { JsonRpcProvider } from "ethers";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRIES = 6;
const DEFAULT_BACKOFF_MS = 350;

let installed = false;
let active = 0;
const queue: Array<() => void> = [];

export function installWalletRpcGuard(): void {
  if (installed) return;
  installed = true;

  const proto = JsonRpcProvider.prototype as any;
  const originalGetBalance = proto.getBalance;
  const originalGetTransactionCount = proto.getTransactionCount;

  proto.getBalance = function(address: string, blockTag?: any): Promise<bigint> {
    return guardedCall(
      () => originalGetBalance.call(this, address, blockTag),
      `getBalance(${address})`
    );
  };

  proto.getTransactionCount = function(address: string, blockTag?: any): Promise<number> {
    return guardedCall(
      () => originalGetTransactionCount.call(this, address, blockTag),
      `getTransactionCount(${address},${blockTag ?? "latest"})`
    );
  };
}

async function guardedCall<T>(fn: () => Promise<T>, label: string): Promise<T> {
  await acquire();
  try {
    const retries = readBoundedInt("WALLET_RPC_RETRIES", DEFAULT_RETRIES, 1, 10);
    const backoffMs = readBoundedInt("WALLET_RPC_BACKOFF_MS", DEFAULT_BACKOFF_MS, 50, 5000);
    let lastError: any;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastError = err;
        if (attempt >= retries) break;
        const delayMs = Math.min(backoffMs * Math.pow(2, attempt - 1), 5000);
        await sleep(delayMs);
      }
    }

    const message = lastError?.shortMessage || lastError?.message || String(lastError);
    throw new Error(`Could not read ${label} after ${retries} SAFE attempt(s): ${message}`);
  } finally {
    release();
  }
}

function acquire(): Promise<void> {
  const concurrency = readBoundedInt("WALLET_RPC_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 10);
  if (active < concurrency) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = queue.shift();
  if (next) {
    active++;
    setTimeout(next, 75);
  }
}

function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
