# optimize-assets

Shrink a folder of images **in place**. It resizes oversized PNG/JPG and
re-encodes them **keeping the same filename**, so every `<img src>` and
`/assets/...` URL stays identical — only the bytes get smaller. Works as a
Claude Code / AI-agent skill and as a plain CLI. One dependency: `sharp`.

- **Same files, same URLs** — no rewiring to `next/image` or a CDN loader.
- **Idempotent** — a content-hash manifest makes re-runs a no-op; only new or
  changed files are reprocessed.
- **Never enlarges** a file — writes only when the result is smaller.
- **Safe anywhere** — never descends into `node_modules`, build output, or
  version-control folders.
- **Reports a before → after total** at the end of every run.
- **Fails loudly** with a clear message on a missing dependency or a bad flag —
  never a stack trace.

---

## Install

Requires Node 18+ and one dependency (`sharp`) in the project whose assets you
optimize:

```bash
npm i -D sharp      # or: pnpm add -D sharp  /  yarn add -D sharp
```

**As a Claude Code plugin** (recommended — auto-updates):

```
/plugin marketplace add pedrovelasquez9/optimize-assets
/plugin install optimize-assets@programacion-es
```

**By hand:** copy `skills/optimize-assets/` into your project's
`.claude/skills/`. As a plain CLI it can live anywhere.

---

## Use it as a skill

Ask the agent in natural language — no command to remember:

> "optimize the assets in `public/assets`"
> "las imágenes de `public/images` pesan mucho, comprímelas"
> "shrink the images under `assets/`, preview first"

The agent previews with `--dry-run`, confirms with you (these are usually a
designer's assets — fidelity matters), runs the optimization in place, and
reports the before → after total. Installed as a plugin, invoke it explicitly
with `/optimize-assets:optimize-assets`.

---

## Use it as a CLI

```bash
# 1. Preview — writes nothing, prints projected savings
node optimize-assets.mjs public/assets --dry-run

# 2. Optimize in place (conservative defaults: cap 1600px, quality 82)
node optimize-assets.mjs public/assets
```

Each run ends with a before → after weight summary:

```
shrank 12 asset(s):  24.8MB → 9.1MB  (−63%, saved 15.7MB)
```

### Options

| flag | default | meaning |
|---|---|---|
| `directory` | current dir | target directory (recursive) |
| `--max <pixels>` | `1600` | cap the longest side, keep aspect ratio (`0` = no resize) |
| `--quality <number>` | `82` | encode quality 1–100 |
| `--ext <list>` | `png,jpg,jpeg` | comma-separated extensions to process |
| `--ignore <list>` | — | extra directory names to skip (added to the built-in list) |
| `--min-kb <number>` | `8` | skip files smaller than this many kilobytes |
| `--no-palette` | off | PNG: skip palette quantization (larger, max fidelity — use if you see banding) |
| `--webp` | off | **also** write a sibling `<name>.webp` (does not replace the source) |
| `--manifest <path>` | `<dir>/../.optimize-assets.json` | idempotence ledger |
| `--concurrency <n>` | `8` | number of parallel workers |
| `--force` | off | reprocess everything (ignore the manifest) |
| `--dry-run` | off | report only, write nothing |
| `--self-test` | — | run the built-in correctness check and exit |
| `-h`, `--help` | — | show help |

### Examples

```bash
# Preview a public assets folder
node optimize-assets.mjs public/assets --dry-run

# Keep PNG palettes lossless (no banding on gradients / neon renders)
node optimize-assets.mjs public/assets --no-palette --quality 90

# Also emit .webp siblings, cap at 2048px
node optimize-assets.mjs ./images --webp --max 2048

# Only JPEGs, higher compression
node optimize-assets.mjs ./photos --ext jpg,jpeg --quality 75

# Skip an extra folder, then reprocess everything from scratch
node optimize-assets.mjs . --ignore fixtures,samples --force
```

---

## How it works

For every matching image above `--min-kb`:

1. **Hash** the file. If it matches the manifest entry → **skip** (unchanged, already handled).
2. **Resize** if either side exceeds `--max` (`fit: inside`, never enlarges; EXIF orientation baked in before metadata is stripped).
3. **Re-encode to the same format** — PNG stays PNG, JPEG stays JPEG — so the filename and every reference stay untouched.
4. **Write only if smaller.** If re-encoding wouldn't shrink the file, the original is kept (and still recorded, so it isn't retried next run).
5. **Record** the result (hash, before/after bytes) in the manifest.

The manifest lives one level **above** the target directory by default, so it
never lands inside a folder you deploy or sync. Delete it (or pass `--force`) to
reprocess everything.

---

## Fidelity

Defaults are conservative but **not lossless** (resize + re-encode). On a first
bulk pass, spot-check the heaviest outputs. If a gradient or neon render shows
banding, re-run that folder with `--no-palette` or a higher `--quality`.

---

## When something's wrong

- **Missing dependency** — `'sharp' is not installed. Run: npm i -D sharp`. Install it and retry.
- **Bad usage** — an unknown flag, a value-flag with no value, more than one directory, or an out-of-range number (`--quality` 1–100, `--max`/`--min-kb` ≥ 0) prints the offending option plus the help text.
- **Not a directory** — the given path isn't a folder.

---

## Verify the tool

```bash
node optimize-assets.mjs --self-test
```

Generates a synthetic 3000px PNG, optimizes it, and asserts it shrank, was
resized, and that a second run doesn't rewrite it. Exit `0` = pass.

---

## Author

Pedro Plasencia — [programacion-es.dev](https://programacion-es.dev)

## License

MIT
