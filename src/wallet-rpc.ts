import { JsonRpcProvider } from "ethers";

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_RETRIES = 6;
const DEFAULT_BACKOFF_MS = 350;

export async function readWalletBalances(
  provider: JsonRpcProvider,
  addresses: string[]
): Promise<bigint[]> {
  return readWalletValues(
    addresses,
    async (address) => provider.getBalance(address),
    "getBalance"
  );
}

export async function readPendingNonces(
  provider: JsonRpcProvider,
  addresses: string[]
): Promise<number[]> {
  return readWalletValues(
    addresses,
    async (address) => provider.getTransactionCount(address, "pending"),
    "getTransactionCount(pending)"
  );
}

async function readWalletValues<T>(
  addresses: string[],
  reader: (address: string) => Promise<T>,
  label: string
): Promise<T[]> {
  const concurrency = readBoundedInt("WALLET_RPC_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 10);
  const retries = readBoundedInt("WALLET_RPC_RETRIES", DEFAULT_RETRIES, 1, 10);
  const backoffMs = readBoundedInt("WALLET_RPC_BACKOFF_MS", DEFAULT_BACKOFF_MS, 50, 5000);
  const output: T[] = [];

  for (let offset = 0; offset < addresses.length; offset += concurrency) {
    const batch = addresses.slice(offset, offset + concurrency);
    const rows = await Promise.all(batch.map((address) => readWithRetry(
      () => reader(address),
      `${label}(${address})`,
      retries,
      backoffMs
    )));
    output.push(...rows);

    if (offset + concurrency < addresses.length) await sleep(75);
  }

  return output;
}

async function readWithRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts: number,
  baseBackoffMs: number
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      const delayMs = Math.min(baseBackoffMs * Math.pow(2, attempt - 1), 5000);
      await sleep(delayMs);
    }
  }

  const message = lastError?.shortMessage || lastError?.message || String(lastError);
  throw new Error(`Could not read ${label} after ${maxAttempts} SAFE attempt(s): ${message}`);
}

function readBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] || fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
