/**
 * `latest.json` の観測時刻の扱い。
 *
 * ここで守りたいのは「読んだ時刻を観測時刻にしない」こと。
 * アプリ起動時に読む latest.json は前回セッション — 下手をすると前日 — のもので、
 * Date.now() を観測時刻にすると昨日の値が「たった今更新」として表示され、
 * 鮮度判定も期限切れ判定もまとめて無効になる。
 *
 * bridge.test.ts と同じく、本物のホームを触らないよう $HOME を差し替えてから
 * 動的 import する (paths.ts は読み込み時に os.homedir() を解決するため)。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { STALE_AFTER_MS } from "../src/shared/types.ts";

let home: string;
let latestJson: string;
let UsageWatcher: typeof import("../src/main/watcher.ts").UsageWatcher;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cc-usage-monitor-watcher-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  latestJson = path.join(home, ".cc-usage-monitor", "latest.json");
  fs.mkdirSync(path.dirname(latestJson), { recursive: true });
  ({ UsageWatcher } = await import("../src/main/watcher.ts"));
});

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(latestJson, { force: true });
});

/** payload を書き、mtime を指定時刻に偽装する。 */
function writeLatest(payload: unknown, mtimeMs: number): void {
  fs.writeFileSync(latestJson, JSON.stringify(payload));
  const seconds = mtimeMs / 1000;
  fs.utimesSync(latestJson, seconds, seconds);
}

const PAYLOAD = {
  rate_limits: {
    five_hour: { used_percentage: 23, resets_at: 1785208200 },
    seven_day: { used_percentage: 7, resets_at: 1785787200 },
  },
};

test("観測時刻はファイルの書き込み時刻であって、読んだ時刻ではない", () => {
  const nineHoursAgo = Date.now() - 9 * 3_600_000;
  writeLatest(PAYLOAD, nineHoursAgo);

  const watcher = new UsageWatcher();
  watcher.refresh();

  const snapshot = watcher.current();
  assert.ok(snapshot);
  // ±2秒。ファイルシステムの mtime 精度に依存するため厳密一致にはしない。
  assert.ok(
    Math.abs(snapshot.fiveHour!.observedAt - nineHoursAgo) < 2000,
    `観測時刻が書き込み時刻になっていない: ${snapshot.fiveHour!.observedAt}`,
  );
  assert.ok(
    Date.now() - snapshot.lastPayloadAt! > STALE_AFTER_MS,
    "9時間前の payload が『古い』と判定されていない",
  );
});

test("未来の mtime でも永久に新鮮扱いにならない", () => {
  // 時刻ずれや別マシンからの同期で mtime が未来になることがある。
  writeLatest(PAYLOAD, Date.now() + 60 * 3_600_000);

  const watcher = new UsageWatcher();
  watcher.refresh();

  const observedAt = watcher.current()!.fiveHour!.observedAt;
  assert.ok(observedAt <= Date.now() + 1000, "未来の観測時刻がそのまま採用されている");
});

test("書き込み直後の payload は新鮮なままである", () => {
  writeLatest(PAYLOAD, Date.now());

  const watcher = new UsageWatcher();
  watcher.refresh();

  const snapshot = watcher.current()!;
  assert.ok(Date.now() - snapshot.lastPayloadAt! < STALE_AFTER_MS);
  assert.equal(snapshot.fiveHour?.value.used_percentage, 23);
});

test("ファイルが無い / 壊れている場合は前回のスナップショットを保持する", () => {
  writeLatest(PAYLOAD, Date.now());
  const watcher = new UsageWatcher();
  watcher.refresh();

  fs.writeFileSync(latestJson, "{ 半端な JSON");
  watcher.refresh();
  assert.equal(watcher.current()?.fiveHour?.value.used_percentage, 23);

  fs.rmSync(latestJson);
  watcher.refresh();
  assert.equal(watcher.current()?.fiveHour?.value.used_percentage, 23);
});
