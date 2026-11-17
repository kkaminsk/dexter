import { mkdirSync, writeFileSync } from 'node:fs';
import { dexterPath } from '../../utils/paths.js';

/** Price tools whose full result is too long to hand to the model inline. */
const PRICE_HISTORY_TOOLS = new Set(['get_stock_prices', 'get_crypto_prices']);
const COLUMNS = ['time', 'open', 'high', 'low', 'close', 'volume'] as const;

/** Rows shown inline by the price formatter; longer histories are also saved to disk. */
export const INLINE_PRICE_ROWS = 20;

type Row = Record<string, unknown>;

/** Oldest first. ISO dates and timestamps sort correctly as strings. */
export function sortPriceRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => String(a.time ?? a.date ?? '').localeCompare(String(b.time ?? b.date ?? '')));
}

/**
 * Write a full OHLCV history to a CSV under .dexter/data/prices so the agent can
 * compute indicators from every row instead of the inline excerpt. Returns the
 * note to append to the tool result, or null when nothing was saved.
 */
export function savePriceHistory(tool: string, data: unknown, args: Row): string | null {
  if (!PRICE_HISTORY_TOOLS.has(tool) || !Array.isArray(data) || data.length <= INLINE_PRICE_ROWS) {
    return null;
  }
  const name = [args.ticker, `${args.interval_multiplier ?? 1}${args.interval ?? 'day'}`, args.start_date, args.end_date]
    .map((part) => String(part ?? '').toUpperCase().replace(/[^A-Z0-9-]/g, ''))
    .filter(Boolean)
    .join('_');
  const path = dexterPath('data', 'prices', `${name}.csv`);
  const lines = sortPriceRows(data as Row[]).map((row) =>
    COLUMNS.map((column) => row[column] ?? (column === 'time' ? row.date : '') ?? '').join(','),
  );
  try {
    mkdirSync(dexterPath('data', 'prices'), { recursive: true });
    writeFileSync(path, [COLUMNS.join(','), ...lines].join('\n') + '\n');
  } catch {
    // The inline excerpt still stands on its own if the disk write fails
    return null;
  }
  return `All ${data.length} rows saved to ${path} (CSV, oldest first: ${COLUMNS.join(',')}). Use that file for indicators or analysis that need more than the rows shown.`;
}
