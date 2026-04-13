#!/usr/bin/env node

/**
 * TDC MCP Server — exposes True Dungeon Companion game data (tokens, bonuses,
 * rulebook pages) as MCP tools so Claude can look up rules and token effects.
 *
 * Environment variables:
 *   TDC_API_BASE_URL  — API base URL (default: https://tdcompanion.app)
 *   TDC_API_KEY       — optional Bearer key for higher rate limits
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as api from './api.js';

const server = new McpServer({
  name: '@tdcompanion/mcp-server',
  version: '1.0.0',
});

// ── Token tools ───────────────────────────────────────────────────────────────

server.tool(
  'search_tokens',
  'Search True Dungeon tokens by name, equipment slot, rarity, or usable class. Returns a paginated list of matching tokens with name, rarity, and effect summary.',
  {
    q: z.string().optional().describe('Name search (substring match)'),
    slot: z.string().optional().describe('Comma-separated slot names: Head, Neck, Shoulders, Torso, Arms, Hands, Waist, Legs, Feet, Mainhand, Offhand, Ring, Ear, Eyes, Back, Bead, Charm, Ioun Stone'),
    rarity: z.string().optional().describe('Comma-separated rarities: Common, Uncommon, Rare, UltraRare, Legendary, Relic, Transmuted'),
    class: z.string().optional().describe('Comma-separated classes: Fighter, Barbarian, Ranger, Rogue, Monk, Paladin, Cleric, Druid, Wizard, Warlock, Bard, Elf'),
    skip: z.number().optional().describe('Pagination offset (default 0)'),
    take: z.number().optional().describe('Page size, max 200 (default 50)'),
  },
  async (params) => {
    const result = await api.searchTokens(params);
    const summary = result.items.map(t =>
      `**${t.name}** (${t.rarity}) — ${t.tokenText || 'No effect text'}${t.slug ? ` [slug: ${t.slug}]` : ''}`
    ).join('\n');
    return {
      content: [{
        type: 'text' as const,
        text: `Found ${result.total} tokens (showing ${result.skip + 1}–${result.skip + result.items.length}):\n\n${summary}`,
      }],
    };
  },
);

server.tool(
  'get_token',
  'Get full details for a single True Dungeon token by its slug or ID. Returns all fields including effects, slots, classes, damage wheel, and description.',
  {
    id_or_slug: z.string().describe('Token slug (e.g. "charm-of-avarice") or database ID'),
  },
  async ({ id_or_slug }) => {
    const t = await api.getToken(id_or_slug);
    const effects = t.effects?.map(e => `  - [${e.type}] ${e.displayText}`).join('\n') || '  (none)';
    const text = [
      `# ${t.name}`,
      `**Rarity:** ${t.rarity}`,
      `**Slots:** ${t.slots?.join(', ') || '—'}`,
      `**Usable By:** ${t.usableBy?.join(', ') || '—'}`,
      t.handedness ? `**Handedness:** ${t.handedness}` : null,
      t.weaponAttackMode && t.weaponAttackMode !== 'None' ? `**Attack Mode:** ${t.weaponAttackMode}` : null,
      t.damageWheel?.length ? `**Damage Wheel:** ${t.damageWheel.join(', ')}` : null,
      `**Years:** ${t.years?.join(', ') || '—'}`,
      t.tags?.length ? `**Tags:** ${t.tags.join(', ')}` : null,
      `\n**Token Text:** ${t.tokenText || '—'}`,
      `\n**Effects:**\n${effects}`,
      t.description ? `\n**Description:**\n${t.description}` : null,
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text' as const, text }] };
  },
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
    skip: z.number().optional().describe('Pagination offset (default 0)'),
    take: z.number().optional().describe('Page size, max 200 (default 50)'),
  },
  async ({ filter, skip, take }) => {
    const result = await api.advancedSearchTokens(filter, skip, take);
    const summary = result.items.map(t =>
      `**${t.name}** (${t.rarity}) — ${t.tokenText || 'No effect text'}${t.slug ? ` [slug: ${t.slug}]` : ''}`
    ).join('\n');
    return {
      content: [{
        type: 'text' as const,
        text: `Found ${result.total} tokens (showing ${result.skip + 1}–${result.skip + result.items.length}):\n\n${summary}`,
      }],
    };
  },
);

// ── Bonus tools ───────────────────────────────────────────────────────────────

server.tool(
  'list_set_bonuses',
  'List all True Dungeon set bonuses with their tier effects. Set bonuses grant effects when a player equips multiple tokens from the same set.',
  {
    skip: z.number().optional().describe('Pagination offset'),
    take: z.number().optional().describe('Page size (default 100)'),
  },
  async ({ skip, take }) => {
    const result = await api.listSetBonuses(skip, take);
    const lines = result.items.map(b => {
      const tiers = b.tiers.map(t =>
        `  ${t.tokens} tokens: ${t.effects.map(e => e.displayText).join('; ') || '(none)'}`
      ).join('\n');
      return `**${b.name}** (${b.id})\n${tiers}`;
    });
    return {
      content: [{ type: 'text' as const, text: `${result.total} set bonuses:\n\n${lines.join('\n\n')}` }],
    };
  },
);

server.tool(
  'list_group_bonuses',
  'List all True Dungeon group bonuses with their tier effects. Group bonuses grant effects when multiple party members equip qualifying tokens.',
  {
    skip: z.number().optional().describe('Pagination offset'),
    take: z.number().optional().describe('Page size (default 100)'),
  },
  async ({ skip, take }) => {
    const result = await api.listGroupBonuses(skip, take);
    const lines = result.items.map(b => {
      const tiers = b.tiers.map(t =>
        `  ${t.tokens} tokens: ${t.effects.map(e => e.displayText).join('; ') || '(none)'}`
      ).join('\n');
      return `**${b.name}** (${b.id})\n${tiers}`;
    });
    return {
      content: [{ type: 'text' as const, text: `${result.total} group bonuses:\n\n${lines.join('\n\n')}` }],
    };
  },
);

// ── Rulebook tools ────────────────────────────────────────────────────────────

server.tool(
  'list_rulebook_pages',
  'List all True Dungeon rulebook pages (id, title, path). Use this to find the right page before fetching its content.',
  {},
  async () => {
    const result = await api.listRulebookPages();
    const lines = result.items.map(p =>
      `- **${p.title}** (path: ${p.path}, id: ${p.id})`
    ).join('\n');
    return {
      content: [{ type: 'text' as const, text: `${result.total} rulebook pages:\n\n${lines}` }],
    };
  },
);

server.tool(
  'get_rulebook_page',
  'Get the full content of a True Dungeon rulebook page by its ID or path. Returns the page title and HTML body.',
  {
    id_or_path: z.string().describe('Page ID or path (e.g. "combat/melee-attacks")'),
  },
  async ({ id_or_path }) => {
    const page = await api.getRulebookPage(id_or_path);
    // Strip HTML tags for a cleaner text representation
    const plainText = page.html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|h[1-6]|li|tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      content: [{
        type: 'text' as const,
        text: `# ${page.title}\n\nPath: ${page.path}\n\n${plainText}`,
      }],
    };
  },
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
