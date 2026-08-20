import fs from "fs";
import chalk from "chalk";
import { JsonRpcProvider, Wallet, formatEther, getAddress, isAddress } from "ethers";
import { CHAINS, resolveChain } from "./chains";
import { planRpcs, privateRpcsFromEnv, resolveRpcsForChain, toRpcUrl } from "./rpc-resolver";
import { buildLocalMintPlan } from "./seadrop-public";
import { localPublicSnipe } from "./local-mint";
import { askChoice, askHidden, askNumber, askText, askYesNo, closePrompts } from "./prompt";
import { assertAggregateSupply, inspectWallets, validateMintTarget } from "./safety";

const VN_OFFSET = 7 * 60 * 60 * 1000;

export async function runSafeWizard(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  printBanner(dryRun);

  const walletKeys = dryRun ? [] : await promptKeys();
  const addresses = dryRun ? await promptAddresses() : walletKeys.map((k) => new Wallet(k).address);

  const chainKey = await askChoice<string>(
    "Which chain?",
    CHAINS.map((c) => ({ label: c.name, value: c.key, hint: `chain id ${c.chainId}` })),
    Math.max(0, CHAINS.findIndex((c) => c.key === (process.env.CHAIN || "base").toLowerCase()))
  );
  const chain = resolveChain(chainKey)!;

  const quantity = Math.floor(await askNumber("NFTs per wallet", 1, { min: 1, max: 100 }));
  console.log(chalk.gray(`  → ${quantity} × ${addresses.length} wallet(s) = ${quantity * addresses.length} total`));

  const nftContract = await promptContract();
  const manualRpcs = await promptRpc(chainKey, chain.name);
  const resolved = resolveRpcsForChain(chainKey, manualRpcs);
  const rpcPlan = await planRpcs(resolved.urls, chain.chainId);
  if (rpcPlan.urls.length === 0 || !rpcPlan.verified) {
    throw new Error(`Could not verify an RPC on chain id ${chain.chainId}. SAFE mode fails closed.`);
  }
  const rpcUrls = rpcPlan.urls;
  const provider = new JsonRpcProvider(rpcUrls[0]);

  console.log(chalk.bold.white("\nDrop preflight"));
  const mintPlan = await buildLocalMintPlan(rpcUrls[0], nftContract, quantity);
  if (!mintPlan) throw new Error("No readable public SeaDrop config for this contract.");

  const payout = await validateMintTarget(provider, nftContract, mintPlan);
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec > mintPlan.drop.endTime) throw new Error("This public stage has already ended.");
  if (quantity > mintPlan.drop.maxTotalMintableByWallet) {
    throw new Error(`Requested ${quantity}, but public cap is ${mintPlan.drop.maxTotalMintableByWallet} per wallet.`);
  }

  console.log(chalk.gray(`  NFT:             ${nftContract}`));
  console.log(chalk.gray(`  SeaDrop:         ${mintPlan.to}`));
  console.log(chalk.gray(`  Price:           ${formatEther(mintPlan.drop.mintPrice)} each`));
  console.log(chalk.gray(`  Fee recipient:   ${mintPlan.feeRecipient}`));
  console.log(chalk.gray(`  Creator payout:  ${payout}`));
  console.log(chalk.gray(`  Max per wallet:  ${mintPlan.drop.maxTotalMintableByWallet}`));
  console.log(chalk.gray(`  Window:          ${formatVN(new Date(mintPlan.drop.startTime * 1000))} → ${formatVN(new Date(mintPlan.drop.endTime * 1000))}`));

  const baseFee = await currentBaseFeeGwei(provider);
  if (baseFee === null) throw new Error("Could not read current network fee data.");
  console.log(chalk.bold.white("\nGas"));
  console.log(chalk.gray(`  Current network fee reference: ${baseFee.toFixed(6)} gwei`));

  const chainDefaultMax = chainKey === "ethereum" ? 80 : chainKey === "robinhood" ? 0.1 : 2;
  const chainDefaultTip = chainKey === "ethereum" ? 5 : 0.05;
  const envMax = Number(process.env.MAX_FEE_PER_GAS || chainDefaultMax);
  const envTip = Number(process.env.MAX_PRIORITY_FEE || chainDefaultTip);
  const suggestedMax = Math.max(envMax, Math.ceil((baseFee * 2 + envTip) * 1000) / 1000);
  let maxFeeGwei = await askNumber("Max fee per gas (gwei)", suggestedMax, { min: baseFee });
  let tipGwei = await askNumber("Priority fee / tip (gwei)", Math.min(envTip, maxFeeGwei), { min: 0, max: maxFeeGwei });
  let maxFeePerGas = gweiToWei(maxFeeGwei);
  let maxPriorityFee = gweiToWei(tipGwei);
  const gasLimit = parseInt(process.env.GAS_LIMIT || "250000", 10) || 250_000;

  const targetStart = await promptTiming(mintPlan.drop.startTime, mintPlan.drop.endTime);

  console.log(chalk.bold.white("\nWallet safety"));
  const [states, balances] = await Promise.all([
    inspectWallets(provider, nftContract, addresses, quantity, mintPlan.drop.maxTotalMintableByWallet),
    Promise.all(addresses.map((a) => provider.getBalance(a).catch(() => null))),
  ]);
  if (balances.some((b) => b === null)) throw new Error("Could not read every wallet balance.");

  const blocked = states.filter((s) => !s.eligible);
  if (blocked.length) {
    for (const s of blocked) console.log(chalk.red(`  ✗ ${s.address}: ${s.reason}`));
    throw new Error("At least one wallet lacks remaining mint quota/supply.");
  }
  assertAggregateSupply(states, quantity, addresses.length);

  for (let i = 0; i < addresses.length; i++) {
    const bal = balances[i] as bigint;
    console.log(chalk.gray(`  [W${i}] ${addresses[i]}  balance ${formatEther(bal)}  minted ${states[i].minted}/${mintPlan.drop.maxTotalMintableByWallet}`));
  }

  let required = BigInt(gasLimit) * maxFeePerGas + mintPlan.value;
  for (;;) {
    const underfunded = addresses
      .map((address, i) => ({ address, i, balance: balances[i] as bigint }))
      .filter((x) => x.balance < required);

    if (underfunded.length === 0) break;

    console.log(chalk.bold.red(`\n  ${underfunded.length} wallet(s) are below the current worst-case reserve of ${formatEther(required)} ${chain.nativeSymbol}.`));
    for (const x of underfunded) {
      console.log(chalk.red(`  ✗ [W${x.i}] ${x.address}: ${formatEther(x.balance)} ${chain.nativeSymbol}`));
    }

    if (!(await askYesNo("Adjust gas ceiling and recheck the same wallet list?", true))) {
      throw new Error("At least one wallet is underfunded at the selected max-fee ceiling.");
    }

    const retrySuggested = Math.max(baseFee, Math.ceil((baseFee * 2 + Math.min(tipGwei, maxFeeGwei)) * 1000) / 1000);
    maxFeeGwei = await askNumber("Max fee per gas (gwei)", Math.min(maxFeeGwei, Math.max(retrySuggested, baseFee)), { min: baseFee });
    tipGwei = await askNumber("Priority fee / tip (gwei)", Math.min(tipGwei, maxFeeGwei), { min: 0, max: maxFeeGwei });
    maxFeePerGas = gweiToWei(maxFeeGwei);
    maxPriorityFee = gweiToWei(tipGwei);
    required = BigInt(gasLimit) * maxFeePerGas + mintPlan.value;
    console.log(chalk.gray(`  → Rechecking without re-entering wallets. New worst-case reserve: ${formatEther(required)} ${chain.nativeSymbol} per wallet.`));
  }

  console.log(chalk.bold.white("\n──────── SAFE READY ────────"));
  console.log(`  Chain       ${chain.name} (${chain.chainId})`);
  console.log(`  Contract    ${nftContract}`);
  console.log(`  Wallets     ${addresses.length}`);
  console.log(`  Quantity    ${quantity} each → ${quantity * addresses.length} total`);
  console.log(`  Mint value  ${formatEther(mintPlan.value)} per wallet`);
  console.log(`  Gas ceiling ${maxFeeGwei} / ${tipGwei} gwei · limit ${gasLimit}`);
  console.log(`  Worst case  ${formatEther(required)} ${chain.nativeSymbol} reserved per wallet`);
  console.log(chalk.bold.white("────────────────────────────"));

  if (dryRun) {
    console.log(chalk.bold.green("\n===== SAFE DRY-RUN PASS — NO PRIVATE KEY, NO SIGNING, NO BROADCAST =====\n"));
    closePrompts();
    return;
  }

  if (!(await askYesNo(chalk.bold("Fire?"), false))) {
    console.log(chalk.yellow("\nAborted — nothing sent.\n"));
    closePrompts();
    return;
  }

  const confirmation = `SEND-${nftContract.slice(-6).toUpperCase()}`;
  const typed = await askText(`Type exactly ${confirmation} to lock the NFT contract`);
  if (typed.trim().toUpperCase() !== confirmation) {
    console.log(chalk.yellow("\nContract confirmation mismatch — aborted.\n"));
    closePrompts();
    return;
  }

  closePrompts();
  await localPublicSnipe({
    nftContract,
    quantity,
    walletKeys,
    rpcUrls,
    maxFeePerGas,
    maxPriorityFee,
    gasLimit,
    targetStart,
    plan: mintPlan,
  });
}

async function promptKeys(): Promise<string[]> {
  if (!process.stdin.isTTY) throw new Error("SAFE mode refuses private keys from a pipe/redirect.");
  console.log(chalk.bold.white("Private keys"));
  console.log(chalk.gray("  Dedicated mint wallets only. One key per line; blank line when done."));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (;;) {
    const raw = await askHidden(chalk.gray(`  › key ${keys.length + 1}: `));
    if (!raw) {
      if (!keys.length) { console.log(chalk.red("  ✗ Need at least one key.")); continue; }
      break;
    }
    const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
    try {
      const wallet = new Wallet(normalized);
      const k = wallet.address.toLowerCase();
      if (seen.has(k)) { console.log(chalk.yellow("  ⚠ Duplicate wallet skipped.")); continue; }
      seen.add(k); keys.push(normalized); console.log(chalk.green(`  ✓ [W${keys.length - 1}] ${wallet.address}`));
    } catch { console.log(chalk.red("  ✗ Invalid private key.")); }
  }
  return keys;
}

async function promptAddresses(): Promise<string[]> {
  console.log(chalk.bold.white("Public wallet addresses (dry-run)"));
  console.log(chalk.gray("  PUBLIC 0x addresses only — never paste a private key here."));

  const walletFile = publicWalletFile();
  if (fs.existsSync(walletFile)) {
    const saved = readPublicWalletFile(walletFile);
    console.log(chalk.green(`  ✓ Loaded ${saved.length} wallet(s) from ${walletFile}.`));
    saved.forEach((addr, i) => console.log(chalk.gray(`  [W${i}] ${addr}`)));
    console.log(chalk.gray(`  Edit/delete ${walletFile} if you want to change the dry-run wallet set.`));
    return saved;
  }

  console.log(chalk.gray(`  No ${walletFile} yet. Enter addresses once; SAFE will save them for future dry-runs.`));
  const out: string[] = [];
  const seen = new Set<string>();
  for (;;) {
    const raw = await askText(`wallet address ${out.length + 1}`);
    if (!raw) {
      if (!out.length) { console.log(chalk.red("  ✗ Need at least one address.")); continue; }
      break;
    }
    const addr = normalizeAddress(raw);
    if (!addr) { console.log(chalk.red("  ✗ Invalid EVM address/checksum.")); continue; }
    const k = addr.toLowerCase();
    if (seen.has(k)) { console.log(chalk.yellow("  ⚠ Duplicate skipped.")); continue; }
    seen.add(k); out.push(addr); console.log(chalk.green(`  ✓ [W${out.length - 1}] ${addr}`));
  }

  fs.writeFileSync(walletFile, `${out.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(chalk.green(`  ✓ Saved ${out.length} public wallet(s) to ${walletFile}.`));
  return out;
}

function publicWalletFile(): string {
  return (process.env.PUBLIC_WALLETS_FILE || "wallets.txt").trim() || "wallets.txt";
}

function readPublicWalletFile(file: string): string[] {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const addr = normalizeAddress(raw);
    if (!addr) throw new Error(`Invalid EVM address in ${file} at line ${i + 1}.`);
    const k = addr.toLowerCase();
    if (seen.has(k)) {
      console.log(chalk.yellow(`  ⚠ Duplicate in ${file} line ${i + 1} skipped: ${addr}`));
      continue;
    }
    seen.add(k);
    out.push(addr);
  }

  if (!out.length) throw new Error(`${file} exists but contains no valid wallet addresses.`);
  return out;
}

async function promptContract(): Promise<string> {
  console.log(chalk.bold.white("\nNFT contract"));
  console.log(chalk.gray("  SAFE v1 accepts the direct 0x NFT contract address. This avoids slug/API ambiguity."));
  for (;;) {
    const raw = await askText("NFT contract 0x...");
    const addr = normalizeAddress(raw);
    if (addr) return addr;
    console.log(chalk.red("  ✗ Invalid EVM contract address/checksum."));
  }
}

async function promptRpc(chainKey: string, chainName: string): Promise<string[]> {
  console.log(chalk.bold.white("\nRPC"));
  const fromEnv = privateRpcsFromEnv(chainKey);
  console.log(chalk.gray(fromEnv.length ? "  Blank = use RPC from .env." : "  Paste a private RPC URL/API key; blank falls back to public nodes."));
  for (;;) {
    const raw = await askText(`RPC for ${chainName}`);
    if (!raw) return fromEnv;
    const urls: string[] = [];
    let bad = false;
    for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const url = toRpcUrl(part, chainKey);
      if (!url) { bad = true; console.log(chalk.red(`  ✗ Invalid RPC/API key: ${part}`)); break; }
      urls.push(url);
    }
    if (!bad && urls.length) return urls;
  }
}

async function promptTiming(startTime: number, endTime: number): Promise<Date | null> {
  const start = new Date(startTime * 1000);
  const end = new Date(endTime * 1000);
  const future = start.getTime() > Date.now();
  const choices: { label: string; value: "wait" | "now" | "custom"; hint?: string }[] = [];
  if (future) choices.push({ label: "Wait for on-chain stage", value: "wait", hint: formatVN(start) });
  else choices.push({ label: "Fire now", value: "now", hint: "stage is currently live" });
  choices.push({ label: "Custom Vietnam time", value: "custom", hint: "HH:MM today, UTC+7" });
  const pick = await askChoice("When should it broadcast?", choices, 0);
  if (pick === "wait") return start;
  if (pick === "now") return null;
  for (;;) {
    const raw = await askText("Time HH:MM (Vietnam UTC+7)");
    try {
      const d = vietnamToday(raw);
      if (d < start) { console.log(chalk.red(`  ✗ Before start ${formatVN(start)}.`)); continue; }
      if (d > end) { console.log(chalk.red(`  ✗ After end ${formatVN(end)}.`)); continue; }
      return d;
    } catch (err: any) { console.log(chalk.red(`  ✗ ${err.message}`)); }
  }
}

function normalizeAddress(raw: string): string | null {
  const value = (raw || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
  const body = value.slice(2);
  const mixed = /[a-f]/.test(body) && /[A-F]/.test(body);
  if (mixed && !isAddress(value)) return null;
  return getAddress(value.toLowerCase());
}

async function currentBaseFeeGwei(provider: JsonRpcProvider): Promise<number | null> {
  try {
    const fee = await provider.getFeeData();
    const wei = fee.gasPrice ?? fee.maxFeePerGas;
    return wei == null ? null : Number(wei) / 1e9;
  } catch { return null; }
}

function gweiToWei(gwei: number): bigint { return BigInt(Math.round(gwei * 1e9)); }

function vietnamToday(hhmm: string): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error("Use HH:MM.");
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error("Invalid HH:MM.");
  const vn = new Date(Date.now() + VN_OFFSET);
  vn.setUTCHours(hh, mm, 0, 0);
  return new Date(vn.getTime() - VN_OFFSET);
}

function formatVN(date: Date): string {
  const d = new Date(date.getTime() + VN_OFFSET);
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")} UTC+7`;
}

function printBanner(dryRun: boolean): void {
  console.log(chalk.bold.cyan("\nNFT PUBLIC MINT SAFE v1"));
  console.log(chalk.gray("Public SeaDrop mintPublic() only. Direct contract input. Fail-closed preflight."));
  if (dryRun) console.log(chalk.bold.yellow("DRY-RUN: public addresses only; no private key, signing or broadcast."));
  console.log();
}
