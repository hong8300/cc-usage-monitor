#!/usr/bin/env node
// Phase 0: temporarily point ~/.claude/settings.json at the dump script so we
// can capture the real statusLine payload. Backs up first; restore.js undoes it.
//
//   node scripts/phase0/enable-dump.js
//   ... send one prompt in Claude Code ...
//   node scripts/phase0/restore.js

const os = require("os");
const fs = require("fs");
const path = require("path");

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const BACKUP_DIR = path.join(os.homedir(), ".cc-usage-monitor", "phase0");
const BACKUP = path.join(BACKUP_DIR, "settings.json.backup");
const DUMP = path.join(__dirname, "dump.js");

if (!fs.existsSync(SETTINGS)) {
  console.error(`✗ not found: ${SETTINGS}`);
  process.exit(1);
}

const raw = fs.readFileSync(SETTINGS, "utf8");
let settings;
try {
  settings = JSON.parse(raw);
} catch (err) {
  console.error(`✗ ${SETTINGS} is not valid JSON: ${err.message}`);
  process.exit(1);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// Never clobber an existing backup — a second run would otherwise back up the
// already-patched file and make restore a no-op.
if (fs.existsSync(BACKUP)) {
  console.log(`• backup already exists, keeping it: ${BACKUP}`);
} else {
  fs.writeFileSync(BACKUP, raw);
  console.log(`✓ backed up  ${SETTINGS}\n         ->  ${BACKUP}`);
}

if (settings.statusLine) {
  console.log(
    `• existing statusLine found and preserved in the backup:\n  ${JSON.stringify(settings.statusLine)}`,
  );
}

settings.statusLine = { type: "command", command: `node ${DUMP}` };
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");

console.log(`✓ statusLine -> node ${DUMP}`);
console.log(`
Next:
  1. Send one prompt in Claude Code (rate_limits is absent until the first
     API response of a session).
  2. The payload lands in:
       ${path.join(BACKUP_DIR, "statusline-dump.json")}
       ${path.join(BACKUP_DIR, "statusline-dump.log.jsonl")}
  3. Restore with:  node ${path.join(__dirname, "restore.js")}
`);
