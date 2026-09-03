import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRICES_PATH, ensureDirs } from "./paths.js";
import { log } from "./logger.js";

type PriceEntry = { input: number; output: number };
type PriceTable = Record<string, Record<string, PriceEntry>>;

let _cached: PriceTable | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Bundled defaults at daemon/prices.json (two levels above dist/util/prices.js).
const BUNDLED_PATH = join(__dirname, "..", "..", "prices.json");

export function prices(): PriceTable {
  if (_cached) return _cached;
  ensureDirs();
  if (!existsSync(PRICES_PATH)) {
    if (existsSync(BUNDLED_PATH)) {
      try { copyFileSync(BUNDLED_PATH, PRICES_PATH); }
      catch (err) { log.warn({ err }, "failed to seed prices.json from bundle"); }
    }
  }
  try {
    const text = existsSync(PRICES_PATH) ? readFileSync(PRICES_PATH, "utf8") : "{}";
    _cached = JSON.parse(text) as PriceTable;
  } catch (err) {
    log.warn({ err }, "prices.json unreadable; using empty table");
    _cached = {};
  }
  mergeMissingBundledRates(_cached);
  return _cached;
}

function isPriceEntry(value: unknown): value is PriceEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<PriceEntry>;
  return typeof entry.input === "number" && typeof entry.output === "number";
}

/**
 * IN-MEMORY ONLY: fill (vendor, model) rates that ship in the bundled table but
 * are absent from the operator's on-disk prices.json.
 *
 * The on-disk file is seeded once and then owned by the operator, so a model
 * added in a later release would otherwise price at 0 forever on any install
 * that predates it — silently, since computeCost falls back to 0 on a miss.
 * An existing on-disk rate is NEVER overwritten (an operator edit wins) and
 * nothing is ever written back to disk.
 */
function mergeMissingBundledRates(table: PriceTable): void {
  if (!existsSync(BUNDLED_PATH)) return;
  let bundled: PriceTable;
  try {
    bundled = JSON.parse(readFileSync(BUNDLED_PATH, "utf8")) as PriceTable;
  } catch (err) {
    log.warn({ err }, "bundled prices.json unreadable; skipping rate merge");
    return;
  }
  for (const vendor of Object.keys(bundled)) {
    const bundledVendor = bundled[vendor];
    if (typeof bundledVendor !== "object" || bundledVendor === null) continue;
    for (const modelId of Object.keys(bundledVendor)) {
      const entry = bundledVendor[modelId];
      if (!isPriceEntry(entry)) continue; // skip note/comment blocks
      const onDisk = table[vendor];
      if (typeof onDisk !== "object" || onDisk === null) {
        table[vendor] = { [modelId]: entry };
        continue;
      }
      if (onDisk[modelId] === undefined) onDisk[modelId] = entry;
    }
  }
}

/** Compute USD cost for tokens against a model id. Falls back to 0 silently. */
export function computeCost(modelId: string, tokensIn: number, tokensOut: number): number {
  const table = prices();
  for (const vendor of Object.keys(table)) {
    const vendorTable = table[vendor];
    if (!vendorTable) continue;
    const entry = vendorTable[modelId];
    if (entry) {
      return (tokensIn * entry.input + tokensOut * entry.output) / 1_000_000;
    }
  }
  return 0;
}
