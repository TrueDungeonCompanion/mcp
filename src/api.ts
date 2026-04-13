/**
 * Thin HTTP client for the True Dungeon Companion public API (v1).
 * All functions return parsed JSON; callers handle MCP response formatting.
 */

const DEFAULT_BASE = 'https://api.tdcompanion.app';

function getBaseUrl(): string {
  return process.env.TDC_API_BASE_URL ?? DEFAULT_BASE;
}

function getApiKey(): string | undefined {
  return process.env.TDC_API_KEY;
}

async function apiFetch(path: string, options?: { method?: string; body?: string }): Promise<unknown> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  const key = getApiKey();
  if (key) headers['Authorization'] = `Bearer ${key}`;
  if (options?.body) headers['Content-Type'] = 'application/json';

  const resp = await fetch(url, {
    method: options?.method ?? 'GET',
    headers,
    body: options?.body,
  });
  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    // ASP.NET ProblemDetails responses include title/detail — surface those instead of the raw body.
    let friendly = raw;
    try {
      const parsed = JSON.parse(raw);
      const pd = parsed?.detail ?? parsed?.error ?? parsed?.title;
      if (pd) friendly = String(pd);
    } catch { /* not JSON — fall back to raw */ }
    throw new Error(`API ${resp.status} ${resp.statusText}: ${friendly}`);
  }
  const contentType = resp.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    const preview = (await resp.text().catch(() => '')).slice(0, 200);
    throw new Error(`Expected JSON from ${url} but got ${contentType || 'unknown'} (status ${resp.status}). Check TDC_API_BASE_URL points at the API host, not the web app. Body preview: ${preview}`);
  }
  return resp.json();
}

// ── Tokens ────────────────────────────────────────────────────────────────────

export interface TokenSummary {
  id: string;
  slug: string;
  name: string;
  rarity: string;
  tokenText: string;
  imageUrl?: string;
}

export interface TokenDetail extends TokenSummary {
  description?: string;
  slots: string[];
  usableBy: string[];
  equippable: boolean;
  damageWheel: number[];
  weaponAttackMode?: string;
  handedness?: string;
  years: number[];
  tags: string[];
  exchangeFor?: string;
  updated: string;
  effects: { type: string; displayText: string }[];
}

export interface PagedResult<T> {
  total: number;
  skip: number;
  take: number;
  items: T[];
}

export async function searchTokens(params: {
  q?: string;
  slot?: string;
  rarity?: string;
  class?: string;
  skip?: number;
  take?: number;
}): Promise<PagedResult<TokenSummary>> {
  const qs = new URLSearchParams();
  if (params.q) qs.set('q', params.q);
  if (params.slot) qs.set('slot', params.slot);
  if (params.rarity) qs.set('rarity', params.rarity);
  if (params.class) qs.set('class', params.class);
  if (params.skip != null) qs.set('skip', String(params.skip));
  if (params.take != null) qs.set('take', String(params.take));
  const query = qs.toString();
  return apiFetch(`/api/v1/tokens${query ? `?${query}` : ''}`) as Promise<PagedResult<TokenSummary>>;
}

export async function getToken(idOrSlug: string): Promise<TokenDetail> {
  return apiFetch(`/api/v1/tokens/${encodeURIComponent(idOrSlug)}`) as Promise<TokenDetail>;
}

export async function advancedSearchTokens(filterJson: string, skip = 0, take = 50): Promise<PagedResult<TokenSummary>> {
  const qs = `?skip=${skip}&take=${take}`;
  return apiFetch(`/api/v1/tokens/search${qs}`, { method: 'POST', body: filterJson }) as Promise<PagedResult<TokenSummary>>;
}

export interface TokenBatchResult {
  items: TokenDetail[];
  notFound: string[];
}

export async function getTokensBatch(ids: string[]): Promise<TokenBatchResult> {
  return apiFetch('/api/v1/tokens/batch', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  }) as Promise<TokenBatchResult>;
}

export interface BonusSummary {
  id: string;
  name: string;
  tierCount: number;
  minTokens: number;
}

export interface TokenBonuses {
  sets: BonusSummary[];
  groups: BonusSummary[];
}

export async function getBonusesForToken(idOrSlug: string): Promise<TokenBonuses> {
  return apiFetch(`/api/v1/tokens/${encodeURIComponent(idOrSlug)}/bonuses`) as Promise<TokenBonuses>;
}

// ── Bonuses ───────────────────────────────────────────────────────────────────

export interface BonusTier {
  tokens: number;
  effects: { type: string; displayText: string }[];
}

export interface SetBonus {
  id: string;
  name: string;
  updated: string;
  tiers: BonusTier[];
}

export interface GroupBonus {
  id: string;
  name: string;
  updated: string;
  tiers: BonusTier[];
}

export async function listSetBonuses(skip = 0, take = 100): Promise<PagedResult<SetBonus>> {
  return apiFetch(`/api/v1/bonuses/sets?skip=${skip}&take=${take}`) as Promise<PagedResult<SetBonus>>;
}

export async function getSetBonus(id: string): Promise<SetBonus> {
  return apiFetch(`/api/v1/bonuses/sets/${encodeURIComponent(id)}`) as Promise<SetBonus>;
}

export async function listGroupBonuses(skip = 0, take = 100): Promise<PagedResult<GroupBonus>> {
  return apiFetch(`/api/v1/bonuses/groups?skip=${skip}&take=${take}`) as Promise<PagedResult<GroupBonus>>;
}

export async function getGroupBonus(id: string): Promise<GroupBonus> {
  return apiFetch(`/api/v1/bonuses/groups/${encodeURIComponent(id)}`) as Promise<GroupBonus>;
}

// ── Rulebook ──────────────────────────────────────────────────────────────────

export interface RulebookPageSummary {
  id: string;
  parentId?: string;
  path: string;
  title: string;
  updated: string;
}

export type RulebookFormat = 'html' | 'plaintext' | 'markdown';

export interface RulebookPage extends RulebookPageSummary {
  html: string;
  plaintext?: string;
  markdown?: string;
}

export interface RulebookSearchHit {
  id: string;
  parentId?: string;
  path: string;
  title: string;
  snippet: string;
  score: number;
}

// Rulebook index rarely changes — cache with a short TTL so repeated asks don't hammer the API.
const RULEBOOK_INDEX_TTL_MS = 5 * 60 * 1000;
let rulebookIndexCache: { expires: number; value: PagedResult<RulebookPageSummary> } | null = null;

export async function listRulebookPages(opts?: { forceRefresh?: boolean }): Promise<PagedResult<RulebookPageSummary>> {
  const now = Date.now();
  if (!opts?.forceRefresh && rulebookIndexCache && rulebookIndexCache.expires > now) {
    return rulebookIndexCache.value;
  }
  const value = await apiFetch('/api/v1/rulebook') as PagedResult<RulebookPageSummary>;
  rulebookIndexCache = { expires: now + RULEBOOK_INDEX_TTL_MS, value };
  return value;
}

export async function searchRulebook(q: string, skip = 0, take = 20): Promise<PagedResult<RulebookSearchHit>> {
  const qs = new URLSearchParams({ q, skip: String(skip), take: String(take) });
  return apiFetch(`/api/v1/rulebook/search?${qs}`) as Promise<PagedResult<RulebookSearchHit>>;
}

export async function getRulebookPage(idOrPath: string, format: RulebookFormat = 'markdown'): Promise<RulebookPage> {
  const qs = format === 'html' ? '' : `?format=${format}`;
  return apiFetch(`/api/v1/rulebook/${encodeURIComponent(idOrPath)}${qs}`) as Promise<RulebookPage>;
}

// ── Version ───────────────────────────────────────────────────────────────────

export interface ApiVersion {
  apiVersion: string;
  startedAt: string;
}

export async function getApiVersion(): Promise<ApiVersion> {
  return apiFetch('/api/v1/version') as Promise<ApiVersion>;
}
