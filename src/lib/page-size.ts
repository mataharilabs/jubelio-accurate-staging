export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200] as const;

export function clampPageSize(value: unknown, fallback = 25): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(parsed) ? parsed : fallback;
}
