/** Non-marketplace sales: website, staff/internal, offline, and POS. Other channels, including new marketplaces, stay in. */
const NON_MARKETPLACE = /website|webstore|web[\s-]?store|offline|\bpos\b|internal|staff|kasir|\bmanual\b/i;

export function isMarketplaceChannel(channel: string | null | undefined): boolean {
  const name = (channel ?? "").trim();
  if (!name) return false;
  return !NON_MARKETPLACE.test(name);
}
