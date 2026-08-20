#!/usr/bin/env node

import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

import { runSafeWizard } from "./safe-wizard";
import { closePrompts } from "./prompt";

const HELP = `
NFT Public Mint SAFE v1

  Public SeaDrop mintPublic() only.
  Uses direct NFT contract input and fail-closed safety checks.

Usage
  npm start                    real mint wizard; auto-load encrypted wallet vault when present
  npm start -- --no-vault     ignore encrypted vault and enter keys manually
  npm run dry-run              public-address-only preflight; no private key/sign/send
  npm run vault-setup          create/replace Windows DPAPI encrypted wallet vault
  npm run vault-status         show saved wallet addresses without decrypting keys
  npm run vault-clear          delete encrypted wallet vault
  npm start -- --help          show this message

Optional defaults can be set in .env (see .env.example).
Never store plaintext private keys or seed phrases in .env, wallets.txt, keys.txt, or shell history.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  try {
    await runSafeWizard();
    closePrompts();
    process.exit(0);
  } catch (err: any) {
    closePrompts();
    console.error(chalk.red(`\n❌ ${err.message}\n`));
    process.exit(1);
  }
}

void main();
