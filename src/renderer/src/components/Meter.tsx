import type { Severity } from "../../../shared/normalize.ts";

const STATUS_VAR: Record<Severity, string> = {
  ok: "var(--status-good)",
  warn: "var(--status-warning)",
  critical: "var(--status-critical)",
};

/**
 * 状態を表す**テキスト**。色だけに意味を持たせないための必須要素。
 *
 * ライトモードでは warning `#fab219` の対サーフェス contrast が 1.79 (3:1 未満) で、
 * dataviz スキルの relief ルールにより「見えるラベル」が義務になる。
 * この語 + 数値ラベルがその relief にあたる。
 */
const STATUS_LABEL: Record<Severity, string> = {
  ok: "余裕",
  warn: "注意",
  critical: "逼迫",
};

/** 色覚に依存しない冗長チャネル。 */
const STATUS_GLYPH: Record<Severity, string> = {
  ok: "✓",
  warn: "!",
  critical: "!!",
};

export interface MeterProps {
  /** sentence case・末尾コロン無し (stat tile 契約)。 */
  label: string;
  /** 0〜100。null = 未取得。0% として描かないこと。 */
  percent: number | null;
  severity: Severity | null;
  /** 「4時間12分後」などのリセット予定。 */
  resetHint: string | null;
  /** 取得できない理由。未取得時にツールチップで示す (指示書 §4)。 */
  unavailableReason?: string;
  stale?: boolean;
}

export function Meter({
  label,
  percent,
  severity,
  resetHint,
  unavailableReason,
  stale = false,
}: MeterProps) {
  const available = percent !== null && severity !== null;
  const color = severity ? STATUS_VAR[severity] : "var(--status-unknown)";

  return (
    <section className={stale ? "stale" : undefined}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
          {label}
        </h2>

        {available ? (
          <div className="flex items-baseline gap-1.5">
            {/* 状態テキスト — 色に頼らない識別チャネル */}
            <span
              className="text-[11px] font-medium tabular-nums"
              style={{ color: "var(--text-secondary)" }}
              aria-label={`状態: ${STATUS_LABEL[severity]}`}
            >
              {STATUS_GLYPH[severity]} {STATUS_LABEL[severity]}
            </span>
            {/* 数値は大きめ・proportional figures (単独の大きな値なので tabular にしない) */}
            <span className="text-[19px] font-semibold" style={{ color: "var(--text-primary)" }}>
              {Math.round(percent)}%
            </span>
          </div>
        ) : (
          <span
            className="cursor-default text-[19px] font-semibold"
            style={{ color: "var(--text-muted)" }}
            title={unavailableReason ?? "データ未取得"}
          >
            —
          </span>
        )}
      </div>

      <div
        className="mt-2"
        style={{ ["--meter-color" as string]: color }}
        role="meter"
        aria-valuenow={available ? Math.round(percent) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="meter-track">
          <div className="meter-fill" style={{ width: `${available ? percent : 0}%` }} />
        </div>
      </div>

      <p className="mt-1.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
        {available ? (resetHint ?? "リセット時刻不明") : (unavailableReason ?? "データ未取得")}
      </p>
    </section>
  );
}
