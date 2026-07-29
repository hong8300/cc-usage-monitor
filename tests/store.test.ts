/**
 * 設定の読み込みとスキーマ移行。
 *
 * ここで守りたいのは「既定値を変えたときに既存ユーザーへ届くこと」と、
 * 「ユーザーが能動的に選んだ値を移行で踏み潰さないこと」の両立。
 * `{...DEFAULT, ...parsed}` だけではこの 2 つは両立しない。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { DEFAULT_APP_SETTINGS, SETTINGS_SCHEMA_VERSION } from "../src/shared/types.ts";

let home: string;
let settingsJson: string;
let store: typeof import("../src/main/store.ts");

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-usage-monitor-store-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  settingsJson = path.join(home, ".cc-usage-monitor", "app-settings.json");
  fs.mkdirSync(path.dirname(settingsJson), { recursive: true });
  store = await import("../src/main/store.ts");
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(settingsJson, { force: true });
});

test("statusLine の再実行間隔の既定は 30 秒", () => {
  assert.equal(DEFAULT_APP_SETTINGS.statusLineRefreshSeconds, 30);
  assert.equal(store.loadSettings().statusLineRefreshSeconds, 30, "設定ファイルが無いとき");
});

test("v0 の設定ファイル（版なし・null 保存）は新しい既定へ移行する", () => {
  // 既定が null だった頃に保存されたファイル。全員がこの形で持っている。
  fs.writeFileSync(
    settingsJson,
    JSON.stringify({ tray: { mode: "both" }, statusLineRefreshSeconds: null }),
  );
  const loaded = store.loadSettings();
  assert.equal(loaded.statusLineRefreshSeconds, 30, "既定変更が既存ユーザーに届いていない");
  assert.equal(loaded.schemaVersion, SETTINGS_SCHEMA_VERSION);
  assert.equal(loaded.tray.mode, "both", "他の設定を巻き込んでいる");
});

test("移行後に「設定しない」を選び直したら、その選択が残る", () => {
  // 版が入った状態で null = 能動的に「設定しない」を選んだということ。
  fs.writeFileSync(
    settingsJson,
    JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, statusLineRefreshSeconds: null }),
  );
  assert.equal(store.loadSettings().statusLineRefreshSeconds, null, "選択が踏み潰されている");
});

test("v0 でも明示的に秒数を選んでいたらそのまま残す", () => {
  fs.writeFileSync(settingsJson, JSON.stringify({ statusLineRefreshSeconds: 10 }));
  assert.equal(store.loadSettings().statusLineRefreshSeconds, 10);
});

test("移行は保存で確定し、二度目の読み込みで再適用されない", () => {
  fs.writeFileSync(settingsJson, JSON.stringify({ statusLineRefreshSeconds: null }));
  const migrated = store.loadSettings();
  assert.equal(migrated.statusLineRefreshSeconds, 30);

  // ユーザーが「設定しない」に戻して保存
  store.saveSettings({ ...migrated, statusLineRefreshSeconds: null });
  assert.equal(store.loadSettings().statusLineRefreshSeconds, null);
});

test("壊れた設定ファイルは既定にフォールバックする", () => {
  fs.writeFileSync(settingsJson, "{ 半端な JSON");
  assert.deepEqual(store.loadSettings(), DEFAULT_APP_SETTINGS);
});

test("後から増えた項目は既定で埋まる（ネストも含む）", () => {
  fs.writeFileSync(settingsJson, JSON.stringify({ tray: { mode: "icon" } }));
  const loaded = store.loadSettings();
  assert.equal(loaded.tray.mode, "icon");
  assert.equal(loaded.mini.enabled, DEFAULT_APP_SETTINGS.mini.enabled);
  assert.deepEqual(loaded.notifications, DEFAULT_APP_SETTINGS.notifications);
});
