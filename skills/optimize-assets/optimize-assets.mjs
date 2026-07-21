#!/usr/bin/env node
// ============================================================================
// optimize-assets · idempotent, project-agnostic image optimizer (sharp).
// ----------------------------------------------------------------------------
// Walks a directory, resizes oversized raster images, and re-encodes them IN
// PLACE — the filename never changes, so every `<img src>` and `/assets/...`
// URL stays identical and only the file size shrinks.
//
// It is idempotent: a per-file content-hash manifest means a re-run is a no-op
// and only NEW or CHANGED files are reprocessed. It never enlarges a file — the
// result is written only when it is smaller than the original.
//
// The only dependency is `sharp`:  npm i -D sharp
//
//   node optimize-assets.mjs [directory] [options]
//   node optimize-assets.mjs --help        (full option list)
//
// Exit codes: 0 = success · 1 = an error occurred / self-test failed · 2 = bad usage.
// ============================================================================
import { readdir, readFile, writeFile, stat, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, dirname, extname, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// ── command-line parsing ──────────────────────────────────────────────────────
const commandLineArguments = process.argv.slice(2);

function hasFlag(name) {
  return commandLineArguments.includes(name);
}
function flagValue(name, fallbackValue) {
  const index = commandLineArguments.indexOf(name);
  const next = commandLineArguments[index + 1];
  return index !== -1 && next ? next : fallbackValue;
}

// Flags that consume the following token as their value. Used so the positional
// directory argument is not confused with a flag's value (e.g. `--ext png dir`).
const FLAGS_THAT_TAKE_A_VALUE = new Set([
  "--max", "--quality", "--ext", "--ignore", "--min-kb", "--manifest", "--concurrency",
]);

function firstPositionalArgument() {
  for (let index = 0; index < commandLineArguments.length; index++) {
    const token = commandLineArguments[index];
    if (token.startsWith("-")) continue;
    if (FLAGS_THAT_TAKE_A_VALUE.has(commandLineArguments[index - 1])) continue;
    return token;
  }
  return undefined;
}

if (hasFlag("-h") || hasFlag("--help")) {
  console.log(helpText());
  process.exit(0);
}

// Directories never descended into, so pointing the tool at a project root (or
// running it with no directory) can never touch dependency, build-output, or
// version-control images. Any dot-directory (.git, .next, .cache, …) is skipped
// separately in collectImageFiles(). Extend per run with --ignore <comma-list>.
const DEFAULT_IGNORED_DIRECTORIES = [
  "node_modules", "dist", "build", "out", "coverage", "vendor", "tmp", "target",
];

const options = {
  maximumLongestSide: Number(flagValue("--max", "1600")),
  quality: Number(flagValue("--quality", "82")),
  extensions: flagValue("--ext", "png,jpg,jpeg")
    .split(",")
    .map((extension) => extension.trim().toLowerCase().replace(/^\./, "")),
  minimumBytes: Number(flagValue("--min-kb", "8")) * 1024,
  usePngPalette: !hasFlag("--no-palette"),
  alsoWriteWebp: hasFlag("--webp"),
  concurrency: Math.max(1, Number(flagValue("--concurrency", "8"))),
  reprocessEverything: hasFlag("--force"),
  dryRun: hasFlag("--dry-run"),
  ignoredDirectories: new Set([
    ...DEFAULT_IGNORED_DIRECTORIES,
    ...flagValue("--ignore", "").split(",").map((name) => name.trim()).filter(Boolean),
  ]),
};

// ── validate usage (unknown flags, missing/invalid values) so a typo like
//    `--quaity 80` or `--quality abc` fails loudly instead of being ignored ────
validateArguments();

// ── sharp (fail with an actionable message, never a stack trace) ──────────────
let sharp;
try {
  sharp = (await import("sharp")).default;
} catch {
  exitWithError("'sharp' is not installed. Run:  npm i -D sharp   (or pnpm add -D sharp)", 1);
}

if (hasFlag("--self-test")) {
  process.exit(await runSelfTest());
}

const targetDirectory = resolve(firstPositionalArgument() ?? ".");
if (!(await isDirectory(targetDirectory))) {
  exitWithError(`not a directory: ${targetDirectory}`, 2);
}

// The manifest lives one level ABOVE the target directory by default, so it is
// never inside a folder that gets deployed or synced to a CDN.
const manifestPath = resolve(
  flagValue("--manifest", join(dirname(targetDirectory), ".optimize-assets.json")),
);

await optimizeDirectory(targetDirectory, manifestPath, options);

// ── core ──────────────────────────────────────────────────────────────────────
async function optimizeDirectory(directory, manifestFilePath, settings) {
  const manifest = settings.reprocessEverything ? {} : await readManifest(manifestFilePath);
  const allFiles = await collectImageFiles(directory, settings.ignoredDirectories);
  const imageFiles = allFiles.filter((filePath) =>
    settings.extensions.includes(extname(filePath).slice(1).toLowerCase()),
  );

  const modeLabel = settings.dryRun ? "DRY-RUN" : "optimize";
  const resizeLabel = settings.maximumLongestSide > 0 ? `${settings.maximumLongestSide}px` : "no resize";
  console.log(
    `${modeLabel} · ${imageFiles.length} candidate(s) in ${directory}  ` +
    `(max ${resizeLabel} · quality ${settings.quality}${settings.alsoWriteWebp ? " · +webp" : ""})`,
  );

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let totalBytesSaved = 0;
  let totalOriginalBytes = 0; // before/after weight, summed over the processed assets only
  let totalFinalBytes = 0;

  await runWithConcurrency(imageFiles, settings.concurrency, async (filePath) => {
    try {
      const relativePath = relative(directory, filePath);
      const originalBuffer = await readFile(filePath);

      if (originalBuffer.length < settings.minimumBytes) {
        skippedCount++;
        return;
      }

      const originalHash = hashContent(originalBuffer);
      const previousEntry = manifest[relativePath];
      if (previousEntry && previousEntry.hash === originalHash && !settings.reprocessEverything) {
        skippedCount++; // unchanged and already handled on a prior run
        return;
      }

      const optimizedBuffer = await optimizeImageBuffer(originalBuffer, filePath, settings);
      const isSmaller = optimizedBuffer.length < originalBuffer.length;
      const finalBuffer = isSmaller ? optimizedBuffer : originalBuffer; // never grow a file
      const finalHash = isSmaller ? hashContent(finalBuffer) : originalHash;

      if (!settings.dryRun) {
        if (isSmaller) await writeFile(filePath, finalBuffer);
        if (settings.alsoWriteWebp) await writeWebpSibling(originalBuffer, filePath, settings);
      }

      manifest[relativePath] = {
        hash: finalHash,
        bytes: finalBuffer.length,
        originalBytes: originalBuffer.length,
        savedBytes: originalBuffer.length - finalBuffer.length,
        at: new Date().toISOString(),
      };
      totalBytesSaved += originalBuffer.length - finalBuffer.length;
      totalOriginalBytes += originalBuffer.length;
      totalFinalBytes += finalBuffer.length;
      processedCount++;

      if (isSmaller) {
        console.log(
          `  ✓ ${relativePath}  ${formatBytes(originalBuffer.length)} → ` +
          `${formatBytes(finalBuffer.length)}  (−${percentSmaller(originalBuffer.length, finalBuffer.length)})`,
        );
      } else {
        console.log(`  · ${relativePath}  already minimal (${formatBytes(originalBuffer.length)})`);
      }
    } catch (error) {
      errorCount++;
      console.log(`  ✗ ${relative(directory, filePath)}: ${error.message}`);
    }
  });

  if (!settings.dryRun) {
    await writeFile(manifestFilePath, JSON.stringify(manifest, null, 2));
  }

  console.log("");
  if (processedCount === 0) {
    console.log(
      `nothing to optimize — ${skippedCount} file(s) already minimal or skipped` +
      `${errorCount ? ` · ${errorCount} errors` : ""}`,
    );
  } else {
    console.log(
      `${settings.dryRun ? "would shrink" : "shrank"} ${processedCount} asset(s):  ` +
      `${formatBytes(totalOriginalBytes)} → ${formatBytes(totalFinalBytes)}  ` +
      `(−${percentSmaller(totalOriginalBytes, totalFinalBytes)}, ` +
      `${settings.dryRun ? "would save" : "saved"} ${formatBytes(totalBytesSaved)})` +
      `${skippedCount ? ` · ${skippedCount} skipped` : ""}` +
      `${errorCount ? ` · ${errorCount} errors` : ""}`,
    );
  }
  console.log(`manifest: ${settings.dryRun ? "(dry-run · not written) " : ""}${manifestFilePath}`);
  if (errorCount) process.exitCode = 1;
}

// Re-encode to the SAME format (PNG stays PNG, JPEG stays JPEG) so the filename,
// and therefore every reference to it, is untouched.
async function optimizeImageBuffer(originalBuffer, filePath, settings) {
  const extension = extname(filePath).slice(1).toLowerCase();
  // rotate() bakes the EXIF orientation into the pixels before metadata is stripped.
  let image = sharp(originalBuffer, { failOn: "none" }).rotate();
  if (settings.maximumLongestSide > 0) {
    image = image.resize(settings.maximumLongestSide, settings.maximumLongestSide, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  if (extension === "png") {
    return image
      .png({ compressionLevel: 9, effort: 8, palette: settings.usePngPalette, quality: settings.quality })
      .toBuffer();
  }
  return image.jpeg({ quality: settings.quality, mozjpeg: true }).toBuffer();
}

async function writeWebpSibling(originalBuffer, filePath, settings) {
  let image = sharp(originalBuffer, { failOn: "none" }).rotate();
  if (settings.maximumLongestSide > 0) {
    image = image.resize(settings.maximumLongestSide, settings.maximumLongestSide, {
      fit: "inside",
      withoutEnlargement: true,
    });
  }
  const webpPath = filePath.slice(0, -extname(filePath).length) + ".webp";
  await writeFile(webpPath, await image.webp({ quality: settings.quality }).toBuffer());
}

// ── filesystem + helpers ───────────────────────────────────────────────────────
async function collectImageFiles(directory, ignoredDirectories) {
  const collected = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // skip dotfiles/dirs (manifest, .git, .next, …)
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue; // node_modules, dist, build, …
      collected.push(...(await collectImageFiles(join(directory, entry.name), ignoredDirectories)));
    } else if (entry.isFile()) {
      collected.push(join(directory, entry.name));
    }
  }
  return collected;
}

// Run an async task over a list with a fixed number of parallel workers.
async function runWithConcurrency(items, workerCount, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(workerCount, queue.length) }, async () => {
    while (queue.length) await task(queue.shift());
  });
  await Promise.all(workers);
}

async function readManifest(manifestFilePath) {
  try {
    return JSON.parse(await readFile(manifestFilePath, "utf8"));
  } catch {
    return {};
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function hashContent(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

function formatBytes(byteCount) {
  if (byteCount >= 1024 * 1024) return `${(byteCount / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.round(byteCount / 1024)}KB`;
}

function percentSmaller(beforeBytes, afterBytes) {
  return `${Math.round((1 - afterBytes / beforeBytes) * 100)}%`;
}

function exitWithError(message, exitCode) {
  console.error(`✗ ${message}`);
  process.exit(exitCode);
}

// Reject unknown flags, value-flags with no value, extra directories, and
// out-of-range numbers — with a plain message + the help text, never a stack.
function validateArguments() {
  const BOOLEAN_FLAGS = new Set([
    "--no-palette", "--webp", "--force", "--dry-run", "--self-test", "-h", "--help",
  ]);
  let positionalCount = 0;
  for (let index = 0; index < commandLineArguments.length; index++) {
    const token = commandLineArguments[index];
    if (!token.startsWith("-")) {
      if (FLAGS_THAT_TAKE_A_VALUE.has(commandLineArguments[index - 1])) continue; // a flag's value
      if (++positionalCount > 1) {
        exitWithError(`only one directory can be given — unexpected extra argument: ${token}\n\n${helpText()}`, 2);
      }
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) continue;
    if (FLAGS_THAT_TAKE_A_VALUE.has(token)) {
      const value = commandLineArguments[index + 1];
      if (value === undefined || value.startsWith("-")) {
        exitWithError(`option ${token} needs a value\n\n${helpText()}`, 2);
      }
      index++; // consume the value token
      continue;
    }
    exitWithError(`unknown option: ${token}\n\n${helpText()}`, 2);
  }

  if (!Number.isFinite(options.maximumLongestSide) || options.maximumLongestSide < 0) {
    exitWithError(`--max must be a number >= 0 (0 = no resize), got "${flagValue("--max", "")}"`, 2);
  }
  if (!Number.isFinite(options.quality) || options.quality < 1 || options.quality > 100) {
    exitWithError(`--quality must be a number 1-100, got "${flagValue("--quality", "")}"`, 2);
  }
  if (!Number.isFinite(options.minimumBytes) || options.minimumBytes < 0) {
    exitWithError(`--min-kb must be a number >= 0, got "${flagValue("--min-kb", "")}"`, 2);
  }
  if (!Number.isFinite(options.concurrency)) {
    exitWithError(`--concurrency must be a number >= 1, got "${flagValue("--concurrency", "")}"`, 2);
  }
}

function helpText() {
  return `optimize-assets · idempotent image optimizer (sharp)

  node optimize-assets.mjs [directory] [options]

  directory            target directory (recursive) · default: current directory
  --max <pixels>       cap the longest side, keep aspect ratio (0 = no resize) · default 1600
  --quality <number>   encode quality 1-100 · default 82
  --ext <list>         comma-separated extensions to process · default png,jpg,jpeg
  --ignore <list>      extra directory names to skip (added to the built-in list:
                       node_modules,dist,build,out,coverage,vendor,tmp,target;
                       all dot-directories are skipped too)
  --min-kb <number>    skip files smaller than this many kilobytes · default 8
  --no-palette         PNG: skip palette quantization (larger, maximum fidelity)
  --webp               also write a sibling <name>.webp (does not replace the source)
  --manifest <path>    idempotence ledger · default <directory>/../.optimize-assets.json
  --concurrency <n>    number of parallel workers · default 8
  --force              reprocess everything (ignore the manifest)
  --dry-run            report only, write nothing
  --self-test          run a built-in correctness check and exit
  -h, --help           show this help`;
}

// ── built-in self-check (the smallest runnable proof the tool works) ──────────
async function runSelfTest() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "optimize-assets-"));
  const testSettings = {
    maximumLongestSide: 512,
    quality: 80,
    extensions: ["png"],
    minimumBytes: 0,
    usePngPalette: true,
    alsoWriteWebp: false,
    concurrency: 2,
    reprocessEverything: false,
    dryRun: false,
    ignoredDirectories: new Set(),
  };
  try {
    // A large, noisy image is huge at 3000px, so the resize dominates the saving.
    const imagePath = join(temporaryDirectory, "big.png");
    const rawPixels = Buffer.alloc(3000 * 3000 * 3);
    for (let index = 0; index < rawPixels.length; index++) {
      rawPixels[index] = (index * 2654435761) & 0xff;
    }
    const bigPng = await sharp(rawPixels, { raw: { width: 3000, height: 3000, channels: 3 } }).png().toBuffer();
    await writeFile(imagePath, bigPng);
    const bytesBefore = (await stat(imagePath)).size;
    const manifestFilePath = join(temporaryDirectory, ".manifest.json");

    await optimizeDirectory(temporaryDirectory, manifestFilePath, testSettings);

    const bytesAfter = (await stat(imagePath)).size;
    assert(bytesAfter < bytesBefore, `expected the file to shrink: ${bytesBefore} → ${bytesAfter}`);
    const metadata = await sharp(imagePath).metadata();
    assert(
      metadata.width <= 512 && metadata.height <= 512,
      `expected a resize to <= 512px, got ${metadata.width}x${metadata.height}`,
    );

    // A second run must skip the unchanged file (idempotence).
    const modifiedTimeAfterFirstRun = (await stat(imagePath)).mtimeMs;
    await optimizeDirectory(temporaryDirectory, manifestFilePath, testSettings);
    assert(
      (await stat(imagePath)).mtimeMs === modifiedTimeAfterFirstRun,
      "the second run must not rewrite an unchanged file",
    );

    console.log("\n✓ self-test passed");
    return 0;
  } catch (error) {
    console.error(`\n✗ self-test failed: ${error.message}`);
    return 1;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
