/**
 * An auto-created product whose SKU was replaced by a later order version.
 * `updated_by` is intentionally not an input: a brand-only human edit must not protect it.
 */
export type SupersededSkuInput = {
  createdBy: string | null;
  active: boolean;
  /** 'false', 'unknown', or null can be removed. 'true' stays. */
  accurateFound: string | null;
  hasCost: boolean;
  /** At least one order_lines row on a version with is_current false. */
  onHistoricalOrder: boolean;
  /** Any is_current version, including data_status 'deleted'. */
  onCurrentOrder: boolean;
  inBundle: boolean;
};

export function isSupersededAutoSku(input: SupersededSkuInput): boolean {
  if (input.createdBy != null) return false;
  if (input.active !== true) return false;
  if (!input.onHistoricalOrder || input.onCurrentOrder) return false;
  const found = input.accurateFound;
  if (found !== "false" && found !== "unknown" && found != null) return false;
  if (input.hasCost || input.inBundle) return false;
  return true;
}

/** bundle_weights.bundle_key is either the SKU or `{bundle}-{component}`. */
export function bundleKeyMentionsSku(bundleKey: string, sku: string): boolean {
  const key = bundleKey.trim();
  const wanted = sku.trim();
  if (!key || !wanted) return false;
  return key === wanted || key.startsWith(`${wanted}-`) || key.endsWith(`-${wanted}`);
}

export function bundleProtectedSkus(
  skus: readonly string[],
  components: readonly { bundleSku: string; componentSku: string }[],
  bundleKeys: readonly string[],
): Set<string> {
  const direct = new Set<string>();
  for (const row of components) {
    const bundle = row.bundleSku.trim();
    const component = row.componentSku.trim();
    if (bundle) direct.add(bundle);
    if (component) direct.add(component);
  }
  const protectedSkus = new Set<string>();
  for (const sku of skus) {
    const wanted = sku.trim();
    if (!wanted) continue;
    if (direct.has(wanted) || bundleKeys.some((key) => bundleKeyMentionsSku(key, wanted))) protectedSkus.add(wanted);
  }
  return protectedSkus;
}

export type SupersededProductFact = {
  sku: string;
  createdBy: string | null;
  active: boolean;
  accurateFound: string | null;
};

export function supersededSkus(input: {
  products: readonly SupersededProductFact[];
  costSkus: ReadonlySet<string>;
  protectedSkus: ReadonlySet<string>;
  historicalSkus: ReadonlySet<string>;
  currentSkus: ReadonlySet<string>;
}): string[] {
  const chosen: string[] = [];
  for (const product of input.products) {
    const sku = product.sku.trim();
    if (!sku) continue;
    if (!isSupersededAutoSku({
      createdBy: product.createdBy,
      active: product.active,
      accurateFound: product.accurateFound,
      hasCost: input.costSkus.has(sku),
      onHistoricalOrder: input.historicalSkus.has(sku),
      onCurrentOrder: input.currentSkus.has(sku),
      inBundle: input.protectedSkus.has(sku),
    })) continue;
    chosen.push(sku);
  }
  return chosen;
}
