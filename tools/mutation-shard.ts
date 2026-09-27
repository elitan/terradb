export function parseShard(value: string): { index: number; count: number } {
  const match = value.trim().match(/^(\d+)\/(\d+)$/);
  const index = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
  const count = match ? Number.parseInt(match[2]!, 10) : Number.NaN;
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 1 || index > count) {
    throw new Error(`Invalid shard "${value}". Expected k/N with 1 <= k <= N`);
  }
  return { index, count };
}

/**
 * Splits candidates into contiguous, command-ordered slices so that each
 * shard preflights as few distinct test commands as possible.
 */
export function selectShardCandidates<T extends { command: string; id: string }>(
  candidates: readonly T[],
  shard: { index: number; count: number } | undefined
): T[] {
  if (!shard || shard.count === 1) {
    return [...candidates];
  }
  const ordered = [...candidates].sort(function byCommand(left, right) {
    return left.command.localeCompare(right.command) || left.id.localeCompare(right.id);
  });
  const start = Math.floor(((shard.index - 1) * ordered.length) / shard.count);
  const end = Math.floor((shard.index * ordered.length) / shard.count);
  return ordered.slice(start, end);
}
