import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";
import { Wallet } from "ethers";
import { askChoice, askHidden, askText, askYesNo, closePrompts } from "./prompt";
import { saveWalletVault } from "./wallet-vault";
import {
  activateWalletVault,
  createNamedVaultTarget,
  deleteVaultFile,
  ensureVaultDirectory,
  listWalletVaults,
  readWalletVaultSummary,
  suggestNextVaultName,
  WalletVaultSummary,
} from "./vault-manager";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function main(): Promise<void> {
  const action = (process.argv[2] || "setup").toLowerCase();
  try {
    if (action === "setup") await setupVault();
    else if (action === "status" || action === "list") showStatus();
    else if (action === "clear") await clearVault();
    else throw new Error("Usage: vault-cli setup|status|list|clear");
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

  console.log(chalk.bold.cyan("\nNFT SAFE — MULTI-VAULT WALLET MANAGER"));
  console.log(chalk.gray("Windows DPAPI / CurrentUser. Each named vault is encrypted separately."));
  console.log(chalk.gray("Private keys are entered once, hidden, and are never written as plaintext."));
  console.log(chalk.gray("Vaults can only be decrypted by the Windows user account that created them."));

  const existing = listWalletVaults();
  const target = await chooseSetupTarget(existing);
  activateWalletVault(target);

  if (!target.legacy) ensureVaultDirectory();

  if (fs.existsSync(target.file)) {
    const current = readWalletVaultSummary(target.file);
    console.log(chalk.yellow(`\n  Existing vault: ${current.name} (${current.addresses.length} wallet(s))`));
    if (!(await askYesNo(`Replace encrypted vault ${current.name}?`, false))) {
      console.log(chalk.yellow("\nAborted — existing vault unchanged.\n"));
      return;
    }
  } else {
    console.log(chalk.green(`\n  New vault: ${target.name}`));
    console.log(chalk.gray(`  Encrypted file: ${target.file}`));
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

  console.log(chalk.bold.white(`\nReady to encrypt ${keys.length} wallet(s) into ${target.name}.`));
  if (!(await askYesNo("Save encrypted wallet vault?", false))) {
    keys.fill("");
    console.log(chalk.yellow("\nAborted — nothing saved.\n"));
    return;
  }

  const saved = saveWalletVault(keys);
  keys.fill("");
  saved.keys.fill("");

  console.log(chalk.bold.green(`\n✓ Encrypted vault saved: ${target.name}`));
  console.log(chalk.green(`✓ File: ${saved.file}`));
  console.log(chalk.green(`✓ ${saved.addresses.length} public address(es) saved to ${target.publicFile} for dry-run.`));
  saved.addresses.forEach((address, i) => console.log(chalk.gray(`  [W${i}] ${address}`)));
  console.log(chalk.gray("\nFrom now on: npm start → choose vault → choose All / First N / Custom wallets."));
  console.log(chalk.gray("You can open multiple PowerShell windows and choose a different vault in each process."));
  console.log(chalk.gray("DPAPI protects files at rest, but same-user malware/processes may still access decrypted keys."));
}

async function chooseSetupTarget(existing: WalletVaultSummary[]): Promise<WalletVaultSummary> {
  if (!existing.length) {
    const name = await askText("New vault name", "batch-a");
    return createNamedVaultTarget(name);
  }

  const mode = await askChoice<"new" | "replace">(
    "Vault setup",
    [
      { label: "Create new named vault", value: "new", hint: "recommended for a new wallet batch" },
      { label: "Replace an existing vault", value: "replace", hint: "overwrites one encrypted vault only" },
    ],
    0
  );

  if (mode === "new") {
    const suggestion = suggestNextVaultName(existing);
    const name = await askText("New vault name", suggestion);
    return createNamedVaultTarget(name);
  }

  const selectedFile = await askChoice<string>(
    "Which existing vault should be replaced?",
    existing.map((vault) => ({
      label: `${vault.name} — ${vault.addresses.length} wallet(s)`,
      value: vault.file,
      hint: vault.file,
    })),
    0
  );
  const selected = existing.find((vault) => vault.file === selectedFile);
  if (!selected) throw new Error("Selected vault could not be resolved.");
  return selected;
}

function showStatus(): void {
  const vaults = listWalletVaults();
  if (!vaults.length) {
    console.log(chalk.yellow("\nNo encrypted wallet vaults found. Run npm run vault-setup to create one.\n"));
    return;
  }

  console.log(chalk.bold.cyan("\nEncrypted wallet vaults"));
  let total = 0;
  vaults.forEach((vault, i) => {
    total += vault.addresses.length;
    console.log(`  ${i + 1}) ${vault.name}`);
    console.log(`     Wallets: ${vault.addresses.length}`);
    console.log(`     File:    ${vault.file}`);
    if (vault.createdAt) console.log(`     Created: ${vault.createdAt}`);
  });
  console.log(chalk.gray(`\n  ${vaults.length} vault(s), ${total} wallet slot(s) total.`));
  console.log(chalk.gray("  Note: the same wallet address may intentionally exist in more than one vault.\n"));
}

async function clearVault(): Promise<void> {
  const vaults = listWalletVaults();
  if (!vaults.length) {
    console.log(chalk.yellow("\nNo encrypted wallet vaults found.\n"));
    return;
  }

  const selectedFile = vaults.length === 1
    ? vaults[0].file
    : await askChoice<string>(
        "Which encrypted vault should be deleted?",
        vaults.map((vault) => ({
          label: `${vault.name} — ${vault.addresses.length} wallet(s)`,
          value: vault.file,
          hint: vault.file,
        })),
        0
      );

  const selected = vaults.find((vault) => vault.file === selectedFile);
  if (!selected) throw new Error("Selected vault could not be resolved.");

  console.log(chalk.yellow(`\nVault ${selected.name} contains ${selected.addresses.length} wallet(s).`));
  if (!(await askYesNo(`Delete encrypted vault ${selected.name}?`, false))) {
    console.log(chalk.yellow("\nAborted — vault unchanged.\n"));
    return;
  }

  deleteVaultFile(selected);
  console.log(chalk.green(`\n✓ Encrypted vault ${selected.name} deleted.`));
  console.log(chalk.gray(`Public address list ${selected.publicFile} was kept for recovery/audit.\n`));
}

void main();
