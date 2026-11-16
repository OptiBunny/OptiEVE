import { EveError } from './eve';
import { readManufacturingMarketHistory } from './manufacturing-market';
import type { MarketHistoryArgs, MarketHistoryResponse } from './market-history-types';

type Options = { signal?: AbortSignal };
type Reader = (args: MarketHistoryArgs, options?: Options) => Promise<MarketHistoryResponse>;
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;

/** Public selectors are data, never connection identity or an upstream URL. */
export function validateMarketHistoryArgs(input: unknown): Required<MarketHistoryArgs> {
  const invalid = (): never => { throw new EveError('Choose a public region, type and 1–90 history days.', 400); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== 'string' || !['regionId', 'typeId', 'days'].includes(key)) ||
      keys.some(key => !Object.hasOwn(descriptors[key as string], 'value')) ||
      !Object.hasOwn(descriptors, 'regionId') || !Object.hasOwn(descriptors, 'typeId')) return invalid();
  const regionId = descriptors.regionId.value, typeId = descriptors.typeId.value;
  const days = Object.hasOwn(descriptors, 'days') ? descriptors.days.value : 30;
  if (!integer(regionId) || !integer(typeId) || !integer(days, 90)) return invalid();
  return { regionId, typeId, days };
}

export function createRegionalMarketHistoryReader(read: Reader = readManufacturingMarketHistory) {
  return async (input: unknown, options: Options = {}): Promise<MarketHistoryResponse> => {
    const selected = validateMarketHistoryArgs(input), signal = options.signal;
    if (signal?.aborted) throw new EveError('The public market history request was cancelled.', 503);
    try {
      const result = await read(selected, { signal });
      if (signal?.aborted) throw new EveError('The public market history request was cancelled.', 503);
      return result;
    } catch {
      if (signal?.aborted) throw new EveError('The public market history request was cancelled.', 503);
      throw new EveError('Public market history is temporarily unavailable. Please try again.', 502);
    }
  };
}

export const readRegionalMarketHistory = createRegionalMarketHistoryReader();

