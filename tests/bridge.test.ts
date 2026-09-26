/**
 * ブリッジの有効化 / 無効化と、生成される bridge.js の実挙動テスト。
 *
 * アプリ内で唯一 `~/.claude/settings.json` を書き換える箇所なので、
 * ここは実際にファイルを作って動かして確かめる。
 *
 * 本物のホームを触らないよう、`$HOME` を一時ディレクトリに差し替えてから
 * モジュールを動的 import する (paths.ts は読み込み時に os.homedir() を解決するため)。
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let home: string;
let claudeSettings: string;
let bridge: typeof import("../src/main/bridge/bridge-manager.ts");

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-usage-monitor-test-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  claudeSettings = path.join(home, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  // 動的 import。$HOME を差し替えた後でなければ paths.ts が本物のホームを掴む。
  bridge = await import("../src/main/bridge/bridge-manager.ts");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function writeSettings(value: unknown): void {
  fs.writeFileSync(claudeSettings, `${JSON.stringify(value, null, 2)}\n`);
}

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(claudeSettings, "utf8")) as Record<string, unknown>;
}

/** 生成された bridge.js に payload を流し込み、stdout を取る。 */
function runBridge(payload: unknown): string {
  return execFileSync(process.execPath, [path.join(home, ".cc-usage-monitor", "bridge.js")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 3000,
  });
}

test("statusLine が無い状態から有効化 → 他のキーを壊さない", () => {
  writeSettings({ model: "opus[1m]", permissions: { allow: ["Bash(uv run:*)"] } });

  const state = bridge.enableBridge();
  assert.equal(state.status, "enabled");

  const settings = readSettings();
  // 触ってよいのは statusLine だけ。
  assert.equal(settings.model, "opus[1m]");
  assert.deepEqual(settings.permissions, { allow: ["Bash(uv run:*)"] });

  const statusLine = settings.statusLine as { type: string; command: string };
  assert.equal(statusLine.type, "command");
  assert.match(statusLine.command, /bridge\.js/);
  // パスに空白が入っても壊れないよう引用符で囲まれていること。
  assert.match(statusLine.command, /^node "/);

  // 書き換え前の全文バックアップが残っていること (指示書 §6)。
  const backup = path.join(home, ".cc-usage-monitor", "claude-settings.backup.json");
  assert.ok(fs.existsSync(backup), "全文バックアップが無い");
  assert.equal((JSON.parse(fs.readFileSync(backup, "utf8")) as Record<string, unknown>).statusLine, undefined);
});

test("元々 statusLine が無かった場合、無効化でキーごと消える", () => {
  const state = bridge.disableBridge();
  assert.equal(state.status, "disabled");

  const settings = readSettings();
  assert.ok(!("statusLine" in settings), "statusLine キーが残っている");
  assert.equal(settings.model, "opus[1m]", "無関係なキーが失われた");
});

test("既存 statusLine を包んで有効化 → 無効化で元の設定に完全復元する", () => {
  const original = { type: "command", command: "echo hello-from-user", padding: 1 };
  writeSettings({ model: "opus[1m]", statusLine: original });

  bridge.enableBridge();
  const enabled = bridge.getBridgeState();
  assert.equal(enabled.status, "enabled");
  assert.equal(enabled.status === "enabled" ? enabled.wrappedCommand : null, "echo hello-from-user");

  bridge.disableBridge();
  // padding のような付随設定まで含めて元に戻ること。
  assert.deepEqual(readSettings().statusLine, original);
});

test("有効化中にユーザーが別の設定を変えても、無効化でそれを巻き戻さない", () => {
  writeSettings({ model: "opus[1m]" });
  bridge.enableBridge();

  // ユーザーが Claude Code 側で別の設定を追加した状況を再現する。
  const mid = readSettings();
  mid.effortLevel = "xhigh";
  writeSettings(mid);

  bridge.disableBridge();

  const after = readSettings();
  assert.equal(after.effortLevel, "xhigh", "有効化中のユーザー変更が巻き戻された");
  assert.ok(!("statusLine" in after));
});

test("他ツールの statusLine は foreign として検出し、無効化で勝手に消さない", () => {
  writeSettings({ statusLine: { type: "command", command: "some-other-tool" } });

  const state = bridge.getBridgeState();
  assert.equal(state.status, "foreign");

  const afterDisable = bridge.disableBridge();
  assert.equal(afterDisable.status, "foreign");
  assert.deepEqual(readSettings().statusLine, { type: "command", command: "some-other-tool" });
});

test("有効化は冪等 — 二重に呼んでも元コマンドを失わない", () => {
  writeSettings({ statusLine: { type: "command", command: "echo original" } });

  bridge.enableBridge();
  bridge.enableBridge(); // 2回目
  const state = bridge.getBridgeState();
  assert.equal(state.status === "enabled" ? state.wrappedCommand : null, "echo original");

  bridge.disableBridge();
  assert.deepEqual(readSettings().statusLine, { type: "command", command: "echo original" });
});

test("bridge.js: payload を latest.json に書き、既定行を出力する", () => {
  writeSettings({});
  bridge.enableBridge();

  const payload = {
    model: { id: "claude-opus-5[1m]", display_name: "Opus 5 (1M context)" },
    context_window: { used_percentage: 46 },
    rate_limits: {
      five_hour: { used_percentage: 14.000000000000002, resets_at: 1785208200 },
      seven_day: { used_percentage: 1, resets_at: 1785787200 },
    },
  };

  const out = runBridge(payload);

  const latest = JSON.parse(
    fs.readFileSync(path.join(home, ".cc-usage-monitor", "latest.json"), "utf8"),
  );
  assert.deepEqual(latest, payload, "latest.json が payload と一致しない");

  // 既定行でも浮動小数点誤差を丸めること。
  assert.match(out, /5h 14% · 7d 1%/);
  assert.ok(!out.includes("14.000000000000002"), "丸めずに出力している");
  assert.match(out, /Opus 5 \(1M context\)/);
});

test("bridge.js: rate_limits 欠損時も 0% ではなく — を出す", () => {
  writeSettings({});
  bridge.enableBridge();

  const out = runBridge({ model: { display_name: "Opus 5" }, rate_limits: { five_hour: {} } });
  assert.match(out, /5h — · 7d —/);
});

test("bridge.js: 元コマンドの stdout をそのままパススルーする", () => {
  writeSettings({ statusLine: { type: "command", command: "echo USER-STATUSLINE-OUTPUT" } });
  bridge.enableBridge();

  const out = runBridge({ model: { display_name: "Opus 5" } });
  assert.match(out, /USER-STATUSLINE-OUTPUT/);

  // パススルーしても取り込みは行われること。
  assert.ok(fs.existsSync(path.join(home, ".cc-usage-monitor", "latest.json")));
});

test("bridge.js: 元コマンドが失敗しても statusLine を壊さず既定行に落ちる", () => {
  writeSettings({ statusLine: { type: "command", command: "exit 3" } });
  bridge.enableBridge();

  const out = runBridge({ model: { display_name: "Opus 5" }, rate_limits: { five_hour: { used_percentage: 9 } } });
  assert.match(out, /Opus 5/, "既定行にフォールバックしていない");

  // 失敗はログに残るが stdout は汚さない。
  const log = path.join(home, ".cc-usage-monitor", "bridge.log");
  assert.ok(fs.existsSync(log));
  assert.match(fs.readFileSync(log, "utf8"), /passthrough-exit/);
});

test("bridge.js: 壊れた JSON を渡されても落ちず、生テキストは保全する", () => {
  writeSettings({});
  bridge.enableBridge();

  const out = execFileSync(process.execPath, [path.join(home, ".cc-usage-monitor", "bridge.js")], {
    input: "{ this is not json",
    encoding: "utf8",
  });

  assert.equal(out, "cc-usage-monitor", "既定ラベルを出していない");
  assert.equal(
    fs.readFileSync(path.join(home, ".cc-usage-monitor", "latest.json"), "utf8"),
    "{ this is not json",
  );
});

test("settings.json が壊れた JSON なら上書きせずエラーを返す", () => {
  fs.writeFileSync(claudeSettings, "{ broken json");

  const state = bridge.enableBridge();
  assert.equal(state.status, "error");
  // 壊れたファイルを更に壊していないこと。
  assert.equal(fs.readFileSync(claudeSettings, "utf8"), "{ broken json");
});

for (const script of [
  '"$HOME/.cc-usage-monitor/bridge.js"',
  '"${HOME}/.cc-usage-monitor/bridge.js"',
  "~/.cc-usage-monitor/bridge.js",
  '"%USERPROFILE%/.cc-usage-monitor/bridge.js"',
]) {
  test(`ホーム省略形 ${script} を再有効化しても元コマンドを保持する`, () => {
    const original = { type: "command", command: "echo original", padding: 2 };
    writeSettings({ model: "test", statusLine: original });
    bridge.enableBridge();
    writeSettings({ model: "test", statusLine: { type: "command", command: `node ${script}` } });
    assert.equal(bridge.getBridgeState().status, "enabled");
    const state = bridge.enableBridge({ refreshIntervalSeconds: 30 });
    assert.equal(state.status === "enabled" ? state.wrappedCommand : undefined, original.command);
    bridge.disableBridge();
    assert.deepEqual(readSettings(), { model: "test", statusLine: original });
  });
}

test("自己参照する旧設定を再有効化で修復・保全し、無効化でも復元しない", () => {
  const configPath = path.join(home, ".cc-usage-monitor", "bridge-config.json");
  for (const command of ['node "$HOME/.cc-usage-monitor/bridge.js"', `node "${bridge.bridgePaths.bridge}"`]) {
    const recursive = { type: "command", command, refreshInterval: 30 };
    const config = {
      bridgeScriptVersion: 1,
      originalCommand: command,
      originalStatusLine: recursive,
      settingsFileExisted: true,
      enabledAt: "2026-09-22T01:30:41.713Z",
    };
    writeSettings({ model: "keep", statusLine: recursive });
    fs.writeFileSync(configPath, JSON.stringify(config));
    const state = bridge.enableBridge({ refreshIntervalSeconds: 30 });
    assert.equal(state.status === "enabled" ? state.wrappedCommand : undefined, null);
    const repaired = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(repaired.originalStatusLine, null);
    assert.equal(repaired.bridgeScriptVersion, 2);
    assert.equal(repaired.enabledAt, config.enabledAt);
    const backups = fs.readdirSync(bridge.bridgePaths.backupDir).filter((name) => name.startsWith("bridge-config-"));
    assert.ok(backups.some((name) => fs.readFileSync(path.join(bridge.bridgePaths.backupDir, name), "utf8") === JSON.stringify(config)));
    assert.equal(runBridge({ model: { display_name: "safe" } }), "safe");
    bridge.disableBridge();
    assert.deepEqual(readSettings(), { model: "keep" });

    // 再有効化を経ずに無効化する場合も、壊れた元設定を復元しない。
    writeSettings({ model: "keep", statusLine: recursive });
    fs.writeFileSync(configPath, JSON.stringify(config));
    assert.equal(bridge.disableBridge().status, "disabled");
    assert.deepEqual(readSettings(), { model: "keep" });
  }
});

test("既存ブリッジの設定ファイルが無くても自身を元コマンドとして保存しない", () => {
  fs.rmSync(path.join(home, ".cc-usage-monitor", "bridge-config.json"), { force: true });
  writeSettings({ statusLine: { type: "command", command: 'node "$HOME/.cc-usage-monitor/bridge.js"' } });
  const state = bridge.enableBridge();
  assert.equal(state.status === "enabled" ? state.wrappedCommand : undefined, null);
  bridge.disableBridge();
  assert.deepEqual(readSettings(), {});
});

test("同じ更新間隔でもスクリプトを更新し、settings.json は書き換えない", () => {
  writeSettings({});
  bridge.enableBridge({ refreshIntervalSeconds: 30 });
  const before = fs.statSync(claudeSettings);
  fs.writeFileSync(bridge.bridgePaths.bridge, "// old script");
  bridge.enableBridge({ refreshIntervalSeconds: 30 });
  assert.equal(fs.statSync(claudeSettings).mtimeMs, before.mtimeMs);
  assert.match(fs.readFileSync(bridge.bridgePaths.bridge, "utf8"), /bridgeScriptVersion: 2/);
});

test("bridge.js に似た別コマンドや単なる文字列出力は他ツールとして保持する", () => {
  for (const command of [`node "${bridge.bridgePaths.bridge}.other"`, `echo "${bridge.bridgePaths.bridge}"`]) {
    writeSettings({ statusLine: { type: "command", command } });
    assert.equal(bridge.getBridgeState().status, "foreign");
    assert.equal(bridge.disableBridge().status, "foreign");
    assert.deepEqual(readSettings().statusLine, { type: "command", command });
  }
});

test("bridge.js: 間接的な自己呼び出しも子プロセスのガードで停止する", () => {
  const wrapper = path.join(home, "wrapper.cjs");
  const count = path.join(home, "invocations.txt");
  // ガードに回帰があってもテスト自身がプロセスを無限生成しないよう上限を設ける。
  fs.writeFileSync(wrapper, `
    const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(count)}, 'call\\n');
    if (fs.readFileSync(${JSON.stringify(count)}, 'utf8').split('\\n').length > 4) process.exit(23);
    require(${JSON.stringify(bridge.bridgePaths.bridge)});
  `);
  writeSettings({ statusLine: { type: "command", command: `"${process.execPath}" "${wrapper}"` } });
  bridge.enableBridge();
  assert.equal(runBridge({ model: { display_name: "safe" } }), "safe");
  assert.equal(fs.readFileSync(count, "utf8"), "call\n");
  assert.match(fs.readFileSync(bridge.bridgePaths.log, "utf8"), /recursion-blocked/);
});
