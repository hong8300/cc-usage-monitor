#!/usr/bin/env node
// Phase 0 investigation only — a temporary statusLine bridge that records the
// full stdin JSON so the documented schema can be verified on real hardware.
//
// This is NOT the production bridge. It is thrown away once findings.md is
// filled in. See scripts/phase0/enable-dump.js / restore.js.

const os = require("os");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(os.homedir(), ".cc-usage-monitor", "phase0");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (buf += chunk));
process.stdin.on("end", () => {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // Atomic write (tmp -> rename), same strategy the production bridge uses.
    const tmp = path.join(OUT_DIR, "statusline-dump.json.tmp");
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(OUT_DIR, "statusline-dump.json"));

    // Append every sample so we can watch rate_limits appear across turns:
    // the docs say it is absent until the first API response of the session.
    fs.appendFileSync(
      path.join(OUT_DIR, "statusline-dump.log.jsonl"),
      buf.replace(/\r?\n/g, " ").trim() + "\n",
    );
  } catch (err) {
    process.stdout.write("cc-usage-monitor phase0 dump FAILED: " + err.message);
    return;
  }

  // Keep a useful status line while the dumper is installed.
  let label = "cc-usage-monitor phase0 dump ok";
  try {
    const d = JSON.parse(buf);
    const rl = d.rate_limits;
    const five = rl && rl.five_hour && rl.five_hour.used_percentage;
    const week = rl && rl.seven_day && rl.seven_day.used_percentage;
    label =
      `[phase0] ${d.model && d.model.display_name} · ` +
      `5h ${five == null ? "—" : five + "%"} · ` +
      `7d ${week == null ? "—" : week + "%"}`;
  } catch {
    /* keep the default label */
  }
  process.stdout.write(label);
});
