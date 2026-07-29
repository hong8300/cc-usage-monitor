/**
 * docs/findings.md の実測から出てきた落とし穴の回帰テスト。
 *
 * ここにあるケースはすべて「実機で実際に観測した値」が元になっている。
 * 想像で書いたケースは入れていない。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeWindow,
  formatCountdown,
  formatPercent,
  formatResetHint,
  mergeSnapshot,
  normalizeModelId,
  parseResetsAt,
  severityFor,
  stripDateSuffix,
  windowReason,
  worstSeverity,
} from "../src/shared/normalize.ts";
import { FIVE_HOUR_WINDOW_MS } from "../src/shared/types.ts";

test("findings §2-3(1): 浮動小数点誤差つきの used_percentage を丸めて表示する", () => {
  // 実測値。素で描画すると "14.000000000000002%" と出てしまう。
  assert.equal(formatPercent(14.000000000000002), "14%");
  assert.equal(formatPercent(13), "13%");
  assert.equal(formatPercent(0), "0%");
});

test("欠損は 0% ではなく null を返す（呼び出し側が — を出せるように）", () => {
  assert.equal(formatPercent(undefined), null);
  assert.equal(formatPercent(null), null);
  assert.equal(formatPercent(Number.NaN), null);
});

test("パーセントは 0〜100 にクランプされる", () => {
  assert.equal(formatPercent(-5), "0%");
  assert.equal(formatPercent(140), "100%");
});

test("findings §2-3: resets_at は Unix 秒として解釈する", () => {
  // 実測値 1785208200 → 2026-07-28T03:10:00Z
  const parsed = parseResetsAt(1785208200);
  assert.equal(parsed?.toISOString(), "2026-07-28T03:10:00.000Z");

  const weekly = parseResetsAt(1785787200);
  assert.equal(weekly?.toISOString(), "2026-08-03T20:00:00.000Z");
});

test("将来 ISO8601 文字列やミリ秒に変わっても壊れない（未確認項目のフォールバック）", () => {
  assert.equal(parseResetsAt("2026-07-28T03:10:00Z")?.toISOString(), "2026-07-28T03:10:00.000Z");
  // 13桁はミリ秒とみなす
  assert.equal(parseResetsAt(1785208200000)?.toISOString(), "2026-07-28T03:10:00.000Z");
  assert.equal(parseResetsAt(undefined), null);
  assert.equal(parseResetsAt("not a date"), null);
});

test("findings §2-3(2): statusLine の model.id から角括弧サフィックスを外す", () => {
  // statusLine 側の実測値
  assert.equal(normalizeModelId("claude-opus-5[1m]"), "claude-opus-5");
  // JSONL 側の実測値 — 変化しない
  assert.equal(normalizeModelId("claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModelId("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModelId(null), null);
});

test("findings §3-4: 日付サフィックス除去は旧モデルにだけ効き、版数を壊さない", () => {
  assert.equal(stripDateSuffix("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet");
  // 現行モデルの版数を日付と誤認しないこと
  assert.equal(stripDateSuffix("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(stripDateSuffix("claude-opus-5"), "claude-opus-5");
});

test("指示書 §4: 閾値は 〜50% 緑 / 〜80% 橙 / 80%〜 赤", () => {
  assert.equal(severityFor(0), "ok");
  assert.equal(severityFor(50), "ok");
  assert.equal(severityFor(50.1), "warn");
  assert.equal(severityFor(79.9), "warn");
  assert.equal(severityFor(80), "critical");
  assert.equal(severityFor(100), "critical");
  assert.equal(severityFor(undefined), null);
});

test("2つの枠のうち厳しい方の色を採る", () => {
  assert.equal(worstSeverity(10, 90), "critical");
  assert.equal(worstSeverity(10, 60), "warn");
  assert.equal(worstSeverity(10, 20), "ok");
  assert.equal(worstSeverity(null, undefined), null);
  // 片方だけ取れている状態は正規（docs 明記）
  assert.equal(worstSeverity(85, null), "critical");
});

test("findings §2-3(3): 今回の payload に無いフィールドは前回値を保持する", () => {
  const first = mergeSnapshot(
    null,
    {
      rate_limits: {
        five_hour: { used_percentage: 13, resets_at: 1785208200 },
        seven_day: { used_percentage: 1, resets_at: 1785787200 },
      },
      model: { id: "claude-opus-5[1m]", display_name: "Opus 5 (1M context)" },
    },
    1000,
  );
  assert.equal(first.fiveHour?.value.used_percentage, 13);
  assert.equal(first.model?.value.normalizedId, "claude-opus-5");

  // rate_limits ごと欠落した payload が来ても、直前の値が消えてはいけない。
  // 実測で workspace.repo が明滅したのと同じ現象への備え。
  const second = mergeSnapshot(first, { session_id: "abc" }, 2000);
  assert.equal(second.fiveHour?.value.used_percentage, 13);
  assert.equal(second.fiveHour?.observedAt, 1000, "観測時刻は据え置き（鮮度判定に使う）");
  assert.equal(second.lastPayloadAt, 2000, "payload 自体の到着時刻は更新される");
});

test("片方のウィンドウだけ来た場合、もう片方は前回値を保つ", () => {
  const first = mergeSnapshot(
    null,
    { rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 2 } } },
    1000,
  );
  const second = mergeSnapshot(first, { rate_limits: { five_hour: { used_percentage: 20 } } }, 2000);

  assert.equal(second.fiveHour?.value.used_percentage, 20);
  assert.equal(second.fiveHour?.observedAt, 2000);
  assert.equal(second.sevenDay?.value.used_percentage, 2);
  assert.equal(second.sevenDay?.observedAt, 1000);
});

test("リセットまでのカウントダウン", () => {
  const base = Date.parse("2026-07-28T00:00:00Z");
  assert.equal(formatCountdown(new Date(base + 90 * 60_000), base), "1時間30分後");
  assert.equal(formatCountdown(new Date(base + 20 * 60_000), base), "20分後");
  assert.equal(formatCountdown(new Date(base + 26 * 3_600_000), base), "1日2時間後");
  assert.equal(formatCountdown(new Date(base - 1000), base), "まもなくリセット");
});

test("「まもなくリセット」は跨いだ直後だけ。何時間も前に過ぎた値には出さない", () => {
  const base = Date.parse("2026-07-28T00:00:00Z");
  // マシンを一晩落として起動した状況。前日の resets_at はとうに過ぎている。
  assert.equal(formatCountdown(new Date(base - 9 * 3_600_000), base), "リセット済み");
  assert.equal(formatCountdown(new Date(base - 61_000), base), "リセット済み");
  // 猶予 (60秒) の内側は従来どおり
  assert.equal(formatCountdown(new Date(base - 59_000), base), "まもなくリセット");
});

test("リセット文言は助詞まで込みで組み立てる（「まもなくリセットにリセット」を出さない）", () => {
  const base = Date.parse("2026-07-28T00:00:00Z");
  assert.equal(formatResetHint(new Date(base + 90 * 60_000), base), "1時間30分後にリセット");
  // 過去時刻に「にリセット」を足さないこと。これが実際に画面に出ていた不具合。
  assert.equal(formatResetHint(new Date(base - 1000), base), "まもなくリセット");
  assert.equal(formatResetHint(new Date(base - 9 * 3_600_000), base), "リセット済み");
  assert.equal(formatResetHint(null, base), null);
});

test("週次枠は日付も添える", () => {
  const base = Date.parse("2026-07-28T00:00:00Z");
  const hint = formatResetHint(new Date(base + 50 * 3_600_000), base, { withDate: true });
  assert.match(hint ?? "", /にリセット（2日2時間後）$/);
});

test("resets_at を過ぎた枠の消費率は表示しない（前日の値を現在値として出さない）", () => {
  const now = Date.parse("2026-07-30T06:00:00Z");
  const yesterday = Date.parse("2026-07-29T21:00:00Z");

  const view = describeWindow(
    // 前日 21:00 に観測、リセットは 22:30 → 現在から見て 7時間半前に切り替わっている
    {
      value: { used_percentage: 23, resets_at: Date.parse("2026-07-29T22:30:00Z") / 1000 },
      observedAt: yesterday,
    },
    now,
    { maxAgeMs: FIVE_HOUR_WINDOW_MS },
  );

  assert.equal(view.expired, true);
  assert.equal(view.percent, null, "期限切れの 23% を現在値として出してはいけない");
  assert.equal(view.lastKnownPercent, 23, "説明用に前の枠の値は残す");
  assert.equal(view.stale, true);
});

test("期限内の枠はそのまま表示する", () => {
  const now = Date.parse("2026-07-30T06:00:00Z");
  const view = describeWindow(
    {
      value: { used_percentage: 16, resets_at: Date.parse("2026-07-30T10:50:00Z") / 1000 },
      observedAt: now - 30_000,
    },
    now,
    { maxAgeMs: FIVE_HOUR_WINDOW_MS },
  );

  assert.equal(view.expired, false);
  assert.equal(view.percent, 16);
  assert.equal(view.stale, false);
});

test("resets_at が欠けていてもウィンドウ長を超えた観測は期限切れとみなす", () => {
  const now = Date.parse("2026-07-30T06:00:00Z");
  const observed = { value: { used_percentage: 23 }, observedAt: now - 6 * 3_600_000 };

  // 5時間枠として評価 → 6時間前の観測はもう別の枠
  assert.equal(describeWindow(observed, now, { maxAgeMs: FIVE_HOUR_WINDOW_MS }).percent, null);
  // ウィンドウ長を渡さなければ判定材料が無いので落とさない
  assert.equal(describeWindow(observed, now).percent, 23);
});

test("未取得と期限切れは別物として扱う", () => {
  const now = Date.parse("2026-07-30T06:00:00Z");
  const missing = describeWindow(null, now);
  assert.equal(missing.percent, null);
  assert.equal(missing.expired, false);
  assert.equal(missing.observedAt, null);

  // 未取得なら呼び出し側の理由がそのまま出る
  assert.equal(windowReason(missing, "ブリッジが無効です"), "ブリッジが無効です");
});

test("期限切れは「取得できない」ではなく「リセット済み」と説明する", () => {
  const now = Date.parse("2026-07-30T06:00:00Z");
  const view = describeWindow(
    {
      value: { used_percentage: 23, resets_at: Date.parse("2026-07-29T22:30:00Z") / 1000 },
      observedAt: Date.parse("2026-07-29T21:00:00Z"),
    },
    now,
  );

  const reason = windowReason(view, "ブリッジが無効です");
  assert.match(reason, /リセット済み/);
  assert.match(reason, /前の枠は 23%/);
  assert.doesNotMatch(reason, /ブリッジ/, "期限切れの理由がブリッジ未設定にすり替わっている");

  assert.equal(windowReason(view, "x", { short: true }), "リセット済み — 次の更新待ち");
});
