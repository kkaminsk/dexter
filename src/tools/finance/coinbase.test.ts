import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { getCoinbasePrices } from './coinbase.js';
import { getCryptoPrices } from './crypto.js';

const originalFetch = globalThis.fetch;
const DAY = 86400;
let requestedUrls: string[] = [];

/** One synthetic daily candle per day: open = day index, close = open + 0.5. */
function candle(time: number): number[] {
  const n = time / DAY;
  return [time, n - 1, n + 1, n, n + 0.5, 2];
}

beforeEach(() => {
  requestedUrls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requestedUrls.push(url.toString());
    if (url.hostname !== 'api.exchange.coinbase.com') {
      return new Response('{"error":"Crypto access restricted"}', { status: 403, statusText: 'Forbidden' });
    }
    const start = Date.parse(url.searchParams.get('start')!) / 1000;
    const end = Date.parse(url.searchParams.get('end')!) / 1000;
    const rows: number[][] = [];
    // Coinbase returns newest first, with both ends of the range included
    for (let t = end; t >= start; t -= DAY) rows.push(candle(t));
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Far-future dates keep these requests out of the on-disk cache (open windows are never cached).
describe('getCoinbasePrices', () => {
  test('aggregates daily candles into Monday-start weeks', async () => {
    // 2099-06-01 is a Monday
    const { prices } = await getCoinbasePrices({
      ticker: 'btc-usd', interval: 'week', interval_multiplier: 1, start_date: '2099-06-01', end_date: '2099-06-14',
    });
    const monday = Date.parse('2099-06-01T00:00:00Z') / 1000 / DAY;
    expect(prices.map((p) => p.time)).toEqual(['2099-06-01', '2099-06-08']);
    expect(prices[0]).toEqual({
      ticker: 'BTC-USD', open: monday, close: monday + 6.5, high: monday + 7, low: monday - 1, volume: 14, time: '2099-06-01',
    });
  });

  test('aggregates into calendar months and pages past 300 candles', async () => {
    const { prices } = await getCoinbasePrices({
      ticker: 'BTC-USD', interval: 'month', interval_multiplier: 1, start_date: '2099-01-01', end_date: '2099-12-31',
    });
    expect(requestedUrls).toHaveLength(2);
    expect(prices).toHaveLength(12);
    expect(prices[1].time).toBe('2099-02-01');
    expect(prices[1].volume).toBe(28 * 2);
  });

  test('rejects ranges that would need too many requests', async () => {
    await expect(
      getCoinbasePrices({ ticker: 'BTC-USD', interval: 'minute', interval_multiplier: 1, start_date: '2099-01-01', end_date: '2099-03-01' }),
    ).rejects.toThrow('date range too large');
    expect(requestedUrls).toHaveLength(0);
  });
});

describe('get_crypto_prices fallback', () => {
  test('uses Coinbase when Financial Datasets refuses the request', async () => {
    const result = JSON.parse(
      await getCryptoPrices.invoke({ ticker: 'BTC-USD', interval: 'day', interval_multiplier: 1, start_date: '2099-06-01', end_date: '2099-06-03' }),
    );
    expect(result.data).toHaveLength(3);
    expect(result.sourceUrls[0]).toContain('api.exchange.coinbase.com');
  });
});
