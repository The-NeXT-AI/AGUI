# RSS Reader

Subscribe to RSS feeds and preview new articles from the session tree.

The extension contributes:

- A configuration view for RSS or Atom feed URLs.
- A dynamic session tree root that groups recent articles by source.
- Paged loading under each feed, controlled by the configured item count.
- A chat renderer that previews the selected article in the main conversation area.
- Linked article fetching for feeds that only provide short summaries or comment links.

## Development

```bash
pnpm --dir extensions/rss-reader build
node scripts/package-extension.mjs extensions/rss-reader
```

## Structure

- `src/extension.ts` registers backend commands and session tree data.
- `src/ui/configuration.tsx` renders the feed configuration form.
- `src/ui/item-renderer.tsx` renders article metadata above the Markdown preview.
- `scripts/build-ui.js` compiles React surfaces into self-contained HTML files under `dist/`.

This extension was generated without MCP support. Recreate it with `--with-mcp` if the agent needs private tool access through MCP Gateway.
