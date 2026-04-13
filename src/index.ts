#!/usr/bin/env node

/**
 * TDC MCP Server — exposes True Dungeon Companion game data (tokens, bonuses,
 * rulebook pages) as MCP tools so Claude can look up rules and token effects.
 *
 * Environment variables:
 *   TDC_API_BASE_URL  — API base URL (default: https://api.tdcompanion.app)
 *   TDC_API_KEY       — optional Bearer key for higher rate limits
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as api from './api.js';

const server = new McpServer({
  name: '@tdcompanion/mcp-server',
  version: '1.2.0',
});

// ── Shared helpers ────────────────────────────────────────────────────────────

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const safe = <A>(fn: (a: A) => Promise<ToolResult>) =>
  async (a: A): Promise<ToolResult> => {
    try {
      return await fn(a);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  };

const MAX_CHARS_DEFAULT = 20_000;
const MAX_CHARS_RULEBOOK = 12_000;

function clip(text: string, itemNoun = 'items', limit = MAX_CHARS_DEFAULT): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf('\n', limit);
  const boundary = cut > 0 ? cut : limit;
  const head = text.slice(0, boundary);
  const droppedLines = text.slice(boundary).split('\n').filter(l => l.trim()).length;
  return `${head}\n\n…${droppedLines} more ${itemNoun} truncated. Narrow your query (use \`take\`, more specific filters, or \`get_*\` tools for full detail).`;
}

// Fallback HTML stripper — only used when the server returns no pre-rendered plaintext/markdown.
function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/?\s*(p|div|section|article|header|footer|h[1-6]|tr|table|thead|tbody)\b[^>]*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\/\s*li\s*>/gi, '')
    .replace(/<\/?\s*[uo]l\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SLOT_VALUES = ['Head','Neck','Shoulders','Torso','Arms','Hands','Waist','Legs','Feet','Mainhand','Offhand','Ring','Ear','Eyes','Back','Bead','Charm','Ioun Stone'] as const;
const RARITY_VALUES = ['Common','Uncommon','Rare','UltraRare','Legendary','Relic','Transmuted'] as const;
const CLASS_VALUES = ['Fighter','Barbarian','Ranger','Rogue','Monk','Paladin','Cleric','Druid','Wizard','Warlock','Bard','Elf'] as const;

const Skip = z.number().int().min(0).optional().describe('Pagination offset (default 0)');
const Take = z.number().int().min(1).max(200).optional().describe('Page size, 1–200 (default 50)');

const csvOf = (allowed: readonly string[], label: string) =>
  z.string().optional().refine(
    v => !v || v.split(',').every(s => allowed.includes(s.trim())),
    { message: `Each ${label} value must be one of: ${allowed.join(', ')}` },
  );

// ── Structured FilterExpression schema ────────────────────────────────────────

const FILTER_TEXT_FIELDS = ['Name'] as const;
const FILTER_ENUM_FIELDS = ['Rarity', 'Slot', 'UsableBy', 'Tag'] as const;
const FILTER_NUMERIC_FIELDS = [
  'AbilitySTR', 'AbilityDEX', 'AbilityCON', 'AbilityWIS', 'AbilityINT', 'AbilityCHA',
  'StatAcMelee', 'StatAcRanged', 'StatHpMax',
  'StatAttackMelee', 'StatAttackRanged', 'StatAttackSpell',
  'StatSaveFort', 'StatSaveReflex', 'StatSaveWill',
  'DamageMelee1H', 'DamageMelee2H', 'DamageRanged', 'DamageSpell', 'DamageResist',
] as const;

const TEXT_OPS = ['Contains', 'NotContains'] as const;
const ENUM_OPS = ['ContainsAnyOf', 'NotContainsAnyOf'] as const;
const NUM_OPS = ['EqualTo', 'NotEqualTo', 'GreaterThan', 'GreaterThanOrEqual', 'LessThan', 'LessThanOrEqual'] as const;

const FilterValueSchema = z.object({
  Text: z.string().optional(),
  Items: z.array(z.string()).optional(),
  Number: z.number().optional(),
}).describe('Value container — populate exactly one of Text, Items, or Number based on field type.');

// Recursive schema: condition leaves + nested group branches. z.lazy wraps the recursion.
type FilterConditionInput = {
  $type: 'condition';
  Field: string;
  Operator: string;
  Value: { Text?: string; Items?: string[]; Number?: number };
};
type FilterGroupInput = {
  $type: 'group';
  Logic: 'And' | 'Or';
  Children: FilterExpressionInput[];
};
type FilterExpressionInput = FilterConditionInput | FilterGroupInput;

const FilterConditionSchema: z.ZodType<FilterConditionInput> = z.object({
  $type: z.literal('condition'),
  Field: z.enum([...FILTER_TEXT_FIELDS, ...FILTER_ENUM_FIELDS, ...FILTER_NUMERIC_FIELDS]),
  Operator: z.enum([...TEXT_OPS, ...ENUM_OPS, ...NUM_OPS]),
  Value: FilterValueSchema,
});

const FilterGroupSchema: z.ZodType<FilterGroupInput> = z.lazy(() => z.object({
  $type: z.literal('group'),
  Logic: z.enum(['And', 'Or']),
  Children: z.array(FilterExpressionSchema).min(1),
}));

const FilterExpressionSchema: z.ZodType<FilterExpressionInput> = z.lazy(() =>
  z.union([FilterConditionSchema, FilterGroupSchema])
);

function validateFilterSemantics(node: FilterExpressionInput, path = '$'): void {
  if (node.$type === 'group') {
    node.Children.forEach((c, i) => validateFilterSemantics(c, `${path}.Children[${i}]`));
    return;
  }
  const isText = (FILTER_TEXT_FIELDS as readonly string[]).includes(node.Field);
  const isEnum = (FILTER_ENUM_FIELDS as readonly string[]).includes(node.Field);
  const isNum = (FILTER_NUMERIC_FIELDS as readonly string[]).includes(node.Field);

  if (isText && !(TEXT_OPS as readonly string[]).includes(node.Operator))
    throw new Error(`${path}: text field "${node.Field}" requires Operator in ${TEXT_OPS.join('|')}, got "${node.Operator}"`);
  if (isEnum && !(ENUM_OPS as readonly string[]).includes(node.Operator))
    throw new Error(`${path}: enum field "${node.Field}" requires Operator in ${ENUM_OPS.join('|')}, got "${node.Operator}"`);
  if (isNum && !(NUM_OPS as readonly string[]).includes(node.Operator))
    throw new Error(`${path}: numeric field "${node.Field}" requires Operator in ${NUM_OPS.join('|')}, got "${node.Operator}"`);

  if (isText && typeof node.Value.Text !== 'string')
    throw new Error(`${path}: text field "${node.Field}" requires Value.Text (string)`);
  if (isEnum && (!Array.isArray(node.Value.Items) || node.Value.Items.length === 0))
    throw new Error(`${path}: enum field "${node.Field}" requires Value.Items (non-empty string[])`);
  if (isNum && typeof node.Value.Number !== 'number')
    throw new Error(`${path}: numeric field "${node.Field}" requires Value.Number`);
}

// ── Formatters ────────────────────────────────────────────────────────────────

const formatTokenSummary = (t: api.TokenSummary) =>
  `**${t.name}** (${t.rarity}) — ${t.tokenText || 'No effect text'}${t.slug ? ` [slug: ${t.slug}]` : ''}`;

const formatBonusTiers = (b: { tiers: api.BonusTier[] }) =>
  b.tiers.map(t =>
    `  ${t.tokens} tokens: ${t.effects.map(e => e.displayText).join('; ') || '(none)'}`
  ).join('\n');

const formatBonus = (b: api.SetBonus | api.GroupBonus) =>
  `**${b.name}** (${b.id})\n${formatBonusTiers(b)}`;

const formatTokenDetail = (t: api.TokenDetail): string => {
  const effects = t.effects?.length
    ? t.effects.map(e => `  - [${e.type}] ${e.displayText}`).join('\n')
    : '  (none)';
  const lines: (string | null)[] = [
    `# ${t.name}`,
    `**Rarity:** ${t.rarity}`,
    t.slots?.length ? `**Slots:** ${t.slots.join(', ')}` : null,
    t.usableBy?.length ? `**Usable By:** ${t.usableBy.join(', ')}` : null,
    t.handedness ? `**Handedness:** ${t.handedness}` : null,
    t.weaponAttackMode && t.weaponAttackMode !== 'None' ? `**Attack Mode:** ${t.weaponAttackMode}` : null,
    t.damageWheel?.length ? `**Damage Wheel:** ${t.damageWheel.join(', ')}` : null,
    t.years?.length ? `**Years:** ${t.years.join(', ')}` : null,
    t.tags?.length ? `**Tags:** ${t.tags.join(', ')}` : null,
    `\n**Token Text:** ${t.tokenText || '_(no in-game text)_'}`,
    `\n**Effects:**\n${effects}`,
    t.description ? `\n**Description:**\n${t.description}` : null,
  ];
  return lines.filter(Boolean).join('\n');
};

// ── Token tools ───────────────────────────────────────────────────────────────

server.tool(
  'search_tokens',
  'Search True Dungeon tokens by name, equipment slot, rarity, or usable class. Returns a paginated list of matching tokens with name, rarity, and effect summary.',
  {
    q: z.string().optional().describe('Name search (substring match)'),
    slot: csvOf(SLOT_VALUES, 'slot').describe('Comma-separated slot names: Head, Neck, Shoulders, Torso, Arms, Hands, Waist, Legs, Feet, Mainhand, Offhand, Ring, Ear, Eyes, Back, Bead, Charm, Ioun Stone'),
    rarity: csvOf(RARITY_VALUES, 'rarity').describe('Comma-separated rarities: Common, Uncommon, Rare, UltraRare, Legendary, Relic, Transmuted'),
    class: csvOf(CLASS_VALUES, 'class').describe('Comma-separated classes: Fighter, Barbarian, Ranger, Rogue, Monk, Paladin, Cleric, Druid, Wizard, Warlock, Bard, Elf'),
    skip: Skip,
    take: Take,
  },
  safe(async (params: { q?: string; slot?: string; rarity?: string; class?: string; skip?: number; take?: number }) => {
    const result = await api.searchTokens(params);
    const summary = result.items.map(formatTokenSummary).join('\n');
    const text = clip(
      `Found ${result.total} tokens (showing ${result.skip + 1}–${result.skip + result.items.length}):\n\n${summary}`,
      'tokens',
    );
    return { content: [{ type: 'text', text }] };
  }),
);

server.tool(
  'get_token',
  'Get full details for a single True Dungeon token by its slug or ID. Returns all fields including effects, slots, classes, damage wheel, and description.',
  {
    id_or_slug: z.string().describe('Token slug (e.g. "charm-of-avarice") or database ID'),
  },
  safe(async ({ id_or_slug }: { id_or_slug: string }) => {
    const t = await api.getToken(id_or_slug);
    return { content: [{ type: 'text', text: formatTokenDetail(t) }] };
  }),
);

server.tool(
  'get_tokens_batch',
  'Fetch full details for many True Dungeon tokens in a single call (up to 100). Accepts a mix of slugs and IDs. Unresolved entries are reported in the output.',
  {
    ids: z.array(z.string()).min(1).max(100).describe('Token slugs or IDs to fetch (1–100).'),
  },
  safe(async ({ ids }: { ids: string[] }) => {
    const result = await api.getTokensBatch(ids);
    const body = result.items.map(formatTokenDetail).join('\n\n---\n\n');
    const footer = result.notFound.length
      ? `\n\n_Not found (${result.notFound.length}): ${result.notFound.join(', ')}_`
      : '';
    const text = clip(`${result.items.length} of ${ids.length} tokens resolved:\n\n${body}${footer}`, 'tokens');
    return { content: [{ type: 'text', text }] };
  }),
);

server.tool(
  'get_bonuses_for_token',
  'List the set and group bonuses a True Dungeon token participates in. Use this instead of scanning all bonuses when you need token→bonus lookup.',
  {
    id_or_slug: z.string().describe('Token slug or database ID'),
  },
  safe(async ({ id_or_slug }: { id_or_slug: string }) => {
    const b = await api.getBonusesForToken(id_or_slug);
    const fmt = (s: api.BonusSummary) =>
      `- **${s.name}** (id: ${s.id}) — ${s.tierCount} tier${s.tierCount === 1 ? '' : 's'}, starts at ${s.minTokens} tokens`;
    const sets = b.sets.length ? b.sets.map(fmt).join('\n') : '  (none)';
    const groups = b.groups.length ? b.groups.map(fmt).join('\n') : '  (none)';
    return {
      content: [{
        type: 'text',
        text: `## Set bonuses\n${sets}\n\n## Group bonuses\n${groups}\n\n_Use get_set_bonus / get_group_bonus with the id to see full tier effects._`,
      }],
    };
  }),
);

server.tool(
  'advanced_search_tokens',
  `Advanced token search using a structured FilterExpression. Build arbitrary AND/OR filter trees across all filterable token fields.

Two node types:

**Condition (leaf):** { "$type": "condition", "Field": "<FieldId>", "Operator": "<Op>", "Value": { ... } }
**Group (branch):** { "$type": "group", "Logic": "And"|"Or", "Children": [ ...conditions or groups... ] }

**Fields by value type:**
- Text (use Operator: Contains | NotContains; Value: { "Text": "..." }): Name
- Multi-enum (use Operator: ContainsAnyOf | NotContainsAnyOf; Value: { "Items": [...] }): Rarity, Slot, UsableBy, Tag
- Numeric (use Operator: EqualTo | NotEqualTo | GreaterThan | GreaterThanOrEqual | LessThan | LessThanOrEqual; Value: { "Number": N }):
  AbilitySTR, AbilityDEX, AbilityCON, AbilityWIS, AbilityINT, AbilityCHA,
  StatAcMelee, StatAcRanged, StatHpMax,
  StatAttackMelee, StatAttackRanged, StatAttackSpell,
  StatSaveFort, StatSaveReflex, StatSaveWill,
  DamageMelee1H, DamageMelee2H, DamageRanged, DamageSpell, DamageResist.

**Enum value vocabularies:**
- Rarity: Common, Uncommon, Rare, UltraRare, Legendary, Relic, Transmuted
- Slot: Head, Neck, Shoulders, Torso, Arms, Hands, Waist, Legs, Feet, Mainhand, Offhand, Ring, Ear, Eyes, Back, Bead, Charm, IounStone
- UsableBy (class): Fighter, Barbarian, Ranger, Rogue, Monk, Paladin, Cleric, Druid, Wizard, Warlock, Bard, Elf

**Example — Rare+ Cleric tokens with +2 or better Will save:**
{
  "$type": "group", "Logic": "And", "Children": [
    { "$type": "condition", "Field": "Rarity", "Operator": "ContainsAnyOf", "Value": { "Items": ["Rare","UltraRare","Legendary","Relic"] } },
    { "$type": "condition", "Field": "UsableBy", "Operator": "ContainsAnyOf", "Value": { "Items": ["Cleric"] } },
    { "$type": "condition", "Field": "StatSaveWill", "Operator": "GreaterThanOrEqual", "Value": { "Number": 2 } }
  ]
}`,
  {
    filter: FilterExpressionSchema.describe('FilterExpression tree (condition or group at root).'),
    skip: Skip,
    take: Take,
  },
  safe(async ({ filter, skip, take }: { filter: FilterExpressionInput; skip?: number; take?: number }) => {
    validateFilterSemantics(filter);
    const result = await api.advancedSearchTokens(JSON.stringify(filter), skip, take);
    const summary = result.items.map(formatTokenSummary).join('\n');
    const text = clip(
      `Found ${result.total} tokens (showing ${result.skip + 1}–${result.skip + result.items.length}):\n\n${summary}`,
      'tokens',
    );
    return { content: [{ type: 'text', text }] };
  }),
);

// ── Bonus tools ───────────────────────────────────────────────────────────────

server.tool(
  'list_set_bonuses',
  'List all True Dungeon set bonuses with their tier effects. Set bonuses grant effects when a player equips multiple tokens from the same set.',
  { skip: Skip, take: Take },
  safe(async ({ skip, take }: { skip?: number; take?: number }) => {
    const result = await api.listSetBonuses(skip, take);
    const text = clip(
      `${result.total} set bonuses:\n\n${result.items.map(formatBonus).join('\n\n')}`,
      'set bonuses',
    );
    return { content: [{ type: 'text', text }] };
  }),
);

server.tool(
  'get_set_bonus',
  'Get a single True Dungeon set bonus by its id, with all tier effects.',
  { id: z.string().describe('Set bonus id (from list_set_bonuses or get_bonuses_for_token)') },
  safe(async ({ id }: { id: string }) => {
    const b = await api.getSetBonus(id);
    return { content: [{ type: 'text', text: formatBonus(b) }] };
  }),
);

server.tool(
  'list_group_bonuses',
  'List all True Dungeon group bonuses with their tier effects. Group bonuses grant effects when multiple party members equip qualifying tokens.',
  { skip: Skip, take: Take },
  safe(async ({ skip, take }: { skip?: number; take?: number }) => {
    const result = await api.listGroupBonuses(skip, take);
    const text = clip(
      `${result.total} group bonuses:\n\n${result.items.map(formatBonus).join('\n\n')}`,
      'group bonuses',
    );
    return { content: [{ type: 'text', text }] };
  }),
);

server.tool(
  'get_group_bonus',
  'Get a single True Dungeon group bonus by its id, with all tier effects.',
  { id: z.string().describe('Group bonus id (from list_group_bonuses or get_bonuses_for_token)') },
  safe(async ({ id }: { id: string }) => {
    const b = await api.getGroupBonus(id);
    return { content: [{ type: 'text', text: formatBonus(b) }] };
  }),
);

// ── Rulebook tools ────────────────────────────────────────────────────────────

server.tool(
  'search_rulebook',
  'Full-text search the True Dungeon rulebook. Ranked hits include the page path — pass that path to get_rulebook_page to read the content. Prefer this over list_rulebook_pages for rule questions.',
  {
    q: z.string().min(2).describe('Search text (min 2 chars). Matched against titles and body content.'),
    skip: z.number().int().min(0).optional().describe('Pagination offset (default 0)'),
    take: z.number().int().min(1).max(100).optional().describe('Page size, 1–100 (default 20)'),
  },
  safe(async ({ q, skip, take }: { q: string; skip?: number; take?: number }) => {
    const result = await api.searchRulebook(q, skip, take);
    if (result.total === 0) {
      return { content: [{ type: 'text', text: `No rulebook hits for "${q}".` }] };
    }
    const lines = result.items.map(h => {
      const snippet = h.snippet ? `\n  > ${h.snippet}` : '';
      return `- **${h.title}** (path: ${h.path}, score: ${h.score})${snippet}`;
    }).join('\n');
    const text = clip(
      `Found ${result.total} rulebook pages matching "${q}" (showing ${result.skip + 1}–${result.skip + result.items.length}):\n\n${lines}\n\n_Use get_rulebook_page with the path to fetch full content._`,
      'hits',
      MAX_CHARS_RULEBOOK,
    );
    return { content: [{ type: 'text', text }] };
  }),
);

server.tool(
  'list_rulebook_pages',
  'List all True Dungeon rulebook pages (title, path). Prefer search_rulebook when looking up a specific rule — this is mainly for navigation/index builds. Results are cached for 5 minutes.',
  {},
  safe(async () => {
    const result = await api.listRulebookPages();
    const lines = result.items.map(p =>
      `- **${p.title}** (path: ${p.path})`
    ).join('\n');
    const text = clip(`${result.total} rulebook pages:\n\n${lines}`, 'pages', MAX_CHARS_RULEBOOK);
    return { content: [{ type: 'text', text }] };
  }),
);

server.tool(
  'get_rulebook_page',
  'Get the full content of a True Dungeon rulebook page by its path (preferred) or ID. Defaults to markdown for clean LLM reading.',
  {
    id_or_path: z.string().describe('Page path (e.g. "combat/melee-attacks") or database ID. Paths come from search_rulebook or list_rulebook_pages.'),
    format: z.enum(['markdown', 'plaintext', 'html']).optional().describe('Body format. Defaults to markdown.'),
  },
  safe(async ({ id_or_path, format }: { id_or_path: string; format?: 'markdown' | 'plaintext' | 'html' }) => {
    const fmt = format ?? 'markdown';
    const page = await api.getRulebookPage(id_or_path, fmt);
    let body: string;
    if (fmt === 'markdown' && page.markdown) body = page.markdown;
    else if ((fmt === 'plaintext' || fmt === 'markdown') && page.plaintext) body = page.plaintext;
    else body = stripHtml(page.html);
    const text = clip(`# ${page.title}\n\nPath: ${page.path}\n\n${body}`, 'lines', MAX_CHARS_RULEBOOK);
    return { content: [{ type: 'text', text }] };
  }),
);

// ── Version tool ──────────────────────────────────────────────────────────────

server.tool(
  'get_api_version',
  'Get the running TDC API build version and process start time. Useful for confirming MCP ↔ API connectivity and gating on server version.',
  {},
  safe(async () => {
    const v = await api.getApiVersion();
    return { content: [{ type: 'text', text: `TDC API ${v.apiVersion} (started ${v.startedAt})` }] };
  }),
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
