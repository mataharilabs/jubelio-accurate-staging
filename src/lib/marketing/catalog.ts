import { getStore } from "@/lib/db";
import { listSpendStores } from "@/lib/marketing/service";

export async function marketingStoreChoices(): Promise<string[]> {
  const names = new Set<string>();
  try {
    const store = await getStore();
    const [maps, options] = await Promise.all([
      store.listChannelMaps().catch(() => []),
      store.filterOptions().catch(() => null),
    ]);
    for (const row of maps) if (row.store.trim()) names.add(row.store.trim());
    for (const name of options?.stores ?? []) if (name.trim()) names.add(name.trim());
  } catch {
    // The toko list is a convenience. Saving still requires a name.
  }
  for (const name of await listSpendStores().catch(() => [])) names.add(name);
  return [...names].sort((a, b) => a.localeCompare(b, "id"));
}
