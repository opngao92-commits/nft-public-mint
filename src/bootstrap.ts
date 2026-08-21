#!/usr/bin/env node

import { installWalletRpcGuard } from "./wallet-rpc";

installWalletRpcGuard();

// Load the normal SAFE entrypoint only after the provider guard is installed.
require("./start");
