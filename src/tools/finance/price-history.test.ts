import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { savePriceHistory, INLINE_PRICE_ROWS } from './price-history.js';
import { formatStockPrices } from './formatters.js';
import { resultKey } from './get-market-data.js';
import { dexterPath } from '../../utils/paths.js';

const TICKER = 'TESTONLY-USD';
const args = { ticker: TICKER, interval: 'day', interval_multiplier: 1, start_date: '2099-01-01', end_date: '2099-01-30' };
const csvPath = dexterPath('data', 'prices', `${TICKER}_1DAY_2099-01-01_2099-01-30.csv`);

/** 30 daily rows, newest first, to prove ordering is normalised. */
const rows = Array.from({ length: 30 }, (_, i) => {
  const day = 30 - i;
  return { ticker: TICKER, time: `2099-01-${String(day).padStart(2, '0')}`, open: day, high: day + 2, low: day - 1, close: day + 1, volume: 100 };
});

afterAll(() => rmSync(csvPath, { force: true }));

describe('savePriceHistory', () => {
  test('writes every row to a CSV, oldest first, and reports the path', () => {
    const note = savePriceHistory('get_crypto_prices', rows, args);
    expect(note).toContain(csvPath);
    const lines = readFileSync(csvPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(31);
    expect(lines[0]).toBe('time,open,high,low,close,volume');
    expect(lines[1]).toBe('2099-01-01,1,3,0,2,100');
    expect(lines[30]).toBe('2099-01-30,30,32,29,31,100');
  });

  test('skips short histories and non-price tools', () => {
    expect(savePriceHistory('get_crypto_prices', rows.slice(0, INLINE_PRICE_ROWS), { ...args, ticker: 'SHORT-USD' })).toBeNull();
    expect(savePriceHistory('get_company_news', rows, { ...args, ticker: 'NEWS-USD' })).toBeNull();
    expect(existsSync(dexterPath('data', 'prices', 'SHORT-USD_1DAY_2099-01-01_2099-01-30.csv'))).toBe(false);
  });
});

describe('formatStockPrices', () => {
  test('shows the most recent rows with highs and lows, and the full-range extremes', () => {
    const text = formatStockPrices(rows);
    expect(text).toContain('30 rows, 2099-01-01 to 2099-01-30');
    expect(text).toContain('Range high $32.00 (2099-01-30), range low $0.00 (2099-01-01)');
    expect(text).toContain('| 2099-01-30 | $30.00 | $32.00 | $29.00 | $31.00 | 100 |');
    expect(text).toContain('| 2099-01-11 |');
    expect(text).not.toContain('| 2099-01-10 |');
  });
});

describe('resultKey', () => {
  test('keeps same-ticker results at different intervals apart', () => {
    const taken: Record<string, unknown> = {};
    const keys = ['day', 'week', 'month', 'month'].map((interval) => {
      const key = resultKey('get_crypto_prices', { ticker: 'BTC-USD', interval }, taken);
      taken[key] = true;
      return key;
    });
    expect(keys).toEqual([
      'get_crypto_prices_BTC-USD_day',
      'get_crypto_prices_BTC-USD_week',
      'get_crypto_prices_BTC-USD_month',
      'get_crypto_prices_BTC-USD_month_2',
    ]);
    expect(resultKey('get_company_news', {}, taken)).toBe('get_company_news');
  });
});
