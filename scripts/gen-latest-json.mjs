#!/usr/bin/env node
/**
 * Generate the Tauri updater's `latest.json` for a release.
 *
 * The release workflow calls this after `tauri build` has produced the signed
 * `.app.tar.gz` + `.sig` pairs, so the updater endpoint
 * (`releases/latest/download/latest.json`) always describes the newest release:
 *
 *   bun scripts/gen-latest-json.mjs \
 *     --version 1.7.0 \
 *     --notes "$(cat release-notes.txt)" \
 *     --sig-arm "$(cat 'Session Recall.app.tar.gz.sig')" \
 *     --url-arm  'https://github.com/odinyu/session-recall/releases/download/v1.7.0/session-recall_1.7.0_macos-arm64.app.tar.gz' \
 *     --sig-intel "$(cat 'Session Recall.app.tar.gz.sig')" \
 *     --url-intel 'https://github.com/odinyu/session-recall/releases/download/v1.7.0/session-recall_1.7.0_macos-intel.app.tar.gz' \
 *     --out latest.json
 *
 * `buildLatestJson` is exported so `test/update.test.ts` can pin the exact
 * schema the updater plugin parses.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Build the object the updater plugin expects: `version`, `notes`, `pub_date`
 * (RFC 3339) and one `platforms` entry per Apple slice, each carrying the
 * signature of the packaged archive and the URL it is served from.
 */
export function buildLatestJson({
  version,
  notes,
  pubDate,
  darwinAarch64,
  darwinX86_64,
}) {
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`version must be semver-ish, got ${JSON.stringify(version)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(pubDate)) {
    throw new Error(
      `pub_date must be RFC 3339 UTC (YYYY-MM-DDTHH:MM:SSZ), got ${JSON.stringify(pubDate)}`,
    );
  }
  for (const [name, platform] of [
    ["darwin-aarch64", darwinAarch64],
    ["darwin-x86_64", darwinX86_64],
  ]) {
    if (!/^https:\/\//.test(platform.url)) {
      throw new Error(`${name} url must be https, got ${JSON.stringify(platform.url)}`);
    }
    if (platform.signature.trim() === "") {
      throw new Error(`${name} signature is empty`);
    }
  }
  return {
    version,
    notes,
    pub_date: pubDate,
    platforms: {
      "darwin-aarch64": {
        signature: darwinAarch64.signature.trim(),
        url: darwinAarch64.url,
      },
      "darwin-x86_64": {
        signature: darwinX86_64.signature.trim(),
        url: darwinX86_64.url,
      },
    },
  };
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!key || value === undefined) {
      throw new Error(`expected --key value pairs, got ${JSON.stringify(argv)}`);
    }
    args[key] = value;
  }
  for (const key of [
    "version",
    "notes",
    "sig-arm",
    "url-arm",
    "sig-intel",
    "url-intel",
    "out",
  ]) {
    if (!(key in args)) throw new Error(`missing --${key}`);
  }
  // Fresh every release; the workflow only overrides it in tests.
  const pubDate = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const latest = buildLatestJson({
    version: args.version,
    notes: args.notes,
    pubDate,
    darwinAarch64: { signature: args["sig-arm"], url: args["url-arm"] },
    darwinX86_64: { signature: args["sig-intel"], url: args["url-intel"] },
  });
  writeFileSync(args.out, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  console.log(`latest.json → ${args.out} (version ${latest.version}, ${pubDate})`);
}

// CLI entry only when executed directly, so the test can import the helper.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2));
}
