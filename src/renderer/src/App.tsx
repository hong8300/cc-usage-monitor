import { useCallback, useEffect, useState } from "react";
import {
  formatAge,
  formatCountdown,
  parseResetsAt,
  severityFor,
} from "../../shared/normalize.ts";
import { STALE_AFTER_MS, type BridgeState, type UsageSnapshot } from "../../shared/types.ts";
import type { LocalUsageReport } from "../../shared/usage-types.ts";
import { LocalUsage } from "./components/LocalUsage.tsx";
import { Meter } from "./components/Meter.tsx";

/** 1秒ごとに再描画するための now。カウントダウンと鮮度表示に使う。 */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function App() {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [bridge, setBridge] = useState<BridgeState | null>(null);
  const [localReport, setLocalReport] = useState<LocalUsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  useEffect(() => {
    void window.monitor.getSnapshot().then(setSnapshot);
    void window.monitor.getBridgeState().then(setBridge);
    void window.monitor.getLocalReport().then(setLocalReport);
    const offSnapshot = window.monitor.onSnapshot(setSnapshot);
    const offBridge = window.monitor.onBridgeState(setBridge);
    const offLocal = window.monitor.onLocalReport(setLocalReport);
    return () => {
      offSnapshot();
      offBridge();
      offLocal();
    };
  }, []);

  const toggleBridge = useCallback(async () => {
    setBusy(true);
    try {
      const next =
        bridge?.status === "enabled"
          ? await window.monitor.disableBridge()
          : await window.monitor.enableBridge();
      setBridge(next);
    } finally {
      setBusy(false);
    }
  }, [bridge]);

  const lastAt = snapshot?.lastPayloadAt ?? null;
  const stale = lastAt !== null && now - lastAt > STALE_AFTER_MS;

  // 未取得の理由を具体的に出す (指示書 §4: 理由をツールチップで示す)。
  const unavailableReason =
    bridge?.status !== "enabled"
      ? "ブリッジが無効です。下のトグルで有効化してください"
      : lastAt === null
        ? "Claude Code セッション未起動 — セッションが動き出すと更新されます"
        : "セッション初回の API 応答前、または Pro/Max 契約以外では取得できません";

  const five = snapshot?.fiveHour?.value ?? null;
  const seven = snapshot?.sevenDay?.value ?? null;

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: "var(--surface-page)" }}
    >
      <header
        className="drag-region flex items-center justify-between px-4 pt-3 pb-2"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        <div>
          <h1 className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
            Claude 使用量
          </h1>
          <p className="mt-0.5 text-[11px]" style={{ color: "var(--text-muted)" }}>
            {/* 指示書 §4: データソースと最終更新時刻を必ず出す */}
            出所 statusLine ·{" "}
            {lastAt === null ? "未取得" : `更新 ${formatAge(lastAt, now)}`}
            {stale && " · 古い可能性あり"}
          </p>
        </div>
        <SourceBadge bridge={bridge} />
      </header>

      <main className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <Meter
          label="セッション枠（5時間）"
          percent={five?.used_percentage ?? null}
          severity={severityFor(five?.used_percentage)}
          resetHint={
            formatCountdown(parseResetsAt(five?.resets_at), now)
              ? `${formatCountdown(parseResetsAt(five?.resets_at), now)}にリセット`
              : null
          }
          unavailableReason={unavailableReason}
          stale={stale}
        />

        <Meter
          label="週次枠（全モデル合計）"
          percent={seven?.used_percentage ?? null}
          severity={severityFor(seven?.used_percentage)}
          resetHint={formatResetDate(parseResetsAt(seven?.resets_at), now)}
          unavailableReason={unavailableReason}
          stale={stale}
        />

        <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          モデル別の週次枠は statusLine では取得できません。
        </p>

        {/* ここから下はローカルログ由来の推定値。上の公式値と区切り線で明確に分ける
            (指示書 §3-B: A 由来と B 由来を視覚的に区別すること)。 */}
        <div style={{ borderTop: "1px solid var(--hairline)" }} className="pt-4">
          <LocalUsage report={localReport} />
        </div>
      </main>

      <footer
        className="no-drag px-4 py-3"
        style={{ borderTop: "1px solid var(--hairline)" }}
      >
        <BridgeToggle bridge={bridge} busy={busy} onToggle={toggleBridge} />
      </footer>
    </div>
  );
}

/** 指示書 §4: ヘッダにデータソースを出す。Phase 2 以降で「推定」「OAuth」が増える。 */
function SourceBadge({ bridge }: { bridge: BridgeState | null }) {
  const enabled = bridge?.status === "enabled";
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={{
        color: enabled ? "var(--status-good)" : "var(--text-muted)",
        background: enabled
          ? "color-mix(in oklab, var(--status-good) 14%, var(--surface-1))"
          : "var(--surface-1)",
        border: "1px solid var(--hairline)",
      }}
    >
      {enabled ? "statusLine 接続中" : "未接続"}
    </span>
  );
}

function BridgeToggle({
  bridge,
  busy,
  onToggle,
}: {
  bridge: BridgeState | null;
  busy: boolean;
  onToggle: () => void;
}) {
  if (bridge?.status === "foreign") {
    return (
      <div className="space-y-2">
        <p className="text-[11px]" style={{ color: "var(--status-warning)" }}>
          ⚠ 別の statusLine 設定が使われています。上書きせずに残しています。
        </p>
        <code
          className="block truncate rounded px-2 py-1 text-[10px]"
          style={{ background: "var(--surface-1)", color: "var(--text-secondary)" }}
          title={bridge.command}
        >
          {bridge.command}
        </code>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          className="w-full rounded-md px-3 py-2 text-[12px] font-medium disabled:opacity-50"
          style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)" }}
        >
          既存コマンドを包んでブリッジを有効化
        </button>
      </div>
    );
  }

  if (bridge?.status === "error") {
    return (
      <p className="text-[11px]" style={{ color: "var(--status-critical)" }}>
        ⚠ {bridge.message}
      </p>
    );
  }

  const enabled = bridge?.status === "enabled";

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className="w-full rounded-md px-3 py-2 text-[12px] font-medium disabled:opacity-50"
        style={{
          background: enabled ? "var(--surface-1)" : "var(--status-good)",
          color: enabled ? "var(--text-primary)" : "#ffffff",
          border: "1px solid var(--hairline)",
        }}
      >
        {busy ? "処理中…" : enabled ? "ブリッジを無効化" : "ブリッジを有効化"}
      </button>
      <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
        有効化すると ~/.claude/settings.json の statusLine を書き換えます。
        書き換え前に全文バックアップを取り、無効化で元に戻します。
        {enabled && bridge.wrappedCommand && (
          <>
            <br />
            元のコマンドを包んで実行中: <code>{bridge.wrappedCommand}</code>
          </>
        )}
      </p>
    </div>
  );
}

/** 週次枠は日単位なので日付も添える。 */
function formatResetDate(date: Date | null, now: number): string | null {
  if (!date) return null;
  const countdown = formatCountdown(date, now);
  const label = date.toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${label} にリセット${countdown ? `（${countdown}）` : ""}`;
}
