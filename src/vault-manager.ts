import fs from "fs";
import path from "path";

const LEGACY_VAULT_FILE = "wallets.secure";
const LEGACY_PUBLIC_FILE = "wallets.txt";
const DEFAULT_VAULT_DIR = "vaults";

export interface WalletVaultSummary {
  name: string;
  file: string;
  publicFile: string;
  addresses: string[];
  createdAt: string | null;
  legacy: boolean;
}

interface VaultEnvelopeMetadata {
  version?: unknown;
  scheme?: unknown;
  createdAt?: unknown;
  addresses?: unknown;
}

export function walletVaultDirectory(): string {
  const configured = (process.env.WALLET_VAULT_DIR || DEFAULT_VAULT_DIR).trim();
  return configured || DEFAULT_VAULT_DIR;
}

export function listWalletVaults(): WalletVaultSummary[] {
  const candidates: string[] = [];
  const configured = (process.env.WALLET_VAULT_FILE || "").trim();
  if (configured && fs.existsSync(configured)) candidates.push(configured);
  if (fs.existsSync(LEGACY_VAULT_FILE)) candidates.push(LEGACY_VAULT_FILE);

  const dir = walletVaultDirectory();
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".secure")) continue;
      candidates.push(path.join(dir, entry.name));
    }
  }

  const seen = new Set<string>();
  const summaries: WalletVaultSummary[] = [];
  for (const candidate of candidates) {
    const absolute = path.resolve(candidate).toLowerCase();
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    summaries.push(readWalletVaultSummary(candidate));
  }

  summaries.sort((a, b) => {
    if (a.legacy !== b.legacy) return a.legacy ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return summaries;
}

export function readWalletVaultSummary(file: string): WalletVaultSummary {
  let parsed: VaultEnvelopeMetadata;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as VaultEnvelopeMetadata;
  } catch {
    throw new Error(`Could not parse encrypted wallet vault: ${file}`);
  }

  if (!Array.isArray(parsed.addresses)) {
    throw new Error(`Encrypted wallet vault has invalid metadata: ${file}`);
  }

  const addresses = parsed.addresses.map(String);
  const legacy = path.resolve(file).toLowerCase() === path.resolve(LEGACY_VAULT_FILE).toLowerCase();
  const name = legacy ? "default" : path.basename(file, path.extname(file));
  return {
    name,
    file,
    publicFile: publicFileForVault(file, legacy),
    addresses,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
    legacy,
  };
}

export function activateWalletVault(vault: Pick<WalletVaultSummary, "file" | "publicFile">): void {
  process.env.WALLET_VAULT_FILE = vault.file;
  process.env.PUBLIC_WALLETS_FILE = vault.publicFile;
  delete process.env.SAFE_WALLET_INDEXES;
}

export function createNamedVaultTarget(rawName: string): WalletVaultSummary {
  const name = normalizeVaultName(rawName);
  const dir = walletVaultDirectory();
  const file = path.join(dir, `${name}.secure`);
  return {
    name,
    file,
    publicFile: path.join(dir, `${name}.txt`),
    addresses: [],
    createdAt: null,
    legacy: false,
  };
}

export function ensureVaultDirectory(): void {
  fs.mkdirSync(walletVaultDirectory(), { recursive: true });
}

export function deleteVaultFile(vault: WalletVaultSummary): void {
  if (fs.existsSync(vault.file)) fs.unlinkSync(vault.file);
}

export function suggestNextVaultName(existing: WalletVaultSummary[]): string {
  const used = new Set(existing.map((v) => v.name.toLowerCase()));
  for (let i = 0; i < 26; i++) {
    const candidate = `batch-${String.fromCharCode(97 + i)}`;
    if (!used.has(candidate)) return candidate;
  }
  let n = 1;
  while (used.has(`batch-${n}`)) n++;
  return `batch-${n}`;
}

function publicFileForVault(file: string, legacy: boolean): string {
  if (legacy) return LEGACY_PUBLIC_FILE;
  const parsed = path.parse(file);
  return path.join(parsed.dir, `${parsed.name}.txt`);
}

function normalizeVaultName(rawName: string): string {
  const normalized = String(rawName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  if (!normalized) throw new Error("Vault name must contain at least one letter or number.");
  if (normalized.length > 48) throw new Error("Vault name is too long (max 48 characters).");
  if (normalized === "default" || normalized === "wallets") {
    throw new Error("That vault name is reserved. Choose another name such as batch-a.");
  }
  return normalized;
}
