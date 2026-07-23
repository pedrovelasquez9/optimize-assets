---
description: Optimize (shrink) images in place; forwards any sharp flags
argument-hint: <dir> [--quality N] [--max PX] [--webp] [--no-palette] [--force] ...
allowed-tools: Bash(node:*)
---
Optimize the image assets in the directory the user gave, in place (same
filenames, so every `<img src>` and `/assets/...` URL stays identical).

Steps:
1. Run once with `--dry-run` added, to show the projected before→after total.
2. Show that projection and confirm with the user before writing — these are
   usually a designer's assets and fidelity matters.
3. On confirmation, run again WITHOUT `--dry-run` and relay the final
   `shrank N asset(s): … → …` line verbatim.

Forward every flag the user passed. If `$ARGUMENTS` is empty, ask for the target
directory first.

Preview:

node "${CLAUDE_PLUGIN_ROOT}/skills/optimize-assets/optimize-assets.mjs" $ARGUMENTS --dry-run
