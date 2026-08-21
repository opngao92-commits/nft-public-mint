#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runSafeWizard } from "./safe-wizard";
import { askChoice, askNumber, askText, closePrompts } from "./prompt";
import { readWalletVaultAddresses, walletVaultExists } from "./wallet-vault";

async function main(): Promise<void> {
  try {
    await chooseVaultSubset();
    await runSafeWizard();
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

async function chooseVaultSubset(): Promise<void> {
  if (process.argv.includes("--no-vault") || !walletVaultExists()) return;

  const status = readWalletVaultAddresses();
  const total = status.addresses.length;
  if (!total) return;

  console.log(chalk.bold.cyan("\nMint wallet selection"));
  console.log(chalk.gray(`  Encrypted vault: ${status.file}`));
  console.log(chalk.gray(`  Saved wallets:   ${total}`));
  console.log(chalk.gray("  Selection numbers below are 1-based: wallet 1 = SAFE W0."));

  if (total === 1) {
    process.env.SAFE_WALLET_INDEXES = "0";
    console.log(chalk.green("  ✓ Using the only wallet in the vault."));
    return;
  }

  const mode = await askChoice<"all" | "first" | "custom">(
    "Which saved wallets should this mint use?",
    [
      { label: `All ${total} wallets`, value: "all", hint: `1-${total}` },
      { label: "First N wallets", value: "first", hint: "example: first 10" },
      { label: "Custom wallet numbers / ranges", value: "custom", hint: "example: 1-5,21-25,40" },
    ],
    1
  );

  let indexes: number[];
  if (mode === "all") {
    indexes = Array.from({ length: total }, (_, i) => i);
  } else if (mode === "first") {
    const count = Math.floor(await askNumber("How many wallets?", Math.min(10, total), { min: 1, max: total }));
    indexes = Array.from({ length: count }, (_, i) => i);
  } else {
    indexes = await promptCustomSelection(total);
  }

  process.env.SAFE_WALLET_INDEXES = indexes.join(",");

  const human = indexes.map((i) => i + 1);
  const preview = human.length <= 20
    ? human.join(",")
    : `${human.slice(0, 10).join(",")} ... ${human.slice(-5).join(",")}`;
  console.log(chalk.bold.green(`\n  ✓ Selected ${indexes.length}/${total} wallet(s) for this mint.`));
  console.log(chalk.gray(`  Vault wallet numbers: ${preview}`));
  console.log(chalk.gray("  The encrypted vault itself is unchanged.\n"));
}

async function promptCustomSelection(total: number): Promise<number[]> {
  for (;;) {
    const raw = await askText(`Wallet numbers/ranges (1-${total})`);
    try {
      return parseWalletSelection(raw, total);
    } catch (err: any) {
      console.log(chalk.red(`  ✗ ${err.message}`));
    }
  }
}

function parseWalletSelection(raw: string, total: number): number[] {
  const input = raw.trim();
  if (!input) throw new Error("Enter at least one wallet number or range.");

  const out: number[] = [];
  const seen = new Set<number>();
  const parts = input.split(",").map((part) => part.trim()).filter(Boolean);

  for (const part of parts) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      validateWalletNumber(start, total);
      validateWalletNumber(end, total);
      if (start > end) throw new Error(`Invalid descending range: ${part}.`);
      for (let n = start; n <= end; n++) addWalletNumber(n, seen, out);
      continue;
    }

    if (!/^\d+$/.test(part)) throw new Error(`Invalid selection token: ${part}.`);
    const n = Number(part);
    validateWalletNumber(n, total);
    addWalletNumber(n, seen, out);
  }

  if (!out.length) throw new Error("No wallets selected.");
  return out;
}

function validateWalletNumber(n: number, total: number): void {
  if (!Number.isSafeInteger(n) || n < 1 || n > total) {
    throw new Error(`Wallet number ${n} is outside 1-${total}.`);
  }
}

function addWalletNumber(n: number, seen: Set<number>, out: number[]): void {
  const index = n - 1;
  if (seen.has(index)) return;
  seen.add(index);
  out.push(index);
}

void main();
