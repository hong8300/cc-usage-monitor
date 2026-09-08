/**
 * メニューバー常駐表示。
 *
 * 指示書 §4:
 *   - テキスト `5h 42% · 7d 18%`
 *   - 表示形式は「アイコンのみ / % のみ / 両方」を切替可能
 *   - 〜50% 緑 / 〜80% 橙 / 80%〜 赤
 *   - クリックでポップオーバー
 *   - データが取れない項目は 0% ではなく `—`
 */

import { Menu, Tray, nativeImage } from "electron";
import {
  describeWindow,
  formatAge,
  formatPercent,
  formatResetHint,
  worstSeverity,
  type WindowView,
} from "../shared/normalize.ts";
import {
  FIVE_HOUR_WINDOW_MS,
  SEVEN_DAY_WINDOW_MS,
  STALE_AFTER_MS,
  type AppSettings,
  type UsageSnapshot,
} from "../shared/types.ts";
import { renderTrayIconPng } from "./tray-icon.ts";

/**
 * payload が来なくても表示を評価し直す間隔。
 *
 * Tray はこれまでスナップショット更新でしか再描画していなかったので、
 * Claude Code を触っていない間は昨日の数字が出たまま固まっていた。
 * 枠のリセットは時間の経過だけで起きる以上、時間でも描き直す必要がある。
 */
const TICK_MS = 30_000;

export interface TrayCallbacks {
  onToggleWindow: () => void;
  onOpenSettings: () => void;
  onOpenHelp: () => void;
  onTogglePanelPinned: () => void;
  onSetTrayMode: (mode: AppSettings["tray"]["mode"]) => void;
  onToggleMini: () => void;
  isMiniEnabled: () => boolean;
  onQuit: () => void;
}

export class TrayController {
  private tray: Tray | null = null;
  private snapshot: UsageSnapshot | null = null;
  private settings: AppSettings;
  private readonly callbacks: TrayCallbacks;
  private ticker: NodeJS.Timeout | null = null;

  constructor(settings: AppSettings, callbacks: TrayCallbacks) {
    this.settings = settings;
    this.callbacks = callbacks;
  }

  create(): void {
    const initial = renderTrayIconPng({ percent: null, severity: null });
    this.tray = new Tray(nativeImage.createFromBuffer(initial, { scaleFactor: 2 }));
    this.tray.on("click", () => this.callbacks.onToggleWindow());
    this.render();
    this.renderMenu();

    this.ticker = setInterval(() => this.render(), TICK_MS);
    // 表示更新のためだけにプロセスを生かし続けない。
    this.ticker.unref?.();
  }

  destroy(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.tray?.destroy();
    this.tray = null;
  }

  update(snapshot: UsageSnapshot | null): void {
    this.snapshot = snapshot;
    this.render();
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
    this.render();
    // メニューには表示形式のラジオとミニウィンドウのチェックが載っている。
    // 30秒ごとの render() では組み直さないので、ここで反映する。
    this.renderMenu();
  }

  private view(kind: "five" | "seven", now: number): WindowView {
    return kind === "five"
      ? describeWindow(this.snapshot?.fiveHour, now, { maxAgeMs: FIVE_HOUR_WINDOW_MS })
      : describeWindow(this.snapshot?.sevenDay, now, { maxAgeMs: SEVEN_DAY_WINDOW_MS });
  }

  /** `5h 42% · 7d 18%`。欠損・期限切れは `—`(指示書 §4: 0% ではなく —)。 */
  private titleText(five: WindowView, seven: WindowView): string {
    return `5h ${formatPercent(five.percent) ?? "—"} · 7d ${formatPercent(seven.percent) ?? "—"}`;
  }

  private render(): void {
    if (!this.tray) return;

    const now = Date.now();
    const five = this.view("five", now);
    const seven = this.view("seven", now);

    // アイコンのリングは 5時間枠、色は 2つの枠のうち厳しい方を採る。
    //
    // ただしリングが表しているのは 5時間枠なので、それが不明なときに週次枠の色を
    // 借りてはいけない。トラックも severity 色で薄く敷かれる実装 (tray-icon.ts) のため、
    // 5時間枠が期限切れでも週次枠が緑ならリング全体が緑がかり、
    // 「セッション枠は余裕」と読めてしまう。不明なら unknown 色に落とす。
    const png = renderTrayIconPng({
      percent: five.percent,
      severity: five.percent === null ? null : worstSeverity(five.percent, seven.percent),
    });
    const image = nativeImage.createFromBuffer(png, { scaleFactor: 2 });

    const mode = this.settings.tray.mode;
    this.tray.setImage(mode === "percent" ? nativeImage.createEmpty() : image);
    this.tray.setTitle(mode === "icon" ? "" : this.titleText(five, seven));
    this.tray.setToolTip(this.tooltip(now, five, seven));
  }

  private tooltip(now: number, five: WindowView, seven: WindowView): string {
    const lines: string[] = ["Claude 使用量モニタ"];

    if (!this.snapshot || this.snapshot.lastPayloadAt === null) {
      lines.push("データ未取得 — Claude Code セッションが動き出すと更新されます");
      return lines.join("\n");
    }

    const describe = (label: string, view: WindowView) => {
      if (view.observedAt === null) {
        lines.push(`${label}: — (未取得)`);
        return;
      }
      if (view.expired) {
        // 数字を消すだけだと「なぜ消えたのか」が分からないので、前の枠の値を添える。
        const previous = formatPercent(view.lastKnownPercent);
        lines.push(
          `${label}: — (リセット済み${previous ? ` / 前の枠は ${previous}` : ""}) — 次の更新待ち`,
        );
        return;
      }
      const pct = formatPercent(view.percent) ?? "—";
      const hint = formatResetHint(view.resetsAt, now);
      lines.push(`${label}: ${pct}${hint ? ` (${hint})` : ""}`);
    };

    describe("5時間枠", five);
    describe("週次枠", seven);

    const age = formatAge(this.snapshot.lastPayloadAt, now);
    const stale = now - this.snapshot.lastPayloadAt > STALE_AFTER_MS;
    lines.push(`更新: ${age}${stale ? "（古い可能性あり）" : ""}`);
    return lines.join("\n");
  }

  private renderMenu(): void {
    this.tray?.setContextMenu(this.menu());
  }

  private menu(): Menu {
    return Menu.buildFromTemplate([
      { label: "パネルを開く", click: () => this.callbacks.onToggleWindow() },
      {
        label: "パネルを表示したままにする",
        type: "checkbox",
        checked: !this.settings.panel.autoHide,
        click: () => this.callbacks.onTogglePanelPinned(),
      },
      {
        label: "ミニウィンドウを表示",
        type: "checkbox",
        checked: this.callbacks.isMiniEnabled(),
        click: () => this.callbacks.onToggleMini(),
      },
      { label: "設定…", click: () => this.callbacks.onOpenSettings() },
      { label: "ヘルプ…", click: () => this.callbacks.onOpenHelp() },
      { type: "separator" },
      {
        label: "表示形式",
        submenu: (["both", "percent", "icon"] as const).map((mode) => ({
          label: { both: "アイコン + %", percent: "% のみ", icon: "アイコンのみ" }[mode],
          type: "radio" as const,
          checked: this.settings.tray.mode === mode,
          click: () => this.callbacks.onSetTrayMode(mode),
        })),
      },
      { type: "separator" },
      { label: "終了", click: () => this.callbacks.onQuit() },
    ]);
  }
}
