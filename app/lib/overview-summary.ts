import type { OverviewMetric, OverviewSectionId } from './overview-types';

export class OverviewDataError extends Error {}
const invalid = (): never => { throw new OverviewDataError('EVE returned data that could not be summarized safely.'); };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const money = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isFinite(value) && value >= minimum && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 100;
const count = (label: string, value: number): OverviewMetric => ({ label, value, unit: 'count' });
const isk = (label: string, value: number): OverviewMetric => ({ label, value: Math.round(value * 100) / 100, unit: 'ISK' });

// ESI dates use an explicit timezone. Reject rollover dates and ambiguous local time.
export function overviewDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const localTime = Date.parse(value.slice(0, 19) + 'Z');
  if (!Number.isFinite(localTime) || new Date(localTime).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  const offset = value.match(/[+-](\d{2}):(\d{2})$/);
  if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}
function date(value: unknown): number {
  const parsed = overviewDate(value);
  return parsed ? Date.parse(parsed) : invalid();
}
function optionalDate(value: unknown): number | null { return value === undefined || value === null ? null : date(value); }
function rows(value: unknown, key: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 10000) return invalid();
  const seen = new Set<number | string>();
  return value.map(row => {
    if (!record(row)) return invalid();
    const id = row[key];
    if (key === 'id' ? typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) : !integer(id, key === 'queue_position' ? 0 : 1)) return invalid();
    const identity = typeof id === 'string' ? id.toLowerCase() : id as number;
    if (seen.has(identity)) return invalid();
    seen.add(identity);
    return row;
  });
}
function sum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!money(value) || !money(total)) return invalid();
  }
  return total;
}
export type OverviewSummary = { metrics: OverviewMetric[]; message: string; partial?: boolean };

// These projections are shared by overview cards and manually loaded tables.
// Free-text descriptions, identities, configuration and unknown fields never
// leave the provider response through these projections.
export function extractionRows(data: unknown) {
  return rows(data, 'structure_id').map(row => {
    if (!integer(row.moon_id, 1)) return invalid();
    const start = date(row.extraction_start_time), arrival = date(row.chunk_arrival_time), decay = date(row.natural_decay_time);
    if (arrival < start || decay < arrival) return invalid();
    return { structure: row.structure_id as number, moon: row.moon_id, start: new Date(start).toISOString(), arrival: new Date(arrival).toISOString(), decay: new Date(decay).toISOString() };
  });
}
export function freelanceRows(data: unknown, maximum = 10000) {
  if (!record(data)) return invalid();
  const all = rows(data.freelance_jobs, 'id');
  if (all.length > maximum) return invalid();
  return all.map(row => {
    if (typeof row.name !== 'string' || row.name.length > 16384 || !row.name.trim() || typeof row.state !== 'string' || !['Unspecified', 'Active', 'Closed', 'Completed', 'Expired', 'Deleted'].includes(row.state) || !record(row.progress) || !integer(row.progress.current) || !integer(row.progress.desired)) return invalid();
    const lastModified = date(row.last_modified);
    if (row.reward !== undefined && (!record(row.reward) || !money(row.reward.initial) || !money(row.reward.remaining))) return invalid();
    const reward = row.reward as { initial: number; remaining: number } | undefined;
    const name = row.name.normalize('NFC').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 256);
    if (!name) return invalid();
    return { id: (row.id as string).toLowerCase(), name, state: row.state, current: row.progress.current, desired: row.progress.desired, lastModified: new Date(lastModified).toISOString(), ...(reward ? { initialReward: Math.round(reward.initial * 100) / 100, remainingReward: Math.round(reward.remaining * 100) / 100 } : {}) };
  });
}

export function summarizeOverview(id: OverviewSectionId, data: unknown, now: number, personal = true): OverviewSummary {
  if (!Number.isFinite(now)) return invalid();
  if (id === 'wallet') {
    if (!personal) {
      const divisions = rows(data, 'division').sort((a, b) => Number(a.division) - Number(b.division));
      if (divisions.length > 7) return invalid();
      let balance = 0;
      for (const division of divisions) {
        if (Number(division.division) > 7 || !money(division.balance, -Number.MAX_SAFE_INTEGER / 100)) return invalid();
        balance += division.balance as number;
        if (!money(balance, -Number.MAX_SAFE_INTEGER / 100)) return invalid();
      }
      const complete = divisions.length === 7;
      const metrics = [count('Wallet divisions returned', divisions.length), ...divisions.map(row => isk(`Division ${row.division} balance`, row.balance as number))];
      if (divisions.length) metrics.push(isk(complete ? 'Balance across all seven divisions' : 'Balance of returned divisions', balance));
      return { metrics, partial: !complete, message: complete ? 'All seven wallet division balances were returned. This cash balance excludes assets and escrow and is not net worth or profit.' : 'Fewer than seven wallet divisions were returned. Missing divisions are unavailable, not zero; no whole-corporation balance is inferred.' };
    }
    if (!money(data, -Number.MAX_SAFE_INTEGER / 100)) return invalid();
    return { metrics: [isk('Wallet balance', data)], message: 'Available character wallet balance. Assets, escrow and corporation wallets are separate; this is not net worth or profit.' };
  }
  if (id === 'training') {
    const queue = rows(data, 'queue_position').sort((a, b) => Number(a.queue_position) - Number(b.queue_position));
    const dates = queue.map(row => {
      if (!integer(row.skill_id, 1) || !integer(row.finished_level, 1) || row.finished_level > 5) return invalid();
      const start = optionalDate(row.start_date), finish = optionalDate(row.finish_date);
      if (start !== null && finish !== null && finish < start) return invalid();
      return finish;
    });
    const future = dates.filter((value): value is number => value !== null && value > now).sort((a, b) => a - b);
    const undated = dates.filter(value => value === null).length;
    const metrics: OverviewMetric[] = [count('Queue entries returned', queue.length), count('Finished by schedule', dates.filter(value => value !== null && value <= now).length), count('Entries without an end time', undated)];
    if (future.length) metrics.push({ label: 'Next scheduled completion', value: new Date(future[0]).toISOString(), unit: 'datetime' });
    if (future.length && !undated) metrics.push({ label: 'Last scheduled completion', value: new Date(future[future.length - 1]).toISOString(), unit: 'datetime' });
    return { metrics, message: undated ? 'Some entries have no end time; training may be paused or unscheduled. No full queue horizon is inferred.' : 'Dates describe the returned training schedule, not confirmed skill completion. EVE may update skill state after the next game login.' };
  }
  if (id === 'orders') {
    const all = rows(data, 'order_id');
    for (const row of all) {
      if (typeof row.is_corporation !== 'boolean' || (row.is_buy_order !== undefined && typeof row.is_buy_order !== 'boolean') || !money(row.price) || !integer(row.volume_remain) || !integer(row.volume_total) || row.volume_remain > row.volume_total || !integer(row.duration, 1) || row.duration > 365 || (row.escrow !== undefined && !money(row.escrow))) return invalid();
      date(row.issued);
    }
    const selected = personal ? all.filter(row => !row.is_corporation) : all;
    const buys = selected.filter(row => row.is_buy_order === true), sells = selected.filter(row => row.is_buy_order === false);
    const unknownSide = selected.filter(row => row.is_buy_order === undefined).length;
    const pastExpiry = selected.filter(row => date(row.issued) + Number(row.duration) * 86400000 <= now).length;
    const metrics = [count('Personal buy orders', buys.length), count('Personal sell orders', sells.length), isk('Remaining sell asking value', sum(sells.map(row => Number(row.price) * Number(row.volume_remain)))), isk('Remaining buy bid value', sum(buys.map(row => Number(row.price) * Number(row.volume_remain))))];
    if (buys.every(row => row.escrow !== undefined)) metrics.push(isk('Buy-order escrow', sum(buys.map(row => Number(row.escrow)))));
    if (unknownSide) metrics.push(count('Personal orders with unknown side', unknownSide));
    if (personal && selected.length !== all.length) metrics.push(count('Corporation orders excluded', all.length - selected.length));
    if (pastExpiry) metrics.push(count('Past stated expiry', pastExpiry));
    return { metrics, ...(unknownSide ? { partial: true } : {}), message: 'Values use remaining quantity and quoted price; they are not proceeds, profit or guaranteed fills. Corporation orders are excluded.' + (unknownSide ? ' Some orders omit their side; they are counted separately and excluded from buy/sell values.' : '') + (buys.some(row => row.escrow === undefined) ? ' Escrow is unavailable because EVE omitted it for one or more buy orders.' : '') + (pastExpiry ? ' Some returned orders are past their stated expiry; the feed may be delayed.' : '') };
  }
  if (id === 'industry') {
    const jobs = rows(data, 'job_id');
    const allowed = ['active', 'cancelled', 'delivered', 'paused', 'ready', 'reverted'];
    for (const job of jobs) {
      if (typeof job.status !== 'string' || !allowed.includes(job.status)) return invalid();
      date(job.end_date);
    }
    const ready = jobs.filter(row => row.status === 'ready').length;
    const active = jobs.filter(row => row.status === 'active');
    return { metrics: [count('Jobs returned', jobs.length), count('Running by schedule', active.filter(row => date(row.end_date) > now).length), count('Ready according to EVE', ready), count('Active past scheduled end', active.filter(row => date(row.end_date) <= now).length), count('Paused jobs', jobs.filter(row => row.status === 'paused').length)], message: 'Completed jobs are not requested. An active job past its scheduled end may be awaiting an EVE update; it is not proof of delivery or output ownership.' };
  }
  if (id === 'contracts') {
    const contracts = rows(data, 'contract_id');
    const statuses = ['outstanding', 'in_progress', 'finished_issuer', 'finished_contractor', 'finished', 'cancelled', 'rejected', 'failed', 'deleted', 'reversed'];
    for (const contract of contracts) {
      if (typeof contract.status !== 'string' || !statuses.includes(contract.status)) return invalid();
      date(contract.date_expired);
    }
    const outstanding = contracts.filter(row => row.status === 'outstanding');
    return { metrics: [count('Contracts in this page', contracts.length), count('Outstanding before expiry', outstanding.filter(row => date(row.date_expired) > now).length), count('Outstanding expiring within 24h', outstanding.filter(row => date(row.date_expired) > now && date(row.date_expired) <= now + 86400000).length), count('Outstanding past stated expiry', outstanding.filter(row => date(row.date_expired) <= now).length), count('In progress', contracts.filter(row => row.status === 'in_progress').length)], message: 'Counts describe the selected contract feed and page, not ownership or profit. Offer expiration is not an accepted courier contract’s delivery deadline.' };
  }
  if (id === 'projects') {
    if (!record(data)) return invalid();
    const projects = rows(data.projects, 'id');
    const states = ['Unspecified', 'Active', 'Closed', 'Completed', 'Expired', 'Deleted'];
    for (const project of projects) if (typeof project.state !== 'string' || !states.includes(project.state)) return invalid();
    return { metrics: [count('Projects in this batch', projects.length), count('Active projects in batch', projects.filter(row => row.state === 'Active').length)], message: 'One batch of active corporation projects is requested. Only project counts are shown here; objectives and contribution details are not requested. These counts are not a corporation-wide total.' };
  }
  if (id === 'extractions') {
    const all = extractionRows(data);
    const arrivals = all.map(row => Date.parse(row.arrival)).filter(value => value > now).sort((a, b) => a - b);
    const metrics: OverviewMetric[] = [count('Extractions in this page', all.length), count('Starts still pending', all.filter(row => Date.parse(row.start) > now).length), count('Arrivals still pending', all.filter(row => Date.parse(row.start) <= now && Date.parse(row.arrival) > now).length), count('Arrival passed before natural fracture', all.filter(row => Date.parse(row.arrival) <= now && Date.parse(row.decay) > now).length), count('Natural fracture time passed', all.filter(row => Date.parse(row.decay) <= now).length)];
    if (arrivals.length) metrics.push({ label: 'Next scheduled chunk arrival (UTC)', value: new Date(arrivals[0]).toISOString(), unit: 'datetime' });
    return { metrics, message: 'Counts classify the returned extraction schedule at load time. Arrival means a chunk is scheduled to be available for fracturing; natural fracture is the automatic fracture time if it was not fractured earlier. Neither timestamp proves ore is available, mined or depleted, and no yield or value is inferred.' };
  }
  if (id === 'freelance') {
    const all = freelanceRows(data, personal ? 10000 : 100);
    const metrics = [count(personal ? 'Participated jobs returned' : 'Freelance jobs in this batch', all.length), count('Active jobs returned', all.filter(row => row.state === 'Active').length), count('Completed jobs returned', all.filter(row => row.state === 'Completed').length), count('Closed or expired jobs returned', all.filter(row => row.state === 'Closed' || row.state === 'Expired').length)];
    const rewards = all.filter(row => row.initialReward !== undefined);
    metrics.push(count('Jobs with reported reward reserves', rewards.length));
    if (rewards.length) metrics.push(isk('Remaining reserve for jobs reporting rewards', sum(rewards.map(row => row.remainingReward as number))));
    return { metrics, message: (personal ? 'Only jobs in which the selected character is actively participating are requested; this is not freelance history. ' : 'Only one corporation freelance-job batch is requested; this is not a corporation-wide total. ') + 'Progress belongs to each job, not the selected character, so different objectives are not added together. Reward reserves are job budgets, not earned, claimable or paid rewards or profit. Missing rewards are unavailable, not zero. Participation details and participant lists are not requested.' };
  }
  return invalid();
}
