import type { ReactNode } from "react";

interface HelpProps {
  version: string | null;
}

/** Tray メニューから開く、アプリ内の簡易マニュアルとVersion情報。 */
export function Help({ version }: HelpProps) {
  return (
    <div className="space-y-5 text-[12px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
      <section>
        <h2 className="text-[14px] font-semibold" style={{ color: "var(--text-primary)" }}>
          Claude 使用量モニタ
        </h2>
        <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          Version {version ?? "—"}
        </p>
      </section>

      <HelpSection title="はじめに">
        <ol className="list-decimal space-y-1 pl-5">
          <li>パネル下部の「ブリッジを有効化」を押します。</li>
          <li>Claude Codeで何か1回やり取りします。</li>
          <li>メニューバーのリングとパネルに使用量が表示されます。</li>
        </ol>
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
          ブリッジはClaude CodeのstatusLineから使用量を受け取ります。設定変更前には自動でバックアップを作成します。
        </p>
      </HelpSection>

      <HelpSection title="基本操作">
        <dl className="space-y-2">
          <HelpItem term="詳しく見る">メニューバーのアイコンをクリックします。</HelpItem>
          <HelpItem term="パネルを固定">上部の「表示を固定」を押すと、ほかの場所をクリックしても閉じません。</HelpItem>
          <HelpItem term="小窓を表示">アイコンを右クリックし、「ミニウィンドウを表示」を選びます。</HelpItem>
          <HelpItem term="設定を変更">パネル右上の「設定」、または右クリックメニューの「設定…」を選びます。</HelpItem>
        </dl>
      </HelpSection>

      <HelpSection title="数字が更新されないとき">
        <ul className="list-disc space-y-1 pl-5">
          <li>ブリッジが有効か確認してください。</li>
          <li>Claude Codeで1回やり取りしてください。</li>
          <li>Claude Code v2.1.80以降、Node.js、ProまたはMax契約が必要です。</li>
          <li>5分以上古い数字は薄く表示されます。</li>
        </ul>
      </HelpSection>

      <p className="rounded-md px-3 py-2 text-[11px]" style={{ background: "var(--surface-1)" }}>
        使用量データはローカルで処理され、外部サーバーへ送信されません。
      </p>
    </div>
  );
}

function HelpSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function HelpItem({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium" style={{ color: "var(--text-primary)" }}>
        {term}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
