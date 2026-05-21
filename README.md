# Migrate

Logseq plugin. Auto-migrate undone TODOs into today's journal on open. No manual trigger needed.

## Behavior

- Runs on plugin load, route change to a journal page, and graph switch.
- Runs at most once per local day (tracked via `lastMigratedDate` setting).
- Scans every journal page with `journal-day < today` for blocks whose marker matches the configured set.
- Moves those blocks under the bottom of today's journal.

## Settings

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master switch. |
| `filterMode` | `all` | `all` \| `exclude-tagged` \| `only-tagged`. |
| `filterTag` | `migrate` | Hashtag (no `#`) used by the tagged modes. Case-insensitive. |
| `moveStyle` | `move` | `move` cuts the block. `move-with-ref` inserts `((uuid))` where it was. |
| `markers` | `TODO,DOING,LATER,NOW` | Comma list. Filtered to valid Logseq markers. |

### Modes

- `all` — every undone TODO/DOING/LATER/NOW from past journals migrates.
- `exclude-tagged` — same, but blocks containing `#<filterTag>` stay put. Good for "this stays on its original day".
- `only-tagged` — only blocks containing `#<filterTag>` migrate. Conservative opt-in.

## Commands

- Slash: `/Migrate undone now` — force run, ignores per-day guard.
- Palette: `Migrate: run now` — same.

## Dev

```bash
npm install
npm run build     # outputs dist/
npm run dev       # watch mode
```

Load unpacked in Logseq: Settings → Advanced → Developer mode → Plugins → Load unpacked plugin → select this folder.

## Notes / limits

- Only top-level matched blocks are moved. Children move with their parent (Logseq `moveBlock` semantics).
- Today's journal page is created if missing.
- `move-with-ref` leaves the original block intact and adds a reference under today.
- Per-day guard uses local time. Cross-midnight: re-open Logseq or run the slash command.
