import fs from "fs";
import { execFileSync } from "child_process";
import { Wallet } from "ethers";

const DEFAULT_VAULT_FILE = "wallets.secure";
const DEFAULT_PUBLIC_FILE = "wallets.txt";
const VAULT_SCHEME = "windows-dpapi-current-user";

interface VaultEnvelope {
  version: 1;
  scheme: typeof VAULT_SCHEME;
  createdAt: string;
  addresses: string[];
  ciphertext: string;
}

interface VaultPayload {
  version: 1;
  keys: string[];
}

export interface LoadedWalletVault {
  keys: string[];
  addresses: string[];
  file: string;
}

export function walletVaultFile(): string {
  return (process.env.WALLET_VAULT_FILE || DEFAULT_VAULT_FILE).trim() || DEFAULT_VAULT_FILE;
}

export function publicWalletListFile(): string {
  return (process.env.PUBLIC_WALLETS_FILE || DEFAULT_PUBLIC_FILE).trim() || DEFAULT_PUBLIC_FILE;
}

export function walletVaultExists(): boolean {
  return fs.existsSync(walletVaultFile());
}

export function saveWalletVault(rawKeys: string[]): LoadedWalletVault {
  assertWindows();
  const keys = normalizeAndValidateKeys(rawKeys);
  if (!keys.length) throw new Error("Cannot create an empty wallet vault.");

  const addresses = keys.map((key) => new Wallet(key).address);
  const payload: VaultPayload = { version: 1, keys };
  const ciphertext = dpapiProtect(JSON.stringify(payload));
  const envelope: VaultEnvelope = {
    version: 1,
    scheme: VAULT_SCHEME,
    createdAt: new Date().toISOString(),
    addresses,
    ciphertext,
  };

  const file = walletVaultFile();
  fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  savePublicWalletList(addresses);
  return { keys, addresses, file };
}

export function loadWalletVault(): LoadedWalletVault {
  assertWindows();
  const file = walletVaultFile();
  if (!fs.existsSync(file)) throw new Error(`Encrypted wallet vault not found: ${file}`);

  let envelope: VaultEnvelope;
  try {
    envelope = JSON.parse(fs.readFileSync(file, "utf8")) as VaultEnvelope;
  } catch {
    throw new Error(`Could not parse encrypted wallet vault: ${file}`);
  }

  if (envelope.version !== 1 || envelope.scheme !== VAULT_SCHEME || !Array.isArray(envelope.addresses) || typeof envelope.ciphertext !== "string") {
    throw new Error(`Unsupported or damaged wallet vault: ${file}`);
  }

  let payload: VaultPayload;
  try {
    payload = JSON.parse(dpapiUnprotect(envelope.ciphertext)) as VaultPayload;
  } catch {
    throw new Error("Could not decrypt wallet vault. It is tied to the Windows user account that created it.");
  }

  if (payload.version !== 1 || !Array.isArray(payload.keys)) {
    throw new Error("Decrypted wallet vault payload is invalid.");
  }

  const keys = normalizeAndValidateKeys(payload.keys);
  const addresses = keys.map((key) => new Wallet(key).address);
  if (addresses.length !== envelope.addresses.length || addresses.some((address, i) => address.toLowerCase() !== String(envelope.addresses[i] || "").toLowerCase())) {
    throw new Error("Wallet vault integrity check failed: encrypted keys do not match stored public addresses.");
  }

  return { keys, addresses, file };
}

export function readWalletVaultAddresses(): { addresses: string[]; file: string; createdAt: string | null } {
  const file = walletVaultFile();
  if (!fs.existsSync(file)) return { addresses: [], file, createdAt: null };
  try {
    const envelope = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VaultEnvelope>;
    const addresses = Array.isArray(envelope.addresses) ? envelope.addresses.map(String) : [];
    return { addresses, file, createdAt: typeof envelope.createdAt === "string" ? envelope.createdAt : null };
  } catch {
    throw new Error(`Could not parse encrypted wallet vault: ${file}`);
  }
}

export function deleteWalletVault(): boolean {
  const file = walletVaultFile();
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

export function savePublicWalletList(addresses: string[]): void {
  const file = publicWalletListFile();
  fs.writeFileSync(file, `${addresses.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function normalizeAndValidateKeys(rawKeys: string[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawKeys) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const normalized = value.startsWith("0x") ? value : `0x${value}`;
    let wallet: Wallet;
    try {
      wallet = new Wallet(normalized);
    } catch {
      throw new Error("Wallet vault contains an invalid private key.");
    }
    const addressKey = wallet.address.toLowerCase();
    if (seen.has(addressKey)) throw new Error(`Duplicate wallet in vault: ${wallet.address}`);
    seen.add(addressKey);
    keys.push(normalized);
  }
  return keys;
}

function assertWindows(): void {
  if (process.platform !== "win32") {
    throw new Error("Encrypted wallet vault currently requires Windows DPAPI.");
  }
}

function dpapiProtect(plaintext: string): string {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$text=[Console]::In.ReadToEnd()",
    "$bytes=[System.Text.Encoding]::UTF8.GetBytes($text)",
    "$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser",
    "$protected=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,$scope)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))",
  ].join("; ");

  return execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { input: plaintext, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }
  ).trim();
}

function dpapiUnprotect(ciphertext: string): string {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$b64=[Console]::In.ReadToEnd().Trim()",
    "$protected=[Convert]::FromBase64String($b64)",
    "$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser",
    "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($protected,$null,$scope)",
    "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))",
  ].join("; ");

  return execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { input: ciphertext, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 }
  );
}
