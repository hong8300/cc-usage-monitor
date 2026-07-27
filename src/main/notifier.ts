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

import { formatCountdown, parseResetsAt } from "../shared/normalize.ts";
import type { AppSettings, RateLimitWindow, UsageSnapshot } from "../shared/types.ts";

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

    if (settings.notifications.watchFiveHour) {
      this.evaluate("five_hour", snapshot.fiveHour?.value ?? null, thresholds);
    }
    if (settings.notifications.watchSevenDay) {
      this.evaluate("seven_day", snapshot.sevenDay?.value ?? null, thresholds);
    }
  }

  /** 設定変更などで通知履歴を消したいとき。 */
  reset(): void {
    this.state.clear();
  }

  private evaluate(kind: WindowKind, window: RateLimitWindow | null, thresholds: number[]): void {
    if (!window || typeof window.used_percentage !== "number") return;

    const resetsAt = typeof window.resets_at === "number" ? window.resets_at : null;
    let entry = this.state.get(kind);

    // ウィンドウが切り替わった (リセットされた) なら通知履歴を捨てる。
    if (!entry || entry.resetsAt !== resetsAt) {
      entry = { resetsAt, fired: new Set() };
      this.state.set(kind, entry);
    }

    const percent = window.used_percentage;
    // 超えている閾値のうち最も高いものだけを鳴らす。
    const crossed = thresholds.filter((t) => percent >= t);
    if (crossed.length === 0) return;

    const highest = crossed[crossed.length - 1]!;
    if (entry.fired.has(highest)) return;

    // 下位の閾値も鳴らし済みにして、後追いで鳴らないようにする。
    for (const t of crossed) entry.fired.add(t);

    const reset = formatCountdown(parseResetsAt(window.resets_at), this.deps.now());
    const body =
      `${Math.round(percent)}% を消費しました` + (reset ? `（${reset}にリセット）` : "");
    this.deps.notify(`${LABEL[kind]}が ${highest}% を超えました`, body);
  }
}
