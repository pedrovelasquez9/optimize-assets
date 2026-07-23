---
description: Verify the tool works (runs the built-in self-test)
allowed-tools: Bash(node:*)
---
Run the built-in correctness check and report the result. This confirms `sharp`
is installed and the optimizer shrinks, resizes, and stays idempotent. Exit 0 =
pass; on a missing dependency it prints `'sharp' is not installed…` — surface it.

node "${CLAUDE_PLUGIN_ROOT}/skills/optimize-assets/optimize-assets.mjs" --self-test
