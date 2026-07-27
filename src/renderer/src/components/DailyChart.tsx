import { useState } from "react";
import { sumTokens, type DailyUsage } from "../../../shared/usage-types.ts";

/**
 * 直近 7 日の日次消費バーチャート (指示書 §4 履歴)。
 *
 * dataviz の mark spec に従う:
 *   - バーは細く (≤24px)、**データ端 4px 角丸・ベースライン側は角張らせる**
 *   - 隣接バーの間はサーフェス色の 2px ギャップ
 *   - グリッド/軸は 1px ソリッドの控えめなグレー (破線にしない)
 *   - 単系列なので凡例は置かない (タイトルが系列名を兼ねる)
 *   - 全点にラベルを振らず、直接ラベルは選択的に
 *   - hover ツールチップは既定で載せる
 *
 * 色は状態色 (緑/橙/赤) ではなく categorical slot 1 の青を使う。
 * ここが表すのは「状態」ではなく「量」なので、状態色を流用すると
 * 閾値の意味を誤って示唆してしまう。
 */

interface Props {
  daily: DailyUsage[];
  /** 何日ぶん表示するか */
  days?: number;
}

function shortDate(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function weekdayOf(iso: string): string {
  return ["日", "月", "火", "水", "木", "金", "土"][new Date(`${iso}T00:00:00`).getDay()] ?? "";
}

export function DailyChart({ daily, days = 7 }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);

  // 欠けている日も 0 として並べる。歯抜けだと「使わなかった日」が見えない。
  const today = new Date();
  const series: DailyUsage[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    series.push(
      daily.find((entry) => entry.date === key) ?? {
        date: key,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 0,
          cacheWriteUnsplitTokens: 0,
          messages: 0,
        },
        costUsd: 0,
        hasUnknownPricing: false,
      },
    );
  }

  const max = Math.max(...series.map((d) => d.costUsd), 0.01);
  const todayKey = series[series.length - 1]?.date;
  const active = series.find((d) => d.date === hovered) ?? null;

  return (
    <section>
      <div className="flex items-baseline justify-between gap-2">
        {/* 単系列なので、このタイトルが系列名を兼ねる (凡例は置かない) */}
        <h2 className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
          直近{days}日の推定コスト
        </h2>
        {/* hover 中はその日の値、そうでなければピーク日を直接ラベルとして出す */}
        <span className="text-[11px] tabular-nums" style={{ color: "var(--text-muted)" }}>
          {active
            ? `${shortDate(active.date)}（${weekdayOf(active.date)}） $${active.costUsd.toFixed(2)} · ${sumTokens(active.totals).toLocaleString()} tok`
            : `ピーク $${max.toFixed(2)}`}
        </span>
      </div>

      <div
        className="mt-2 rounded-lg px-3 pt-3 pb-2"
        style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
      >
        {/* プロット領域。gap-[2px] が「サーフェス色の 2px ギャップ」にあたる。 */}
        <div
          className="flex h-[72px] items-end gap-[2px]"
          style={{ borderBottom: "1px solid var(--hairline)" }}
          onMouseLeave={() => setHovered(null)}
        >
          {series.map((day) => {
            const ratio = day.costUsd / max;
            const isToday = day.date === todayKey;
            const isHovered = day.date === hovered;
            return (
              <button
                key={day.date}
                type="button"
                // ヒット領域はバーより大きく取る (列全体)
                className="group flex h-full flex-1 cursor-default items-end"
                onMouseEnter={() => setHovered(day.date)}
                onFocus={() => setHovered(day.date)}
                onBlur={() => setHovered(null)}
                aria-label={`${day.date} 推定コスト $${day.costUsd.toFixed(2)}`}
              >
                <div
                  className="w-full"
                  style={{
                    // 0 の日も存在が分かるよう最低 2px は描く
                    height: `${Math.max(ratio * 100, day.costUsd > 0 ? 4 : 2)}%`,
                    // ≤24px の上限。7 本なので実際はこれより細い
                    maxWidth: 24,
                    margin: "0 auto",
                    background: day.costUsd > 0 ? "var(--series-1)" : "var(--hairline)",
                    // データ端 (上) だけ 4px 角丸、ベースライン (下) は角張らせる
                    borderRadius: "4px 4px 0 0",
                    opacity: isHovered || active === null ? 1 : 0.45,
                    outline: isToday ? "1px solid var(--series-1)" : undefined,
                    outlineOffset: 1,
                    transition: "opacity 120ms ease-out",
                  }}
                />
              </button>
            );
          })}
        </div>

        {/* 軸ラベル。全部出すと詰まるので日付のみ、今日だけ強調する。 */}
        <div className="mt-1 flex gap-[2px]">
          {series.map((day) => (
            <span
              key={day.date}
              className="flex-1 text-center text-[9px] tabular-nums"
              style={{
                color: day.date === todayKey ? "var(--text-secondary)" : "var(--text-muted)",
                fontWeight: day.date === todayKey ? 600 : 400,
              }}
            >
              {shortDate(day.date)}
            </span>
          ))}
        </div>
      </div>

      <p className="mt-1.5 text-[10px]" style={{ color: "var(--text-muted)" }}>
        今日（{shortDate(todayKey ?? "")}）は進行中のため途中の値です。
      </p>
    </section>
  );
}
