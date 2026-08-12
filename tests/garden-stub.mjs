#!/usr/bin/env node
// Test stub for the wicked-garden CLI (WICKED_GARDEN_BIN target).
// Appends its argv to $GARDEN_STUB_LOG and exits $GARDEN_STUB_EXIT (default 0).
import { appendFileSync } from "node:fs";

const log = process.env.GARDEN_STUB_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\n");
process.exit(Number(process.env.GARDEN_STUB_EXIT ?? "0"));
