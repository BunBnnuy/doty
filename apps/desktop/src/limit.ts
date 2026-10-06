/**
 * Transcript size limit for the chat panel.
 *
 * Long sessions (and the shared harness feed) would otherwise flood the view, so
 * the panel keeps only the newest rows. Sent rows are dropped first: an in-flight
 * send must stay in the list until its SSE echo can match it.
 */

/** Rows kept in the chat transcript. */
export const MAX_CHAT_ROWS = 10;

/**
 * Indices of the rows to drop, oldest first, so at most `max` remain. Prefers
 * dropping sent rows; other rows are only dropped when there is no alternative.
 */
export function rowsToDrop(statuses: readonly string[], max: number = MAX_CHAT_ROWS): number[] {
  if (max < 0 || statuses.length <= max) return [];
  const drop: number[] = [];
  let remaining = statuses.length;
  for (let i = 0; i < statuses.length && remaining > max; i += 1) {
    if (statuses[i] === 'sent') {
      drop.push(i);
      remaining -= 1;
    }
  }
  for (let i = 0; i < statuses.length && remaining > max; i += 1) {
    if (!drop.includes(i)) {
      drop.push(i);
      remaining -= 1;
    }
  }
  return drop.sort((a, b) => a - b);
}
