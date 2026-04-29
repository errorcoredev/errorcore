/**
 * @module 21-w3c-tracestate
 * @spec spec/21-w3c-tracestate.md
 * @dependencies (none — pure helpers)
 *
 * Parse and format the W3C `tracestate` HTTP header. Carries the EventClock
 * (module 19) value as `<vendorKey>=clk:<n>` for cross-service Lamport
 * propagation. Foreign vendor entries are preserved verbatim across the
 * round trip so other observability vendors keep working.
 */

const W3C_MAX_ENTRIES = 32;
const W3C_MAX_TOTAL_LENGTH = 512;

export interface ParsedTracestate {
  /** Numeric clock value carried under `<vendorKey>=clk:<n>`, or null. */
  receivedSeq: number | null;
  /** All other vendor entries, preserved verbatim and in original order. */
  inheritedEntries: string[];
}

/**
 * Parse a `tracestate` header. Silent on malformed input — never throws,
 * never warns. Empty / undefined / whitespace-only resolve to a clean
 * empty result.
 */
export function parseTracestate(
  header: string | undefined,
  vendorKey: string
): ParsedTracestate {
  const result: ParsedTracestate = { receivedSeq: null, inheritedEntries: [] };
  if (typeof header !== 'string' || header.length === 0) return result;

  const entries = header.split(',');
  for (const raw of entries) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key.length === 0) continue;

    if (key === vendorKey) {
      // First valid clk:<n> wins. Subsequent <vendorKey>= entries are dropped
      // entirely from the inherited list — we re-emit our own on egress.
      const match = /^clk:(\d{1,16})$/.exec(value);
      if (match !== null && result.receivedSeq === null) {
        const n = Number(match[1]);
        if (Number.isSafeInteger(n) && n > 0) {
          result.receivedSeq = n;
        }
      }
      continue;
    }

    result.inheritedEntries.push(trimmed);
  }
  return result;
}

/**
 * Build the egress `tracestate` value. Our entry is prepended (most-recent
 * first per W3C §3.3.1). Capped to 32 entries / 512 chars by trimming the
 * rightmost (oldest) entries. Our own entry is preserved as long as the cap
 * allows at least one entry.
 */
export function formatTracestate(
  currentSeq: number,
  inherited: string[] | undefined,
  vendorKey: string
): string {
  const ours = `${vendorKey}=clk:${currentSeq}`;
  const list: string[] = [ours, ...(inherited ?? [])];

  while (list.length > W3C_MAX_ENTRIES) {
    list.pop();
  }
  let joined = list.join(',');
  while (joined.length > W3C_MAX_TOTAL_LENGTH && list.length > 1) {
    list.pop();
    joined = list.join(',');
  }

  return joined;
}
