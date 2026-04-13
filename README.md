# TDC MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes True Dungeon Companion game data — tokens, set/group bonuses, and rulebook pages — as tools for Claude and other MCP clients.

## Tools

| Tool | Description |
|------|-------------|
| `search_tokens` | Search tokens by name, slot, rarity, or class |
| `advanced_search_tokens` | Build arbitrary AND/OR filter trees across 29 fields (abilities, stats, damage, etc.) |
| `get_token` | Get full detail for a single token (effects, slots, damage wheel, etc.) |
| `list_set_bonuses` | List all set bonuses with tier effects |
| `list_group_bonuses` | List all group bonuses with tier effects |
| `list_rulebook_pages` | List all rulebook pages (title + path) |
| `get_rulebook_page` | Get the full text content of a rulebook page |

## Quick start (npx)

No install or build needed. Add to your `.claude/settings.json`:

```json
{
  "mcpServers": {
    "tdc": {
      "command": "npx",
      "args": ["@tdcompanion/mcp-server"],
      "env": {
        "TDC_API_KEY": "tdc_live_<your-key>"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TDC_API_BASE_URL` | `https://api.tdcompanion.app` | API base URL (must point at the API host, not the web app) |
| `TDC_API_KEY` | _(none)_ | Optional bearer key for higher rate limits (600 req/min vs 60) |

The server works without an API key (anonymous access), but authenticated keys get 10x the rate limit. Generate one from your profile's Developer tab at https://tdcompanion.app/profile.

## Development

```bash
cd src/MCP/@tdcompanion/mcp-server
npm install
npm run build     # compile TypeScript → dist/
npm start         # run locally via stdio
```

## Publishing

```bash
npm run build
npm publish
```

The `prepublishOnly` script runs the build automatically. The `files` field in package.json ensures only `dist/` is included in the published package.
