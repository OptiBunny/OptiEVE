export type Character = { characterId: number; name: string; corporationId: number; scopes: string[] };
const corporationFeatureScopes = {
  contracts: 'esi-contracts.read_corporation_contracts.v1',
  industry: 'esi-industry.read_corporation_jobs.v1',
  projects: 'esi-corporations.read_projects.v1',
  blueprints: 'esi-corporations.read_blueprints.v1',
  facilities: 'esi-corporations.read_facilities.v1',
  structures: 'esi-corporations.read_structures.v1',
  extractions: 'esi-industry.read_corporation_mining.v1',
  freelance: 'esi-corporations.read_freelance_jobs.v1',
} as const;
export type CorporationFeature = { id: keyof typeof corporationFeatureScopes; label: string; scope: string; description: string };
export type ConnectionStatus = {
  configured: boolean;
  clientId: string | null;
  setupUrl: string;
  callbackUrl: string;
  characters: Character[];
  scopes: { character: string[]; corporation: string[] };
  corporationFeatures?: CorporationFeature[];
};
export type ConnectionAccessSelection = { corporation: boolean; corporationFeatures: string[] };
export type ReconnectReview = {
  characterId: number;
  name: string;
  scopes: string[];
  omittedScopeCount: number;
  grantSnapshot: string;
};

export function connectionAccessPreset(status: ConnectionStatus, preset: 'character' | 'all'): ConnectionAccessSelection {
  return { corporation: preset === 'all', corporationFeatures: preset === 'all' ? (status.corporationFeatures ?? []).map(feature => feature.id) : [] };
}

export function selectedConnectionScopes(status: ConnectionStatus, selection: ConnectionAccessSelection): string[] {
  const features = status.corporationFeatures ?? [];
  if (typeof selection.corporation !== 'boolean' || !Array.isArray(selection.corporationFeatures) ||
      new Set(selection.corporationFeatures).size !== selection.corporationFeatures.length ||
      selection.corporationFeatures.some(id => !features.some(feature => feature.id === id))) {
    throw new ConnectionResponseError('The read access selection has changed. Choose an access preset again.');
  }
  return [...new Set([...status.scopes.character, ...(selection.corporation ? status.scopes.corporation : []),
    ...features.filter(feature => selection.corporationFeatures.includes(feature.id)).map(feature => feature.scope)])];
}

export function reviewReconnect(status: ConnectionStatus, characterId: number): ReconnectReview {
  const character = status.characters.find(character => character.characterId === characterId);
  if (!identifier(characterId) || !character || !status.configured || !status.clientId) {
    throw new ConnectionResponseError('This character is no longer ready to reconnect. Reload connection status and try again.');
  }
  // The status catalogue comes from the server's explicit read allowlist. The
  // server independently derives the actual OAuth scopes; this is review only.
  const supported = selectedConnectionScopes(status, connectionAccessPreset(status, 'all'));
  const saved = [...new Set(character.scopes)].sort();
  const scopes = supported.filter(scope => saved.includes(scope));
  return { characterId, name: character.name, scopes, omittedScopeCount: saved.length - scopes.length, grantSnapshot: JSON.stringify(saved) };
}

export function reconnectReviewIsCurrent(status: ConnectionStatus, review: ReconnectReview): boolean {
  try {
    const current = reviewReconnect(status, review.characterId);
    return current.name === review.name && current.grantSnapshot === review.grantSnapshot &&
      current.omittedScopeCount === review.omittedScopeCount && JSON.stringify(current.scopes) === JSON.stringify(review.scopes);
  } catch { return false; }
}

export function reconnectAuthorization(status: ConnectionStatus, review: ReconnectReview): { reconnectCharacterId: number } {
  if (!reconnectReviewIsCurrent(status, review)) throw new ConnectionResponseError('This character’s permissions changed. Review its reconnect selection again.');
  if (!review.scopes.length) throw new ConnectionResponseError('No supported permissions remain for this character. Choose an access preset to continue.');
  return { reconnectCharacterId: review.characterId };
}

const callbackErrors: Record<string, string> = {
  state_storage: 'The connection service could not load this sign-in. Please start again.',
  state_decryption: 'The saved sign-in could not be read. Please start again.',
  token_request: 'EVE’s authorization service could not complete the token exchange. Please try again.',
  token_response: 'EVE did not return a complete authorization. Please try again.',
  signing_keys: 'EVE’s signing keys could not be loaded. Please try again.',
  profile_request: 'The character profile could not be retrieved from EVE. Please try again.',
  profile_response: 'EVE returned an incomplete character profile. Please try again.',
  token_storage: 'The authorization could not be encrypted for storage. Please try again.',
  connection_storage: 'The connection could not be saved. Please try again.',
  expired: 'This sign-in expired or was already used. Start a fresh sign-in below.',
  verification: 'EVE returned an authorization that could not be verified. Start a fresh sign-in below.',
  permissions: 'EVE returned permissions that do not match this sign-in. Review your access selection and reconnect.',
  character_mismatch: 'EVE returned a different character. Reconnect again and choose the character you selected.',
  authorization: 'EVE authorization was not accepted. Start a fresh sign-in below.',
  service: 'An EVE or connection service request failed. Please try again.',
};

export function callbackError(reason: string | null): string {
  return reason !== null && Object.hasOwn(callbackErrors, reason)
    ? callbackErrors[reason]
    : 'EVE sign-in did not finish. Please try connecting again.';
}

export class ConnectionResponseError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function webUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}
function identifier(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function connectionStatus(value: unknown): ConnectionStatus {
  if (!record(value) || typeof value.configured !== 'boolean' ||
      !(value.clientId === null || typeof value.clientId === 'string') ||
      !webUrl(value.setupUrl) || !webUrl(value.callbackUrl) ||
      !record(value.scopes) || !strings(value.scopes.character) || !strings(value.scopes.corporation) ||
      (value.corporationFeatures !== undefined && (!Array.isArray(value.corporationFeatures) || value.corporationFeatures.length > Object.keys(corporationFeatureScopes).length ||
        new Set(value.corporationFeatures.map(feature => record(feature) ? feature.id : null)).size !== value.corporationFeatures.length ||
        !value.corporationFeatures.every(feature => record(feature) && typeof feature.id === 'string' && Object.hasOwn(corporationFeatureScopes, feature.id) &&
          typeof feature.label === 'string' && feature.scope === corporationFeatureScopes[feature.id as CorporationFeature['id']] && typeof feature.description === 'string'))) ||
      !Array.isArray(value.characters) || new Set(value.characters.map(character => record(character) ? character.characterId : null)).size !== value.characters.length || !value.characters.every(character =>
        record(character) && identifier(character.characterId) && identifier(character.corporationId) &&
        typeof character.name === 'string' && strings(character.scopes))) {
    throw new ConnectionResponseError('The connection service returned an incomplete status. Please try again.');
  }
  return value as ConnectionStatus;
}

export function signInUrl(value: unknown): string {
  if (record(value) && typeof value.url === 'string') {
    try {
      const url = new URL(value.url);
      if (url.origin === 'https://login.eveonline.com' && !url.username && !url.password) return url.href;
    } catch { /* Report a safe, actionable message below. */ }
  }
  throw new ConnectionResponseError('The connection service returned an unexpected sign-in address. Please try again.');
}

export async function connectionRequest(path: 'status' | 'config' | 'connect' | 'disconnect', body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/eve/' + path, {
      cache: 'no-store', signal: controller.signal,
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      // Release an unread gateway response without retaining its private body.
      await response.body?.cancel().catch(() => {});
      throw new ConnectionResponseError('Sign in to this private connector to load your connection.', 401);
    }
    let value: unknown;
    try { value = await response.json(); }
    catch {
      if (controller.signal.aborted) throw new ConnectionResponseError('The connection service took too long to respond. Please try again.');
      throw new ConnectionResponseError('The connection service returned an unreadable response. Please try again.', response.status);
    }
    if (!response.ok) {
      const message = record(value) && typeof value.error === 'string' && value.error.trim() && value.error.length <= 512
        ? value.error : 'The request could not be completed. Please try again.';
      throw new ConnectionResponseError(message, response.status);
    }
    return value;
  } catch (error) {
    if (error instanceof ConnectionResponseError) throw error;
    throw new ConnectionResponseError(controller.signal.aborted
      ? 'The connection service took too long to respond. Please try again.'
      : 'Could not reach the connection service. Please try again.');
  } finally { clearTimeout(timer); }
}
