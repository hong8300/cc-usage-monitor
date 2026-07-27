import type { AppPaths } from "../../../shared/ipc.ts";
import type { AppSettings, BridgeState } from "../../../shared/types.ts";

/** 設定画面 (指示書 §4 設定)。 */

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-[12px]" style={{ color: "var(--text-primary)" }}>
          {label}
        </p>
        {hint && (
          <p className="mt-0.5 text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            {hint}
          </p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-[20px] w-[34px] rounded-full transition-colors disabled:opacity-40"
      style={{
        background: checked ? "var(--status-good)" : "var(--hairline)",
      }}
    >
      {/* left を明示しないと静的位置に依存してつまみが枠からはみ出す。 */}
      <span
        className="absolute top-[2px] left-[2px] h-[16px] w-[16px] rounded-full transition-transform"
        style={{
          background: "#ffffff",
          transform: checked ? "translateX(14px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

function Select<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <select
      value={String(value)}
      onChange={(event) => {
        const picked = options.find((o) => String(o.value) === event.target.value);
        if (picked) onChange(picked.value);
      }}
      className="rounded-md px-2 py-1 text-[11px]"
      style={{
        background: "var(--surface-1)",
        color: "var(--text-primary)",
        border: "1px solid var(--hairline)",
      }}
    >
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Settings({
  settings,
  bridge,
  paths,
  busy,
  onChange,
  onToggleBridge,
  onReveal,
}: {
  settings: AppSettings;
  bridge: BridgeState | null;
  paths: AppPaths | null;
  busy: boolean;
  onChange: (next: AppSettings) => void;
  onToggleBridge: () => void;
  onReveal: (target: string) => void;
}) {
  const patch = (partial: Partial<AppSettings>) => onChange({ ...settings, ...partial });
  const bridgeEnabled = bridge?.status === "enabled";

  return (
    <div className="space-y-4">
      {/* --- 表示 --- */}
      <section>
        <h2 className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
          表示
        </h2>
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <Row label="メニューバーの表示形式">
            <Select
              value={settings.tray.mode}
              onChange={(mode) => patch({ tray: { ...settings.tray, mode } })}
              options={[
                { value: "both" as const, label: "アイコン + %" },
                { value: "percent" as const, label: "% のみ" },
                { value: "icon" as const, label: "アイコンのみ" },
              ]}
            />
          </Row>
          <Row label="テーマ">
            <Select
              value={settings.theme}
              onChange={(theme) => patch({ theme })}
              options={[
                { value: "system" as const, label: "システムに合わせる" },
                { value: "light" as const, label: "ライト" },
                { value: "dark" as const, label: "ダーク" },
              ]}
            />
          </Row>
        </div>
      </section>

      {/* --- 通知 --- */}
      <section>
        <h2 className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
          通知
        </h2>
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <Row
            label="閾値通知"
            hint="同じウィンドウ・同じ閾値では 1 回だけ通知します。リセットされると再び通知します。"
          >
            <Toggle
              checked={settings.notifications.enabled}
              onChange={(enabled) =>
                patch({ notifications: { ...settings.notifications, enabled } })
              }
            />
          </Row>
          <Row label="通知する消費率" hint="複数指定した場合、一番高い閾値だけを通知します。">
            <div className="flex gap-1">
              {[70, 80, 90, 95].map((threshold) => {
                const on = settings.notifications.thresholds.includes(threshold);
                return (
                  <button
                    key={threshold}
                    type="button"
                    disabled={!settings.notifications.enabled}
                    onClick={() =>
                      patch({
                        notifications: {
                          ...settings.notifications,
                          thresholds: on
                            ? settings.notifications.thresholds.filter((t) => t !== threshold)
                            : [...settings.notifications.thresholds, threshold].sort((a, b) => a - b),
                        },
                      })
                    }
                    className="rounded px-1.5 py-0.5 text-[10px] tabular-nums disabled:opacity-40"
                    style={{
                      background: on ? "var(--status-warning)" : "var(--surface-1)",
                      color: on ? "#0b0b0b" : "var(--text-muted)",
                      border: "1px solid var(--hairline)",
                    }}
                  >
                    {threshold}%
                  </button>
                );
              })}
            </div>
          </Row>
          <Row label="対象の枠">
            <div className="flex gap-1">
              {(
                [
                  ["watchFiveHour", "5時間"],
                  ["watchSevenDay", "週次"],
                ] as const
              ).map(([key, label]) => {
                const on = settings.notifications[key];
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    disabled={!settings.notifications.enabled}
                    onClick={() =>
                      patch({
                        notifications: { ...settings.notifications, [key]: !on },
                      })
                    }
                    className="rounded px-1.5 py-0.5 text-[10px] disabled:opacity-40"
                    style={{
                      background: "var(--surface-1)",
                      color: on ? "var(--text-primary)" : "var(--text-muted)",
                      // 選択状態を色だけに委ねない (✓ を併記する)
                      border: `1px solid ${on ? "var(--status-good)" : "var(--hairline)"}`,
                    }}
                  >
                    {on ? "✓ " : ""}
                    {label}
                  </button>
                );
              })}
            </div>
          </Row>
        </div>
      </section>

      {/* --- 更新 --- */}
      <section>
        <h2 className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
          更新
        </h2>
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <Row
            label="statusLine の再実行間隔"
            hint="既定では Claude Code の操作時にしか更新されません。設定すると起動中は一定間隔で更新されます。ブリッジ有効時のみ反映。"
          >
            <Select
              value={settings.statusLineRefreshSeconds ?? 0}
              onChange={(seconds) =>
                patch({ statusLineRefreshSeconds: seconds === 0 ? null : Number(seconds) })
              }
              options={[
                { value: 0, label: "設定しない" },
                { value: 10, label: "10 秒" },
                { value: 30, label: "30 秒" },
                { value: 60, label: "1 分" },
              ]}
            />
          </Row>
          <Row label="ローカル集計の再スキャン間隔" hint="ファイル監視の取りこぼしに対する保険です。">
            <Select
              value={settings.localRefreshSeconds}
              onChange={(localRefreshSeconds) => patch({ localRefreshSeconds })}
              options={[
                { value: 0, label: "監視のみ" },
                { value: 60, label: "1 分" },
                { value: 300, label: "5 分" },
                { value: 900, label: "15 分" },
              ]}
            />
          </Row>
        </div>
      </section>

      {/* --- 起動 --- */}
      <section>
        <h2 className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
          起動
        </h2>
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <Row label="ログイン時に自動起動">
            <Toggle
              checked={settings.launchAtLogin}
              onChange={(launchAtLogin) => patch({ launchAtLogin })}
            />
          </Row>
        </div>
      </section>

      {/* --- ブリッジ --- */}
      <section>
        <h2 className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
          statusLine ブリッジ
        </h2>
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <Row
            label="ブリッジを有効化"
            hint="~/.claude/settings.json の statusLine を書き換えます。書き換え前に全文バックアップを取り、無効化で元に戻します。"
          >
            <Toggle checked={bridgeEnabled} disabled={busy} onChange={onToggleBridge} />
          </Row>
          {bridge?.status === "foreign" && (
            <p className="pb-2 text-[10px]" style={{ color: "var(--status-warning)" }}>
              ⚠ 別の statusLine 設定が使われています: <code>{bridge.command}</code>
              <br />
              有効化すると既存コマンドを包んで実行し、無効化で元に戻します。
            </p>
          )}
          {bridge?.status === "error" && (
            <p className="pb-2 text-[10px]" style={{ color: "var(--status-critical)" }}>
              ⚠ {bridge.message}
            </p>
          )}
          {paths && (
            <div className="flex flex-wrap gap-1 pb-2">
              {(
                [
                  ["バックアップ", paths.backupDir],
                  ["ブリッジ", paths.bridge],
                  ["ログ", paths.log],
                ] as const
              ).map(([label, target]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => onReveal(target)}
                  className="rounded px-1.5 py-0.5 text-[10px]"
                  style={{
                    background: "var(--surface-1)",
                    color: "var(--text-secondary)",
                    border: "1px solid var(--hairline)",
                  }}
                >
                  {label}を開く
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* --- OAuth モード (Phase 5・未実装) --- */}
      <section>
        <h2 className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
          OAuth モード（未実装・既定 OFF）
        </h2>
        <div style={{ borderTop: "1px solid var(--hairline)" }}>
          <Row label="非公式エンドポイントから取得" hint="現在このビルドには実装されていません。">
            <Toggle checked={false} disabled onChange={() => {}} />
          </Row>
          <p className="pb-2 text-[10px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
            モデル別の週次枠を取得するには非公開の OAuth エンドポイントを叩く必要があります。
            公式ドキュメントに記載が無く予告なく変更されうること、
            また Anthropic の法務文書が OAuth 認証を「Claude Code および Anthropic 純正アプリ」に
            限定していることから、既定 OFF の明示オプトイン機能として Phase 5 で扱います。
          </p>
        </div>
      </section>
    </div>
  );
}
