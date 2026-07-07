import { getProduct, loadRegistry } from "./registry.js";
import type { Product } from "./types.js";

export interface ResolveResult {
  selected: Product[];
  added: Product[];   // deps added automatically
  blocked: string[];  // IDs that couldn't be resolved
}

export function resolve(requestedIds: string[]): ResolveResult {
  const registry = loadRegistry();
  const selected: Product[] = [];
  const added: Product[] = [];
  const blocked: string[] = [];
  const seen = new Set<string>();

  function add(id: string, isRequested: boolean): void {
    if (seen.has(id)) return;
    seen.add(id);

    const product = getProduct(id);
    if (!product) {
      blocked.push(id);
      return;
    }

    // Resolve required deps first
    for (const reqId of product.requires) {
      if (!seen.has(reqId)) {
        const dep = getProduct(reqId);
        if (dep) {
          add(reqId, false);
          if (!isRequested && !added.find(p => p.id === reqId)) {
            added.push(dep);
          }
        } else {
          blocked.push(reqId);
        }
      }
    }

    if (isRequested) {
      selected.push(product);
    } else if (!added.find(p => p.id === id)) {
      added.push(product);
    }
  }

  for (const id of requestedIds) {
    add(id, true);
  }

  // Remove from `added` anything the user explicitly requested
  const requestedSet = new Set(requestedIds);
  const cleanAdded = added.filter(p => !requestedSet.has(p.id));

  return {
    selected: registry.products.filter(p => selected.find(s => s.id === p.id)),
    added: registry.products.filter(p => cleanAdded.find(a => a.id === p.id)),
    blocked,
  };
}
