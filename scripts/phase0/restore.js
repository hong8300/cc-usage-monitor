#!/usr/bin/env node
// Phase 0: restore ~/.claude/settings.json from the backup enable-dump.js made.

const os = require("os");
const fs = require("fs");
const path = require("path");

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const BACKUP = path.join(
  os.homedir(),
  ".cc-usage-monitor",
  "phase0",
  "settings.json.backup",
);

if (!fs.existsSync(BACKUP)) {
  console.error(`✗ no backup at ${BACKUP} — nothing to restore.`);
  process.exit(1);
}

const backup = fs.readFileSync(BACKUP, "utf8");
const current = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, "utf8") : "";

fs.writeFileSync(SETTINGS, backup);

const after = fs.readFileSync(SETTINGS, "utf8");
if (after !== backup) {
  console.error("✗ restore verification FAILED — settings.json does not match the backup.");
  process.exit(1);
}

console.log(`✓ restored ${SETTINGS} from backup (byte-identical).`);
if (current === backup) {
  console.log("• settings.json was already identical to the backup (no-op).");
}
console.log(`• backup kept at ${BACKUP} — delete it once Phase 0 is signed off.`);

const statusLine = JSON.parse(after).statusLine;
console.log(
  `• statusLine is now: ${statusLine ? JSON.stringify(statusLine) : "(absent, as before)"}`,
);
