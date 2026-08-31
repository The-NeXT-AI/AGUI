# AGUI Docs Site

This directory contains the Astro + Starlight documentation site for AGUI.

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
```

The site is bilingual:

- English content lives in `src/content/docs/`.
- Simplified Chinese content lives in `src/content/docs/zh-cn/`.

Every page exists in both languages; update both when a page changes. The former legacy `extensions.md`, `customization.md`, and `multi-agent-session.md` files in this directory were merged into the site guides and removed.
