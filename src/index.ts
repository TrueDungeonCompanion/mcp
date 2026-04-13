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
  version: '1.1.0',
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

const MAX_CHARS = 20_000;

function clip(text: string, itemNoun = 'items'): string {
  if (text.length <= MAX_CHARS) return text;
  const cut = text.lastIndexOf('\n', MAX_CHARS);
  const boundary = cut > 0 ? cut : MAX_CHARS;
  const head = text.slice(0, boundary);
  const droppedLines = text.slice(boundary).split('\n').filter(l => l.trim()).length;
  return `${head}\n\n…${droppedLines} more ${itemNoun} truncated. Narrow your query (use \`take\`, more specific filters, or \`get_*\` tools for full detail).`;
}

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

// ── Formatters ────────────────────────────────────────────────────────────────

const formatTokenSummary = (t: api.TokenSummary) =>
  `**${t.name}** (${t.rarity}) — ${t.tokenText || 'No effect text'}${t.slug ? ` [slug: ${t.slug}]` : ''}`;

const formatBonusTiers = (b: { tiers: api.BonusTier[] }) =>
  b.tiers.map(t =>
    `  ${t.tokens} tokens: ${t.effects.map(e => e.displayText).join('; ') || '(none)'}`
  ).join('\n');

const formatBonus = (b: api.SetBonus | api.GroupBonus) =>
  `**${b.name}** (${b.id})\n${formatBonusTiers(b)}`;

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
    return { content: [{ type: 'text', text: lines.filter(Boolean).join('\n') }] };
  }),
);

server.tool(
  'advanced_search_tokens',
  `Advanced token search using a FilterExpression JSON body. Build arbitrary AND/OR filter trees across all filterable fields.

The body is a polymorphic JSON tree with two node types:

**Condition (leaf):**
{ "$type": "condition", "Field": "<FieldId>", "Operator": "<Op>", "Value": { "Text": "..." } }
{ "$type": "condition", "Field": "<FieldId>", "Operator": "<Op>", "Value": { "Number": 2 } }
{ "$type": "condition", "Field": "<FieldId>", "Operator": "<Op>", "Value": { "Items": ["Rare","UltraRare"] } }

**Group (branch):**
{ "$type": "group", "Logic": "And"|"Or", "Children": [ ...conditions or groups... ] }

**Fields (FilterFieldId):**
Text fields (use Contains/NotContains + Value.Text): Name
Multi-enum fields (use ContainsAnyOf/NotContainsAnyOf + Value.Items): Rarity, Slot, UsableBy, Tag
Numeric fields (use GreaterThan/GreaterThanOrEqual/LessThan/LessThanOrEqual/EqualTo/NotEqualTo + Value.Number):
  Abilities: AbilitySTR, AbilityDEX, AbilityCON, AbilityWIS, AbilityINT, AbilityCHA
  Stats: StatAcMelee, StatAcRanged, StatHpMax, StatAttackMelee, StatAttackRanged, StatAttackSpell, StatSaveFort, StatSaveReflex, StatSaveWill
  Damage: DamageMelee1H, DamageMelee2H, DamageRanged, DamageSpell, DamageResist

**Rarity values:** Common, Uncommon, Rare, UltraRare, Legendary, Relic, Transmuted
**Slot values:** Head, Neck, Shoulders, Torso, Arms, Hands, Waist, Legs, Feet, Mainhand, Offhand, Ring, Ear, Eyes, Back, Bead, Charm, IounStone
**Class values:** Fighter, Barbarian, Ranger, Rogue, Monk, Paladin, Cleric, Druid, Wizard, Warlock, Bard, Elf

**Example — find Rare+ tokens usable by Cleric with +2 or more Will save:**
{
  "$type": "group", "Logic": "And", "Children": [
    { "$type": "condition", "Field": "Rarity", "Operator": "ContainsAnyOf", "Value": { "Items": ["Rare","UltraRare","Legendary","Relic"] } },
    { "$type": "condition", "Field": "UsableBy", "Operator": "ContainsAnyOf", "Value": { "Items": ["Cleric"] } },
    { "$type": "condition", "Field": "StatSaveWill", "Operator": "GreaterThanOrEqual", "Value": { "Number": 2 } }
  ]
}`,
  {
    filter: z.string().describe('FilterExpression JSON (see tool description for schema)'),
    skip: Skip,
    take: Take,
  },
  safe(async ({ filter, skip, take }: { filter: string; skip?: number; take?: number }) => {
    let parsed: any;
    try {
      parsed = JSON.parse(filter);
    } catch (e: any) {
      throw new Error(`filter is not valid JSON: ${e?.message ?? e}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('filter must be a JSON object (a FilterExpression group or condition)');
    }
    if (parsed.$type !== 'group' && parsed.$type !== 'condition') {
      throw new Error('filter root must have "$type" of "group" or "condition"');
    }
    const result = await api.advancedSearchTokens(filter, skip, take);
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
  { id: z.string().describe('Set bonus id (from list_set_bonuses)') },
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
  { id: z.string().describe('Group bonus id (from list_group_bonuses)') },
  safe(async ({ id }: { id: string }) => {
    const b = await api.getGroupBonus(id);
    return { content: [{ type: 'text', text: formatBonus(b) }] };
  }),
);

// ── Rulebook tools ────────────────────────────────────────────────────────────

server.tool(
  'list_rulebook_pages',
  'List all True Dungeon rulebook pages (id, title, path). Use this to find the right page before fetching its content.',
  {},
  safe(async () => {
    const result = await api.listRulebookPages();
    const lines = result.items.map(p =>
      `- **${p.title}** (path: ${p.path}, id: ${p.id})`
    ).join('\n');
    const text = clip(`${result.total} rulebook pages:\n\n${lines}`, 'pages');
    return { content: [{ type: 'text', text }] };
  }),
);

server.tool(
  'get_rulebook_page',
  'Get the full content of a True Dungeon rulebook page by its ID or path. Returns the page title and plain-text body.',
  {
    id_or_path: z.string().describe('Page ID or path (e.g. "combat/melee-attacks")'),
  },
  safe(async ({ id_or_path }: { id_or_path: string }) => {
    const page = await api.getRulebookPage(id_or_path);
    const body = stripHtml(page.html);
    return { content: [{ type: 'text', text: `# ${page.title}\n\nPath: ${page.path}\n\n${body}` }] };
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
