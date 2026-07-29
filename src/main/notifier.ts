/**
 * 閾値通知 (指示書 §4: 既定 80% / 95%)。
 *
 * 設計の勘所は**鳴らしすぎないこと**。statusLine はターン毎に届くので、
 * 素直に「閾値を超えていたら通知」にすると 80% を超えた後は毎ターン鳴り続ける。
 *
 *   - 同じウィンドウ・同じ閾値では 1 回だけ鳴らす
 *   - ウィンドウがリセットされたら (resets_at が変わったら) 鳴らし直せるようにする
 *   - 一気に 0% → 96% と飛んだ場合、80 と 95 の 2 通知を出さず**最も高い閾値だけ**鳴らす
 */

import { describeWindow, formatResetHint, type WindowView } from "../shared/normalize.ts";
import {
  FIVE_HOUR_WINDOW_MS,
  SEVEN_DAY_WINDOW_MS,
  type AppSettings,
  type UsageSnapshot,
} from "../shared/types.ts";

type WindowKind = "five_hour" | "seven_day";

const LABEL: Record<WindowKind, string> = {
  five_hour: "セッション枠（5時間）",
  seven_day: "週次枠",
};

interface WindowState {
  /** このウィンドウ実体の識別子。resets_at が変わったら別のウィンドウとみなす。 */
  resetsAt: number | null;
  /** すでに通知済みの閾値 */
  fired: Set<number>;
}

export interface NotifierDeps {
  /** テスト用に差し替えられるようにしておく。 */
  notify: (title: string, body: string) => void;
  now: () => number;
}

/**
 * electron は**遅延読み込み**する。
 *
 * モジュールのトップで import すると、Electron 以外 (素の Node での単体テスト) で
 * 読み込んだ時点で落ちる。通知を差し替えて使う限り electron には触れないので、
 * 実際に鳴らす瞬間まで解決を遅らせる。
 */
function defaultNotify(title: string, body: string): void {
  void import("electron")
    .then((module) => {
      // electron は CJS なので、名前付き export が取れない環境では default 経由で拾う。
      const candidate = module as unknown as {
        Notification?: typeof import("electron").Notification;
        default?: { Notification?: typeof import("electron").Notification };
      };
      const Notification = candidate.Notification ?? candidate.default?.Notification;
      if (!Notification?.isSupported()) return;
      new Notification({ title, body }).show();
    })
    .catch(() => {
      // 通知が出せなくてもアプリは動き続けるべきなので握りつぶす。
    });
}

export class ThresholdNotifier {
  private readonly state = new Map<WindowKind, WindowState>();
  private readonly deps: NotifierDeps;

  constructor(deps: Partial<NotifierDeps> = {}) {
    this.deps = {
      notify: deps.notify ?? defaultNotify,
      now: deps.now ?? (() => Date.now()),
    };
  }

  check(snapshot: UsageSnapshot | null, settings: AppSettings): void {
    if (!snapshot || !settings.notifications.enabled) return;

    const thresholds = [...settings.notifications.thresholds]
      .filter((t) => Number.isFinite(t) && t > 0 && t <= 100)
      .sort((a, b) => a - b);
    if (thresholds.length === 0) return;

    const now = this.deps.now();
    if (settings.notifications.watchFiveHour) {
      const view = describeWindow(snapshot.fiveHour, now, { maxAgeMs: FIVE_HOUR_WINDOW_MS });
      this.evaluate("five_hour", view, thresholds, now);
    }
    if (settings.notifications.watchSevenDay) {
      const view = describeWindow(snapshot.sevenDay, now, { maxAgeMs: SEVEN_DAY_WINDOW_MS });
      this.evaluate("seven_day", view, thresholds, now);
    }
  }

  /** 設定変更などで通知履歴を消したいとき。 */
  reset(): void {
    this.state.clear();
  }

  private evaluate(
    kind: WindowKind,
    view: WindowView,
    thresholds: number[],
    now: number,
  ): void {
    // 期限切れ (percent === null) では鳴らさない。
    // マシンを立ち上げた瞬間に前日の 85% で通知が飛ぶのを防ぐ。
    if (view.percent === null) return;
    // 期限内でも 5分以上更新が無い値は「今まさに超えた」ことの根拠にならない。
    if (view.stale) return;

    const resetsAt = view.resetsAt ? view.resetsAt.getTime() : null;
    let entry = this.state.get(kind);

    // ウィンドウが切り替わった (リセットされた) なら通知履歴を捨てる。
    if (!entry || entry.resetsAt !== resetsAt) {
      entry = { resetsAt, fired: new Set() };
      this.state.set(kind, entry);
    }

    const percent = view.percent;
    // 超えている閾値のうち最も高いものだけを鳴らす。
    const crossed = thresholds.filter((t) => percent >= t);
    if (crossed.length === 0) return;

    const highest = crossed[crossed.length - 1]!;
    if (entry.fired.has(highest)) return;

    // 下位の閾値も鳴らし済みにして、後追いで鳴らないようにする。
    for (const t of crossed) entry.fired.add(t);

    const reset = formatResetHint(view.resetsAt, now);
    const body = `${Math.round(percent)}% を消費しました` + (reset ? `（${reset}）` : "");
    this.deps.notify(`${LABEL[kind]}が ${highest}% を超えました`, body);
  }
}
