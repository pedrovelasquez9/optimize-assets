---
description: Preview asset savings (dry-run — writes nothing, no confirmation)
argument-hint: <dir> [--quality N] [--max PX] ...
allowed-tools: Bash(node:*)
---
Report the projected savings for the given directory WITHOUT writing anything.
Always add `--dry-run`. Relay the `would shrink N asset(s): … → …` summary line.

If `$ARGUMENTS` is empty, ask for the target directory first. Forward any extra
flags the user passed.

node "${CLAUDE_PLUGIN_ROOT}/skills/optimize-assets/optimize-assets.mjs" $ARGUMENTS --dry-run
