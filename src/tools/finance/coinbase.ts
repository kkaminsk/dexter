import { readCache, writeCache } from '../../utils/cache.js';

/**
 * Coinbase Exchange public market data (no API key). Used as a fallback for
 * crypto prices when Financial Datasets refuses the request.
 */
const BASE_URL = 'https://api.exchange.coinbase.com';
const CACHE_ENDPOINT = '/coinbase/prices';
const MAX_CANDLES_PER_REQUEST = 300;
// Bounds a single call: 40 pages is ~32 years of daily candles or ~8 days of minute candles.
const MAX_REQUESTS = 40;
const DAY_SECONDS = 86400;

export type CryptoInterval = 'minute' | 'day' | 'week' | 'month' | 'year';

export interface CryptoPricesParams {
  ticker: string;
  interval: CryptoInterval;
  interval_multiplier: number;
  start_date: string;
  end_date: string;
}

export interface CryptoPrice {
  ticker: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** Coinbase-only volume, in units of the base currency (e.g. BTC). */
  volume: number;
  time: string;
}

/** Coinbase candle row: [time, low, high, open, close, volume], time in epoch seconds. */
type Candle = [number, number, number, number, number, number];

async function coinbaseGet(path: string, params: Record<string, string | number> = {}): Promise<{ data: unknown; url: string }> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(key, String(value));
  }
  const response = await fetch(url.toString(), { headers: { 'User-Agent': 'dexter' } });
  if (!response.ok) {
    throw new Error(`[Coinbase API] request failed: ${response.status} ${response.statusText}`);
  }
  return { data: await response.json(), url: url.toString() };
}

/** Identifies the period a candle belongs to; candles sharing a key are merged. */
function bucketKey(time: number, interval: CryptoInterval, multiplier: number): number {
  const date = new Date(time * 1000);
  const day = Math.floor(time / DAY_SECONDS);
  switch (interval) {
    case 'minute':
      return Math.floor(time / (60 * multiplier));
    case 'day':
      return Math.floor(day / multiplier);
    case 'week':
      // Epoch day 0 is a Thursday; shifting by 3 makes weeks run Monday-Sunday (UTC).
      return Math.floor(Math.floor((day + 3) / 7) / multiplier);
    case 'month':
      return Math.floor((date.getUTCFullYear() * 12 + date.getUTCMonth()) / multiplier);
    case 'year':
      return Math.floor(date.getUTCFullYear() / multiplier);
  }
}

function aggregate(candles: Candle[], params: CryptoPricesParams): CryptoPrice[] {
  const prices: CryptoPrice[] = [];
  let currentKey: number | null = null;
  for (const [time, low, high, open, close, volume] of candles) {
    const key = bucketKey(time, params.interval, params.interval_multiplier);
    const last = prices[prices.length - 1];
    if (last && key === currentKey) {
      last.high = Math.max(last.high, high);
      last.low = Math.min(last.low, low);
      last.close = close;
      last.volume += volume;
      continue;
    }
    currentKey = key;
    const iso = new Date(time * 1000).toISOString();
    prices.push({
      ticker: params.ticker,
      open,
      close,
      high,
      low,
      volume,
      // Each period is labelled with its first candle
      time: params.interval === 'minute' ? iso : iso.slice(0, 10),
    });
  }
  return prices;
}

/**
 * Historical OHLCV candles in the Financial Datasets shape. Coinbase only serves
 * fixed granularities, 300 candles per request, so this pages through minute or
 * daily candles and aggregates them into the requested interval.
 */
export async function getCoinbasePrices(params: CryptoPricesParams): Promise<{ prices: CryptoPrice[]; url: string }> {
  const ticker = params.ticker.trim().toUpperCase();
  const granularity = params.interval === 'minute' ? 60 : DAY_SECONDS;
  const start = Date.parse(`${params.start_date}T00:00:00Z`) / 1000;
  // end_date is inclusive: run to the last candle that opens on that day
  const end = Date.parse(`${params.end_date}T00:00:00Z`) / 1000 + DAY_SECONDS - granularity;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error(`[Coinbase API] invalid date range: ${params.start_date} to ${params.end_date}`);
  }

  // Closed windows are final, so they can be served from the local cache
  const cacheParams = { ...params, ticker };
  const cacheable = end + granularity <= Date.now() / 1000;
  if (cacheable) {
    const cached = readCache(CACHE_ENDPOINT, cacheParams);
    if (cached) {
      return { prices: cached.data.prices as CryptoPrice[], url: cached.url };
    }
  }

  const windowSeconds = granularity * MAX_CANDLES_PER_REQUEST;
  const requestCount = Math.ceil((end - start + granularity) / windowSeconds);
  if (requestCount > MAX_REQUESTS) {
    throw new Error(
      `[Coinbase API] date range too large for ${params.interval} candles (${requestCount} requests, max ${MAX_REQUESTS})`,
    );
  }

  const byTime = new Map<number, Candle>();
  let firstUrl = '';
  for (let i = 0; i < requestCount; i++) {
    const pageStart = start + i * windowSeconds;
    const pageEnd = Math.min(pageStart + windowSeconds - granularity, end);
    const { data, url } = await coinbaseGet(`/products/${ticker}/candles`, {
      granularity,
      start: new Date(pageStart * 1000).toISOString(),
      end: new Date(pageEnd * 1000).toISOString(),
    });
    firstUrl ||= url;
    for (const candle of data as Candle[]) {
      byTime.set(candle[0], candle);
    }
  }

  const candles = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  const prices = aggregate(candles, { ...params, ticker });
  if (cacheable && prices.length > 0) {
    writeCache(CACHE_ENDPOINT, cacheParams, { prices }, firstUrl);
  }
  return { prices, url: firstUrl };
}

/** Latest trade plus rolling 24-hour stats, in the Financial Datasets snapshot shape. */
export async function getCoinbaseSnapshot(tickerInput: string): Promise<{ snapshot: Record<string, unknown>; url: string }> {
  const ticker = tickerInput.trim().toUpperCase();
  const [trade, stats] = await Promise.all([
    coinbaseGet(`/products/${ticker}/ticker`),
    coinbaseGet(`/products/${ticker}/stats`),
  ]);
  const last = trade.data as Record<string, string>;
  const day = stats.data as Record<string, string>;
  const price = Number(last.price);
  const open = Number(day.open);
  return {
    snapshot: {
      ticker,
      price,
      open,
      high: Number(day.high),
      low: Number(day.low),
      volume: Number(day.volume),
      // Coinbase stats are a rolling 24 hours, not a calendar day
      day_change: price - open,
      day_change_percent: open ? ((price - open) / open) * 100 : null,
      time: last.time,
      source: 'Coinbase',
    },
    url: trade.url,
  };
}
