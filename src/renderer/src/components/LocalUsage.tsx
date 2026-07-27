import { useState } from "react";
import {
  sumTokens,
  type LocalUsageReport,
  type UsageRollup,
} from "../../../shared/usage-types.ts";

/**
 * 大きな数の圧縮表記 (dataviz の stat tile 契約: 1,284 / 12.9K / 4.2M)。
 * 単独の大きな値なので tabular-nums にはしない。
 */
function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function usd(n: number): string {
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`;
}

/**
 * 「推定」バッジ。
 *
 * 指示書 §3-B: A 由来 (statusLine の公式値) と B 由来 (ローカルログからの推定) を
 * 視覚的に区別すること。この系統の数字には必ずこれを付ける。
 */
function EstimateBadge() {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[9px] font-medium"
      style={{
        color: "var(--text-secondary)",
        background: "var(--surface-1)",
        border: "1px dashed var(--hairline)",
      }}
      title="ローカルログから算出した推定値です。API 料金表に基づく概算であり、サブスクリプションの請求額でも公式の枠消費率でもありません。"
    >
      推定
    </span>
  );
}

function Tile({
  label,
  rollup,
}: {
  label: string;
  rollup: UsageRollup;
}) {
  return (
    <div
      className="flex-1 rounded-lg px-3 py-2.5"
      style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
    >
      {/* stat tile 契約: label は sentence case・末尾コロン無し */}
      <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
        {label}
      </p>
      <p className="mt-1 text-[20px] font-semibold" style={{ color: "var(--text-primary)" }}>
        {usd(rollup.costUsd)}
        {rollup.hasUnknownPricing && (
          <span
            className="ml-1 text-[11px] font-normal"
            style={{ color: "var(--status-warning)" }}
            title="価格表に無いモデルが含まれています。実際はこれより高い可能性があります。"
          >
            +?
          </span>
        )}
      </p>
      <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
        {compact(sumTokens(rollup.totals))} tokens · {rollup.totals.messages.toLocaleString()} msg
      </p>
    </div>
  );
}

export function LocalUsage({ report }: { report: LocalUsageReport | null }) {
  const [scope, setScope] = useState<"today" | "week">("today");

  if (!report) {
    return (
      <section
        className="rounded-lg px-3 py-2.5"
        style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
      >
        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          ローカルログを集計中…
        </p>
      </section>
    );
  }

  const rollup = scope === "today" ? report.today : report.last7Days;
  const noData = report.today.totals.messages === 0 && report.last7Days.totals.messages === 0;

  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h2 className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
            ローカル集計
          </h2>
          <EstimateBadge />
        </div>

        {/* 期間切替 */}
        <div className="flex gap-0.5 rounded-md p-0.5" style={{ background: "var(--surface-1)" }}>
          {(["today", "week"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setScope(value)}
              className="rounded px-2 py-0.5 text-[10px] font-medium"
              style={{
                background: scope === value ? "var(--surface-page)" : "transparent",
                color: scope === value ? "var(--text-primary)" : "var(--text-muted)",
              }}
            >
              {value === "today" ? "今日" : "直近7日"}
            </button>
          ))}
        </div>
      </div>

      {noData ? (
        <div
          className="rounded-lg px-3 py-2.5"
          style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
        >
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            集計対象のログが見つかりませんでした（{report.scanned.files} ファイル走査）。
          </p>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <Tile label={scope === "today" ? "今日の推定コスト" : "直近7日の推定コスト"} rollup={rollup} />
          </div>

          {/* モデル別内訳 */}
          <div
            className="rounded-lg px-3 py-2"
            style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
          >
            <p className="mb-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
              モデル別内訳
            </p>
            <ul className="space-y-1">
              {rollup.byModel.map((model) => (
                <li key={model.model} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[11px]" style={{ color: "var(--text-primary)" }}>
                    {model.displayName ?? model.model}
                    {model.unknownPricing && (
                      <span className="ml-1" style={{ color: "var(--status-warning)" }} title="価格表にこのモデルがありません">
                        ⚠
                      </span>
                    )}
                  </span>
                  <span
                    className="shrink-0 text-[11px] tabular-nums"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {compact(sumTokens(model.totals))} ·{" "}
                    {model.costUsd === null ? "価格不明" : usd(model.costUsd)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* トークン内訳。キャッシュ読みが支配的なことが多いので明示する。 */}
          <div
            className="rounded-lg px-3 py-2"
            style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
          >
            <p className="mb-1.5 text-[11px]" style={{ color: "var(--text-secondary)" }}>
              トークン内訳
            </p>
            <ul className="space-y-1">
              {(
                [
                  ["入力", rollup.totals.inputTokens],
                  ["出力", rollup.totals.outputTokens],
                  ["キャッシュ書込 (5分)", rollup.totals.cacheWrite5mTokens],
                  ["キャッシュ書込 (1時間)", rollup.totals.cacheWrite1hTokens],
                  ["キャッシュ読込", rollup.totals.cacheReadTokens],
                ] as const
              )
                .filter(([, value]) => value > 0)
                .map(([label, value]) => (
                  <li key={label} className="flex items-baseline justify-between gap-2">
                    <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      {label}
                    </span>
                    <span
                      className="text-[11px] tabular-nums"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {value.toLocaleString()}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        </>
      )}

      {report.unknownModels.length > 0 && (
        <p className="text-[10px]" style={{ color: "var(--status-warning)" }}>
          ⚠ 価格表に無いモデル: {report.unknownModels.join(", ")} — `src/pricing.json` の更新が必要です
        </p>
      )}

      <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        API 料金表 (最終更新 {report.pricing.lastUpdated}) に基づく概算です。
        サブスクリプションの請求額とも、上の公式な枠消費率とも一致しません。
        {report.pricing.overridePath && <> 価格表の上書きを使用中。</>}
      </p>
    </section>
  );
}
