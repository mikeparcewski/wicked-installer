import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { Registry, Product, Bundle } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _registry: Registry | null = null;

export function loadRegistry(): Registry {
  if (_registry) return _registry;
  const require = createRequire(import.meta.url);
  _registry = require(join(__dirname, "..", "registry.json")) as Registry;
  return _registry;
}

export function getProduct(id: string): Product | undefined {
  return loadRegistry().products.find(p => p.id === id);
}

export function getBundle(id: string): Bundle | undefined {
  return loadRegistry().bundles.find(b => b.id === id);
}

export function listProducts(includeDesign = false): Product[] {
  return loadRegistry().products.filter(
    p => includeDesign || p.status !== "design"
  );
}

export function listBundles(): Bundle[] {
  return loadRegistry().bundles;
}
