import chalk from "chalk";
import { Wallet } from "ethers";
import { askHidden, askYesNo, closePrompts } from "./prompt";
import {
  deleteWalletVault,
  readWalletVaultAddresses,
  saveWalletVault,
  walletVaultExists,
  walletVaultFile,
} from "./wallet-vault";

async function main(): Promise<void> {
  const action = (process.argv[2] || "setup").toLowerCase();
  try {
    if (action === "setup") await setupVault();
    else if (action === "status") showStatus();
    else if (action === "clear") await clearVault();
    else throw new Error("Usage: vault-cli setup|status|clear");
    closePrompts();
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exitCode = 1;
  }
}

async function setupVault(): Promise<void> {
  if (process.platform !== "win32") throw new Error("Encrypted vault setup currently supports Windows only.");
  if (!process.stdin.isTTY) throw new Error("Vault setup refuses private keys from a pipe/redirect.");

  console.log(chalk.bold.cyan("\nNFT SAFE — ENCRYPTED WALLET VAULT"));
  console.log(chalk.gray("Windows DPAPI / CurrentUser. Private keys are entered once, encrypted, and never written as plaintext."));
  console.log(chalk.gray("The encrypted vault can only be decrypted by the Windows user account that created it."));

  if (walletVaultExists()) {
    const existing = readWalletVaultAddresses();
    console.log(chalk.yellow(`\n  Existing vault: ${existing.file} (${existing.addresses.length} wallet(s))`));
    if (!(await askYesNo("Replace the existing encrypted vault?", false))) {
      console.log(chalk.yellow("\nAborted — existing vault unchanged.\n"));
      return;
    }
  }

  console.log(chalk.bold.white("\nEnter private keys"));
  console.log(chalk.gray("  One key per line. Input is hidden. Blank line when finished."));
  const keys: string[] = [];
  const seen = new Set<string>();

  for (;;) {
    const raw = await askHidden(chalk.gray(`  › key ${keys.length + 1}: `));
    if (!raw) {
      if (!keys.length) {
        console.log(chalk.red("  ✗ Need at least one key."));
        continue;
      }
      break;
    }

    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    try {
      const wallet = new Wallet(normalized);
      const k = wallet.address.toLowerCase();
      if (seen.has(k)) {
        console.log(chalk.yellow("  ⚠ Duplicate wallet skipped."));
        continue;
      }
      seen.add(k);
      keys.push(normalized);
      console.log(chalk.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
    } catch {
      console.log(chalk.red("  ✗ Invalid private key."));
    }
  }

  console.log(chalk.bold.white(`\nReady to encrypt ${keys.length} wallet(s).`));
  if (!(await askYesNo("Save encrypted wallet vault?", false))) {
    keys.fill("");
    console.log(chalk.yellow("\nAborted — nothing saved.\n"));
    return;
  }

  const saved = saveWalletVault(keys);
  keys.fill("");
  saved.keys.fill("");

  console.log(chalk.bold.green(`\n✓ Encrypted vault saved: ${saved.file}`));
  console.log(chalk.green(`✓ ${saved.addresses.length} public address(es) also saved to wallets.txt for dry-run.`));
  saved.addresses.forEach((address, i) => console.log(chalk.gray(`  [W${i}] ${address}`)));
  console.log(chalk.gray("\nFrom now on: npm start → auto-loads this vault. Use npm start -- --no-vault for manual keys."));
  console.log(chalk.gray("DPAPI protects the file at rest, but malware/processes running as the same Windows user may still access decrypted keys."));
}

function showStatus(): void {
  const status = readWalletVaultAddresses();
  if (!status.addresses.length) {
    console.log(chalk.yellow(`\nNo encrypted wallet vault found at ${walletVaultFile()}.\n`));
    return;
  }
  console.log(chalk.bold.cyan("\nEncrypted wallet vault"));
  console.log(`  File:     ${status.file}`);
  console.log(`  Wallets:  ${status.addresses.length}`);
  if (status.createdAt) console.log(`  Created:  ${status.createdAt}`);
  status.addresses.forEach((address, i) => console.log(chalk.gray(`  [W${i}] ${address}`)));
  console.log();
}

async function clearVault(): Promise<void> {
  const status = readWalletVaultAddresses();
  if (!status.addresses.length) {
    console.log(chalk.yellow(`\nNo encrypted wallet vault found at ${status.file}.\n`));
    return;
  }
  console.log(chalk.yellow(`\nVault ${status.file} contains ${status.addresses.length} wallet(s).`));
  if (!(await askYesNo("Delete the encrypted vault?", false))) {
    console.log(chalk.yellow("\nAborted — vault unchanged.\n"));
    return;
  }
  deleteWalletVault();
  console.log(chalk.green("\n✓ Encrypted vault deleted. wallets.txt was kept for dry-run.\n"));
}

void main();
