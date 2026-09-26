/**
 * `~/.cc-usage-monitor/bridge.js` として書き出される statusLine ブリッジの中身。
 *
 * 設計上の絶対条件:
 *   **このスクリプトは何があっても statusLine を壊してはならない。**
 * Claude Code のセッション中ずっと毎ターン走るので、ここで例外を投げたり
 * ハングしたりするとユーザーの作業が直接壊れる。したがって全処理を try/catch で包み、
 * 失敗しても必ず 1 行を stdout に出して正常終了する。
 *
 * 依存は Node 組み込みのみ (アプリの node_modules に依存しない)。
 */

export const BRIDGE_SCRIPT_VERSION = 2;

export function renderBridgeScript(options: {
  latestJsonPath: string;
  configPath: string;
  logPath: string;
}): string {
  const { latestJsonPath, configPath, logPath } = options;

  return `#!/usr/bin/env node
// cc-usage-monitor statusLine bridge (generated — 直接編集しないこと)
// bridgeScriptVersion: ${BRIDGE_SCRIPT_VERSION}
//
// 役割:
//   1. stdin の JSON 全体を latest.json に原子的書き込み (tmp → rename)
//   2. 元の statusLine コマンドがあれば同じ JSON を渡して実行し stdout をパススルー
//   3. 無ければ簡潔な既定行を出力
//
// 何が起きても stdout に 1 行出して exit 0 する。statusLine を壊さないため。

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const LATEST = ${JSON.stringify(latestJsonPath)};
const CONFIG = ${JSON.stringify(configPath)};
const LOG = ${JSON.stringify(logPath)};

function logError(stage, err) {
  try {
    const line = new Date().toISOString() + " [" + stage + "] " + (err && err.stack ? err.stack : String(err)) + "\\n";
    fs.appendFileSync(LOG, line);
  } catch (_) {
    // ログにすら書けない場合は黙って諦める。statusLine を汚さない方が大事。
  }
}

/** tmp に書いてから rename。読み手が半端な JSON を掴まないようにする。 */
function writeAtomic(target, contents) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  // 同時に複数セッションが走ってもぶつからないよう pid を混ぜる。
  const tmp = target + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  } catch (_) {
    return {};
  }
}

/** 元コマンドが無いときの既定行。payload から読めた範囲だけを出す。 */
function defaultLine(payload) {
  const parts = [];
  try {
    const model = payload && payload.model && payload.model.display_name;
    if (model) parts.push(model);

    const rl = (payload && payload.rate_limits) || {};
    const five = rl.five_hour && rl.five_hour.used_percentage;
    const week = rl.seven_day && rl.seven_day.used_percentage;
    // 欠損は 0% ではなく "—"。指示書 §4 の表示規則をブリッジ側でも守る。
    const pct = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v) + "%" : "—");
    if (rl.five_hour || rl.seven_day) {
      parts.push("5h " + pct(five) + " · 7d " + pct(week));
    }

    const ctx = payload && payload.context_window && payload.context_window.used_percentage;
    if (typeof ctx === "number" && isFinite(ctx)) parts.push("ctx " + Math.round(ctx) + "%");
  } catch (err) {
    logError("defaultLine", err);
  }
  return parts.length > 0 ? parts.join(" · ") : "cc-usage-monitor";
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (buf += chunk));
process.stdin.on("error", (err) => {
  logError("stdin", err);
  process.stdout.write("cc-usage-monitor");
  process.exit(0);
});

process.stdin.on("end", () => {
  let payload = null;
  try {
    payload = JSON.parse(buf);
  } catch (err) {
    logError("parse", err);
  }

  // ラッパーや別表記のパス経由でも、子孫のブリッジから再起動させない。
  if (process.env.CC_USAGE_MONITOR_BRIDGE_ACTIVE === "1") {
    logError("recursion-blocked", new Error("recursive statusLine bridge invocation"));
    process.stdout.write(defaultLine(payload));
    return;
  }

  // 1) 取り込み。パースできなくても生テキストは落としておく (デバッグのため)。
  try {
    writeAtomic(LATEST, buf);
  } catch (err) {
    logError("write", err);
  }

  // 2) パススルー
  const config = readConfig();
  const original = config && typeof config.originalCommand === "string" ? config.originalCommand : null;

  if (!original) {
    process.stdout.write(defaultLine(payload));
    return;
  }

  let settled = false;
  const finish = (text) => {
    if (settled) return;
    settled = true;
    process.stdout.write(text);
  };

  try {
    const shell = process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", original] : ["-c", original];
    const child = spawn(shell, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CC_USAGE_MONITOR_BRIDGE_ACTIVE: "1" },
    });

    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));

    // 元コマンドがハングしても statusLine を巻き込まないよう打ち切る。
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
      logError("passthrough-timeout", new Error("original statusLine command timed out"));
      finish(defaultLine(payload));
    }, 5000);

    child.on("error", (err) => {
      clearTimeout(timer);
      logError("passthrough-spawn", err);
      finish(defaultLine(payload));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && out.length === 0) {
        logError("passthrough-exit", new Error("exit " + code + ": " + errOut.slice(0, 500)));
        finish(defaultLine(payload));
        return;
      }
      finish(out);
    });

    child.stdin.on("error", (err) => logError("passthrough-stdin", err));
    child.stdin.end(buf);
  } catch (err) {
    logError("passthrough", err);
    finish(defaultLine(payload));
  }
});
`;
}
