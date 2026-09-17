import { createHash } from "node:crypto";

/** Wilson score interval for a proportion; null below one trial. */
export function wilsonInterval(successes: number, trials: number, z: number): { low: number; high: number } | null {
  if (!(trials > 0)) return null;
  const p = successes / trials, z2 = z * z;
  const centre = (p + z2 / (2 * trials)) / (1 + z2 / trials);
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / (1 + z2 / trials);
  return { low: Number(Math.max(0, centre - half).toFixed(6)), high: Number(Math.min(1, centre + half).toFixed(6)) };
}

/** A reproducible random sample: ids ordered by a seeded hash, the first `size` taken. The same seed and population give the same sample. */
export function seededSample(ids: string[], seed: string, size: number): string[] {
  return [...ids]
    .map((id) => ({ id, key: createHash("sha256").update(`${seed}:${id}`).digest("hex") }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, size))
    .map((item) => item.id);
}
