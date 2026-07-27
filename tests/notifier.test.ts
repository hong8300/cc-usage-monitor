/**
 * 閾値通知のテスト。
 *
 * ここで守りたいのは「鳴らしすぎない」こと。statusLine はターン毎に届くので、
 * 素直な実装だと閾値を超えた後は毎ターン通知が飛ぶ。
 */

import assert from "node:assert/strict";
import { before, beforeEach, test } from "node:test";
import { DEFAULT_APP_SETTINGS, type AppSettings, type UsageSnapshot } from "../src/shared/types.ts";

let ThresholdNotifier: typeof import("../src/main/notifier.ts").ThresholdNotifier;

before(async () => {
  // notifier は electron の Notification を import するが、
  // 依存注入した notify を使う限り実行されないのでテストできる。
  ({ ThresholdNotifier } = await import("../src/main/notifier.ts"));
});

let fired: Array<{ title: string; body: string }>;

beforeEach(() => {
  fired = [];
});

function makeNotifier() {
  return new ThresholdNotifier({
    notify: (title, body) => fired.push({ title, body }),
    now: () => Date.parse("2026-07-28T00:00:00Z"),
  });
}

function snapshot(five: number | null, seven: number | null, resetsAt = 1785208200): UsageSnapshot {
  return {
    lastPayloadAt: 1,
    fiveHour: five === null ? null : { value: { used_percentage: five, resets_at: resetsAt }, observedAt: 1 },
    sevenDay: seven === null ? null : { value: { used_percentage: seven, resets_at: 1785787200 }, observedAt: 1 },
    model: null,
    contextWindow: null,
    sessionCost: null,
    sessionId: null,
    claudeCodeVersion: null,
    raw: null,
  };
}

const settings: AppSettings = DEFAULT_APP_SETTINGS;

test("閾値 (既定 80/95) を超えたら通知する", () => {
  const n = makeNotifier();
  n.check(snapshot(85, 0), settings);
  assert.equal(fired.length, 1);
  assert.match(fired[0]!.title, /セッション枠（5時間）が 80% を超えました/);
  assert.match(fired[0]!.body, /85% を消費/);
});

test("閾値未満では通知しない", () => {
  const n = makeNotifier();
  n.check(snapshot(79.9, 79.9), settings);
  assert.equal(fired.length, 0);
});

test("同じウィンドウ・同じ閾値では 1 回しか鳴らさない", () => {
  const n = makeNotifier();
  // statusLine はターン毎に届くので、同じ状態が何度も来る。
  for (let i = 0; i < 10; i++) n.check(snapshot(85, 0), settings);
  assert.equal(fired.length, 1, "毎ターン鳴っている");
});

test("上の閾値に達したら改めて鳴らす", () => {
  const n = makeNotifier();
  n.check(snapshot(85, 0), settings);
  n.check(snapshot(96, 0), settings);
  assert.equal(fired.length, 2);
  assert.match(fired[1]!.title, /95% を超えました/);
});

test("一気に飛び越えた場合、最も高い閾値だけを鳴らす", () => {
  const n = makeNotifier();
  // 0% → 96% と飛ぶと 80 と 95 の 2 通知になりかねない。
  n.check(snapshot(96, 0), settings);
  assert.equal(fired.length, 1, "80% の分も鳴っている");
  assert.match(fired[0]!.title, /95% を超えました/);

  // 後追いで 80% の通知が出ないこと
  n.check(snapshot(97, 0), settings);
  assert.equal(fired.length, 1);
});

test("ウィンドウがリセットされたら (resets_at が変わったら) また鳴らす", () => {
  const n = makeNotifier();
  n.check(snapshot(85, 0, 1785208200), settings);
  assert.equal(fired.length, 1);

  // 同じ 85% でも新しいウィンドウなら鳴らす
  n.check(snapshot(85, 0, 1785226200), settings);
  assert.equal(fired.length, 2);
});

test("5時間枠と週次枠は独立して通知される", () => {
  const n = makeNotifier();
  n.check(snapshot(85, 85), settings);
  assert.equal(fired.length, 2);
  assert.ok(fired.some((f) => f.title.includes("セッション枠")));
  assert.ok(fired.some((f) => f.title.includes("週次枠")));
});

test("通知を切ると鳴らない", () => {
  const n = makeNotifier();
  n.check(snapshot(99, 99), {
    ...settings,
    notifications: { ...settings.notifications, enabled: false },
  });
  assert.equal(fired.length, 0);
});

test("対象の枠を絞れる", () => {
  const n = makeNotifier();
  n.check(snapshot(99, 99), {
    ...settings,
    notifications: { ...settings.notifications, watchSevenDay: false },
  });
  assert.equal(fired.length, 1);
  assert.match(fired[0]!.title, /セッション枠/);
});

test("データが無い枠では鳴らない", () => {
  const n = makeNotifier();
  n.check(snapshot(null, null), settings);
  assert.equal(fired.length, 0);
  n.check(null, settings);
  assert.equal(fired.length, 0);
});

test("閾値が空なら鳴らない", () => {
  const n = makeNotifier();
  n.check(snapshot(99, 99), {
    ...settings,
    notifications: { ...settings.notifications, thresholds: [] },
  });
  assert.equal(fired.length, 0);
});

test("本文にリセットまでの残り時間が入る", () => {
  const n = makeNotifier();
  // now = 2026-07-28T00:00:00Z, resets_at = 1785208200 = 2026-07-28T03:10:00Z
  n.check(snapshot(85, null), settings);
  assert.match(fired[0]!.body, /3時間10分後にリセット/);
});
