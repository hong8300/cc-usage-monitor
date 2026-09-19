# Phase 0 — 実機調査結果

調査日: 2026-07-28 JST
調査機: macOS 26.5.2 (Build 25F84) / Apple Silicon (arm64)
調査者: Claude Code

このドキュメントは指示書 §0 の必須事項に対する回答である。
**「実測」= この機体で実際に確認した値。「docs」= 公式ドキュメント由来。「未確認」= 検証できなかった項目。**

---

## 0. サマリ（結論だけ読む人向け）

| 項目 | 結果 |
|---|---|
| `claude --version` | **2.1.220** — `rate_limits` 提供条件（v2.1.80 以降）を満たす |
| `rate_limits` のキー名 | **`five_hour` / `seven_day`** で確定（docs） |
| `used_percentage` の型 | **number（0〜100、小数あり）** — 例 `23.5` |
| `resets_at` の形式 | **Unix epoch 秒（number）** — ISO8601 ではない |
| 認証方式 | **OAuth サブスク認証**（`ANTHROPIC_API_KEY` 未設定、Keychain に資格情報あり）→ `rate_limits` が出る前提を満たす |
| JSONL の `message.usage` キー | 指示書の想定 **＋4個** 追加フィールドあり（後述） |
| モデル ID の日付サフィックス | **現行モデルには存在しない**（`claude-opus-5` 等）→ 指示書 §3-B の前提が古い |
| 重複排除の必要性 | **必須。実測で 89.4% の過大計上**が発生する |
| statusLine 実 JSON ダンプ | ✅ **取得済み（14サンプル）。`rate_limits` の実在を確認** |
| statusLine の `model.id` | ⚠️ **`claude-opus-5[1m]`** — JSONL 側の `claude-opus-5` と**表記が違う**（`[1m]` サフィックス付き） |
| `used_percentage` の実値 | ⚠️ **`14.000000000000002`** という浮動小数点誤差つきの値が実際に出た → **表示前に必ず丸める** |
| フィールドの安定性 | ⚠️ **同一セッション内で `workspace.repo` が出たり消えたりした**（14中4回のみ出現） |
| Windows 側確認 | **未確認**（ユーザー判断により Mac 優先、後回し） |

---

## 1. バージョン・環境（実測）

```
claude --version   → 2.1.220 (Claude Code)
node --version     → v25.6.1
npm --version      → 11.9.0
sw_vers            → macOS 26.5.2 (Build 25F84)
uname -m           → arm64
```

指示書は「`rate_limits` は v2.1.80 以降で提供される、という記述があるため要確認」としていた。
**2.1.220 はこれを大きく上回るため、バージョン要件は満たす。**

### 設定ファイルの現状（実測）

`~/.claude/settings.json`:

```json
{
  "permissions": { "allow": ["Bash(uv run:*)", "Read(//private/tmp/**)"] },
  "model": "opus[1m]",
  "effortLevel": "xhigh",
  "tui": "fullscreen"
}
```

- **`statusLine` キーは現在存在しない。**
  → ブリッジ有効化時は「元コマンドなし」の分岐（指示書 §3-A-3、既定行を出力）に入る。
  ただし将来ユーザーが設定する可能性があるため、パススルー実装は必須のまま。
- `$CLAUDE_CONFIG_DIR` は **未設定**（空）。
- `~/.config/claude/projects` は **存在しない**。
- → 探索ルートは実質 `~/.claude/projects` のみ。ただし指示書どおり3段のフォールバックは実装する。

---

## 2. statusLine 入力 JSON（docs 由来・実 JSON は未取得）

出典: <https://code.claude.com/docs/en/statusline>（2026-07-28 取得）

### 2-1. `rate_limits`（本アプリの主データソース）

```json
"rate_limits": {
  "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
  "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
}
```

指示書 §0-3 が確認を求めた3点への回答:

| 質問 | 回答（docs） |
|---|---|
| キー名は `five_hour` / `seven_day` か | **Yes。確定。** |
| `used_percentage` の型 | **number。0〜100。小数を取りうる**（docs の例が `23.5` / `41.2`）。→ 整数前提の実装は不可 |
| `resets_at` は Unix 秒か ISO8601 か | **Unix epoch 秒（number）**。docs の表現: “Unix epoch seconds when the 5-hour or 7-day rate limit window resets” |

**欠損条件（docs 明記・UI に反映必須）:**

> `rate_limits`: appears only for Claude.ai subscribers (Pro/Max) after the first API response in the session. **Each window (`five_hour`, `seven_day`) may be independently absent.**

→ 指示書 §3-A の制約リストは docs と完全に一致した。**全フィールド optional 扱い**で実装する。
→ `five_hour` はあるが `seven_day` はない、という状態が正規に起こりうる。

**モデル別週次枠（`seven_day_*`）は statusLine には含まれない。** docs のフィールド一覧に存在しない。
→ 指示書 §3-A の「モデル別週次枠は含まれない」は正しい。C（OAuth）を有効化しない限りモデル別は取得不能。

### 2-2. 本アプリが使う他のフィールド（docs 由来）

| フィールド | 型・意味 | 備考 |
|---|---|---|
| `model.id`, `model.display_name` | string | |
| `session_id` | string | |
| `transcript_path` | string | 現セッションの JSONL 絶対パス。**B の集計と A を突き合わせる鍵になる** |
| `version` | string | Claude Code バージョン |
| `workspace.current_dir` / `.project_dir` | string | |
| `cost.total_cost_usd` | number | **クライアント側推定**。docs 明記: “computed client-side. May differ from your actual bill” |
| `cost.total_duration_ms` / `total_api_duration_ms` | number | |
| `cost.total_lines_added` / `total_lines_removed` | number | |
| `context_window.used_percentage` / `.remaining_percentage` | number \| **null** | docs: “may be `null` early in the session” |
| `context_window.context_window_size` | number | 200000 または 1000000 |
| `context_window.current_usage` | object \| **null** | 初回 API 応答前と `/compact` 直後は null |
| `exceeds_200k_tokens` | boolean | |
| `effort.level` | string | `low`〜`max`。モデル非対応時は **キーごと欠損** |
| `fast_mode` | boolean | **料金が変わる**（後述 §4-3） |
| `thinking.enabled` | boolean | |

**`context_window.used_percentage` の定義（docs）:** 入力トークンのみから算出
（`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`）。**`output_tokens` を含まない。**
→ B 側で独自にコンテキスト率を出す場合は同じ式に揃える。

### 2-3. 実 JSON ダンプ — ✅ **取得済み**

`scripts/phase0/enable-dump.js` → プロンプト実行 → `restore.js` で取得。
**14 サンプル**を記録（`~/.cc-usage-monitor/phase0/statusline-dump.log.jsonl`）。
`settings.json` は復元済み（バイト一致を検証、`statusLine` は元どおり不在）。

実際に届いた JSON（1サンプル、全文）:

```json
{
  "session_id": "e01eaead-758b-4ea6-b7de-78022f444b34",
  "transcript_path": "/Users/hong/.claude/projects/-Users-hong-project-2026-ClaudeLCheck/e01eaead-....jsonl",
  "cwd": "/Users/hong/project/2026/ClaudeLCheck",
  "prompt_id": "7ed12c08-cb75-4ddb-89dc-75825336f845",
  "effort": { "level": "xhigh" },
  "session_name": "フォルダ内のファイルを実装",
  "model": { "id": "claude-opus-5[1m]", "display_name": "Opus 5 (1M context)" },
  "workspace": { "current_dir": "...", "project_dir": "...", "added_dirs": [] },
  "version": "2.1.220",
  "output_style": { "name": "default" },
  "cost": {
    "total_cost_usd": 9.763019499999999,
    "total_duration_ms": 1031377, "total_api_duration_ms": 522799,
    "total_lines_added": 481, "total_lines_removed": 1
  },
  "context_window": {
    "total_input_tokens": 462435, "total_output_tokens": 324,
    "context_window_size": 1000000,
    "current_usage": { "input_tokens": 1, "output_tokens": 324,
      "cache_creation_input_tokens": 683, "cache_read_input_tokens": 461751 },
    "used_percentage": 46, "remaining_percentage": 54
  },
  "exceeds_200k_tokens": true,
  "fast_mode": false,
  "thinking": { "enabled": true },
  "rate_limits": {
    "five_hour":  { "used_percentage": 13, "resets_at": 1785208200 },
    "seven_day":  { "used_percentage": 1,  "resets_at": 1785787200 }
  }
}
```

#### 検証できたこと（指示書 §0-3 の目視確認項目）

| 確認項目 | 実測結果 |
|---|---|
| `rate_limits` は存在するか | ✅ **14/14 サンプルすべてに存在**（この機体・この認証方式では確実に出る） |
| キー名 | ✅ **`five_hour` / `seven_day`** — docs と一致 |
| `used_percentage` の型 | ✅ `number`。**実測で `14.000000000000002` が出現**（後述） |
| `resets_at` の形式 | ✅ **Unix epoch 秒**。10桁。下記で裏取り済み |

**`resets_at` の裏取り（秒であることの証明）:**

| 値 | 秒として解釈 | ミリ秒として解釈 |
|---|---|---|
| `1785208200` (five_hour) | 2026-07-28T03:10:00Z = **12:10 JST** | 1970-01-21（明らかに誤り） |
| `1785787200` (seven_day) | 2026-08-03T20:00:00Z = **08-04 05:00 JST** | 1970-01-21（明らかに誤り） |

計測時刻は 2026-07-28 07:58 JST。5時間枠のリセットが約4時間後、週次枠が約6.9日後 —
**どちらもウィンドウ長と整合する。Unix 秒で確定。**

#### ⚠️ 実測で判明した4つの落とし穴（docs だけでは分からなかった）

**(1) `used_percentage` に浮動小数点誤差が乗る**

14サンプル中2件で **`14.000000000000002`** が出現した。
そのまま描画すると Tray に `5h 14.000000000000002%` と表示されてしまう。
→ **表示前に必ず丸める**（`Math.round` または小数1桁固定）。生値は内部保持、表示は整形、と分離する。

**(2) `model.id` に `[1m]` サフィックスが付く — JSONL 側と表記が違う**

| 出所 | 値 |
|---|---|
| statusLine `model.id` | **`claude-opus-5[1m]`** |
| JSONL `message.model` | `claude-opus-5` |

同じモデルなのに**2系統で文字列が違う**。価格表照合の正規化は
`[1m]` などの角括弧サフィックス除去を**先に**噛ませる必要がある（§3-4 の日付サフィックス除去と併せて実装）。

**(3) フィールドは同一セッション内でも出たり消えたりする**

`workspace.repo` を14サンプルで追跡した結果:

```
#1 あり  #2〜#8 なし  #9 あり  #10 あり  #11 なし  #12 あり  #13 なし  #14 なし
```

このリポジトリには `origin` リモートが無く、docs の「no origin remote では absent」という記述からすると
本来ずっと absent のはずだが、**実際には4回だけ現れた。**

→ **「一度取れたフィールドが次のターンで消える」ことが実際に起こる。**
→ ブリッジが `latest.json` を毎回まるごと上書きし、UI がそれを素直に描画すると **UI がチラつく**。
→ 対策: レンダラ側で**フィールド単位の last-known-good を保持**し、
   欠損＝即クリアではなく「前回値 + 取得時刻」を保つ。
   ただし指示書 §4 の表示規則どおり **5分以上古い値はグレーアウト**し、鮮度は必ず明示する。

**(4) 複数セッションが `latest.json` を奪い合い、値が往復する**（追測 2026-09-20）

`statusLine.refreshInterval: 30` を入れると、**起動中の全セッションが** 30秒ごとにブリッジを走らせる。
その tick には API 応答が伴わないので、Claude Code は**そのセッションが最後に受け取った
`rate_limits` をそのまま出し続ける**。つまり放置したセッションは、何時間前の読み値でも 30秒ごとに書く。

実測 (2026-09-20 07:5x, 2セッション同時起動):

```
07:58:05  session A  5h=31  resets_at=1789869000   ← 作業中。現在値
07:58:35  session B  5h=17  resets_at=1789869000   ← 別窓で放置。朝の読み値を再送
07:59:05  session A  5h=31  resets_at=1789869000
```

`latest.json` は最後に書いた者が勝つ一枚なので、メニューバーが **30% → 17% → 30%** と往復した。

→ **鮮度でも期限切れでも弾けない。** B の payload は書かれた瞬間なので mtime は新しく、
   `resets_at` も同じ枠を指している。判定材料は中身しか残らない。
→ 対策: `rate_limits` は**セッション単位ではなくアカウント単位**であり、
   同じ枠 (= 同じ `resets_at`) の中で消費率は減らない。この単調性で古い読み値を落とす。

#### 実装方針（確定）

1. `rate_limits`・各ウィンドウ・各フィールドを**すべて optional** として型定義する。
2. 欠損時は `0%` ではなく **`—`** を表示し、理由をツールチップで示す（指示書 §4 表示規則）。
3. `used_percentage` は `number` として受け `0〜100` にクランプ。**表示時に丸める**（落とし穴1）。
4. `resets_at` は Unix 秒。**ミリ秒と誤認しないこと。** 万一 ISO8601 文字列が来た場合に備え両対応パーサを噛ませる。
5. モデル ID 正規化は `[...]` サフィックス除去 → 完全一致 → 日付サフィックス除去 の順（落とし穴2）。
6. フィールド単位の last-known-good + 取得時刻を保持（落とし穴3）。
7. 未知のキーは破棄せず保持し、デバッグ画面で raw JSON を確認できるようにする。
8. ウィンドウの取り込みは単調性で守る（落とし穴4）。同じ `resets_at` の中で消費率が下がった
   payload、および前の枠の `resets_at` を持つ payload は**採用しない**。値を据え置いたときは
   `observedAt` も据え置き、「その数字をいつ確認したか」を鮮度表示に残す。

#### この機体では確認**できなかった**条件

- **初回 API 応答前に `rate_limits` が absent になる状態**は再現できていない。
  ダンプを仕掛けた時点で既に API 応答済みのセッションだったため、14サンプルすべてに存在した。
  → docs の記述（「初回 API 応答後にのみ出現」）を信頼し、absent 分岐は実装する。
- **API キー認証時に `rate_limits` が出ない**ことも未確認（この機体は OAuth 認証のみ）。

---

## 3. ローカル JSONL（実測）

対象: `~/.claude/projects/**/*.jsonl` — **9 ファイル / 全 5,871 行 / JSON パース失敗 0 行**

### 3-1. `type: "assistant"` 行の `message.usage` キー（実測）

指示書 §0-4 が確認を求めた4キーは**すべて存在**した。加えて**4つの未記載フィールド**があった。

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 10035,
  "cache_read_input_tokens": 20576,
  "output_tokens": 108,
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": {
    "ephemeral_1h_input_tokens": 10035,
    "ephemeral_5m_input_tokens": 0
  },
  "inference_geo": "not_available",
  "iterations": [ { "...": "per-attempt breakdown" } ],
  "speed": "standard"
}
```

| キー | 指示書の想定 | 実測 | コストへの影響 |
|---|---|---|---|
| `input_tokens` | ○ | ✅ あり | 通常単価 |
| `output_tokens` | ○ | ✅ あり | 出力単価 |
| `cache_creation_input_tokens` | ○ | ✅ あり | **1.25x か 2x か は下の `cache_creation` 次第** |
| `cache_read_input_tokens` | ○ | ✅ あり | 0.1x |
| `cache_creation.ephemeral_1h_input_tokens` | 記載なし | ✅ **あり（2,408/2,410 行）** | **2.0x**（1時間 TTL） |
| `cache_creation.ephemeral_5m_input_tokens` | 記載なし | ✅ あり（この機体では常に 0） | **1.25x**（5分 TTL） |
| `speed` | 記載なし | ✅ `"standard"` | `"fast"` なら **Opus 5 は $10/$50** に跳ね上がる |
| `service_tier` | 記載なし | ✅ `"standard"` | batch なら 50% 引き |
| `server_tool_use` | 記載なし | ✅ あり | web検索は別課金（本アプリでは非対象） |

> **これは指示書の前提を1つ覆す重要な発見。**
> `cache_creation_input_tokens` を単一単価で計算すると、この機体では**キャッシュ書き込みコストを 37.5% 過小評価する**
> （実際は全量 1h キャッシュ＝2.0x なのに 1.25x で計算してしまうため）。
> → `pricing.json` は **cacheWrite5m / cacheWrite1h を分離**し、`cache_creation` があればそちらを優先して按分する。

#### この分離が必要であることの実証（Phase 2 で追試）

Claude Code 自身が算出している `cost.total_cost_usd`（statusLine payload）と、
本アプリが同一セッション・同一時点まで集計した金額を突き合わせた。

| 計算方法 | 金額 | Claude Code 自身の値との差 |
|---|---|---|
| Claude Code 自身の `cost.total_cost_usd` | $10.3220 | — |
| **本アプリ（5m/1h を分離）** | **$10.0955** | **−2.19%** |
| 分離せず一律 1.25x（＝指示書どおりの実装） | $8.4331 | **−18.30%** |

→ 分離により誤差が **18.3% → 2.2%** に縮まった。残る −2.2% は statusLine の発火時刻と
JSONL への書き出し時刻のズレ（カットオフ境界の 1〜2 メッセージ分）で説明がつく範囲。
→ **§3-1 の発見は実装上も金額に効く**ことが数値で裏付けられた。

### 3-2. 重複排除（実測）— 指示書の想定どおり、かつ影響は想定以上

| 指標 | 実測値 |
|---|---|
| `type:"assistant"` かつ `message.usage` を持つ行 | **2,410** |
| ユニークな `message.id` + `requestId` | **1,209** |
| 重複キー数 | 771（1キー最大 **7 コピー**） |
| 重複行の usage 値 | **771/771 が完全一致**（差異 0 件） |
| 重複排除なしの総トークン | 574,375,674 |
| 重複排除ありの総トークン | 303,251,587 |
| **過大計上率** | **+89.4%** |

**結論:**
- 重複行は**累積値ではなく同一値の再掲**である。→ **最初の1件を採用**して以降を捨てるのが正しい。
  （指示書は「ストリーミングチャンクは累積値のため」と書いていたが、**実測では累積ではなく同値の重複**だった。
  どちらの理解でも「id+requestId で1件に畳む」実装は同じで正しい。）
- `message.id` + `requestId` の複合キーで**過不足なく畳めた**。

### 3-3. 除外すべき行（実測）

| 条件 | 件数 | 扱い |
|---|---|---|
| `requestId` 欠損 | 2 | **除外** |
| `message.model === "<synthetic>"` | 2 | **除外**（Claude Code がローカル生成した擬似メッセージ。API 課金なし） |
| `isApiErrorMessage: true` | 2 | **除外** |
| `isSidechain: true`（サブエージェント） | 0 | **集計対象に含める**（実トークンを消費するため）。この機体では未出現 |

上記3条件は**同一の2行**を指していた。→ 実装は `requestId` 有無 + `model !== "<synthetic>"` + `!isApiErrorMessage` の AND で足りる。

### 3-4. モデル ID（実測）— **指示書の前提が古い**

```
claude-opus-4-8  : 1,468 行
claude-opus-5    :   940 行
<synthetic>      :     2 行
```

指示書 §3-B は「モデル ID の日付サフィックス（例: `-20250929`）を除去してから価格表に照合」としていたが、
**現行モデルの ID に日付サフィックスは付かない。**（`claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5` …）

→ 実装方針: 日付サフィックス除去は**旧モデル（`claude-3-5-sonnet-20241022` 等）向けの後方互換として残す**が、
まず完全一致を試し、外れた場合のみサフィックス除去 → 再照合、というフォールバック順にする。
未知のモデル ID は**コスト 0 で黙って捨てず、「未知モデル」として件数・トークンを UI に表示**する
（価格表の更新漏れを検知できるようにするため）。

### 3-5. その他（実測）

- `timestamp` は **全行 ISO8601 (`...Z`)**。→ 日次/5時間ブロック集計はこれを使う。
- assistant 行のトップレベルキー: `uuid`, `parentUuid`, `sessionId`, `requestId`, `timestamp`,
  `version`, `cwd`, `gitBranch`, `type`, `message`, `isSidechain`, `effort`, `slug`, `entrypoint` ほか。
- `message` 直下: `id`, `model`, `role`, `type`, `usage`, `content`, `stop_reason`, `stop_details`,
  `container`, `context_management`, `diagnostics`, `stop_sequence`。

---

## 4. 認証・資格情報（実測）

| 項目 | 実測 |
|---|---|
| `ANTHROPIC_API_KEY` | **未設定** |
| `~/.claude/.credentials.json` | **存在しない** |
| macOS Keychain | **存在する** — service `Claude Code-credentials` / account `hong` |

→ この機体は **OAuth サブスクリプション認証**。docs の「`rate_limits` は Claude.ai サブスクライバのみ」条件を満たす。
→ 指示書 §3-C の「macOS: Keychain の `Claude Code-credentials`」という記述は **実測で裏付けられた**。
→ Windows の保存先は **未確認**（§6 参照）。

**本アプリでの扱い（指示書 §6 の禁止事項に従う）:**
トークンは**読まない・保存しない・複製しない**。C（OAuth モード）は既定 OFF、明示オプトイン時のみ参照する。

---

## 5. 法務・コンプライアンス（docs 由来）

出典: <https://code.claude.com/docs/en/legal-and-compliance>（2026-07-28 取得）

該当箇所の**逐語引用**:

> **OAuth authentication** is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and
> Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native
> Anthropic applications.
>
> **Developers** building products or services that interact with Claude's capabilities, including those
> using the Agent SDK, should use API key authentication through Claude Console or a supported cloud
> provider. **Anthropic does not permit third-party developers to offer Claude.ai login or to route
> requests through Free, Pro, or Max plan credentials on behalf of their users.**
>
> Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice.

**読み取り（指示書 §3-C-3 の「未確認」に対する回答）:**

- 明示的に禁止されているのは
  ① 第三者開発者が **Claude.ai ログインを提供**すること、
  ② **ユーザーの代わりに** Free/Pro/Max の資格情報でリクエストを**中継**すること。
- 本アプリは「ユーザー自身のマシンで、ユーザー自身のトークンで、自分の使用量を読むだけ」であり、
  上記①②の字義には**該当しない可能性が高い**。
- ただし OAuth は “ordinary use of Claude Code and **other native Anthropic applications**” に限定されると
  書かれており、**本アプリはネイティブ Anthropic アプリではない。**
- さらに `GET /api/oauth/usage` は**公式ドキュメントに一切記載がない非公開エンドポイント**である
  （docs 内に該当記述なし）。

→ **結論: グレー。「明確に許可されている」とは言えない。**
→ 指示書の判断（**C は既定 OFF・明示オプトイン・警告ダイアログ必須**）は妥当であり、**そのまま踏襲する。**
→ 警告ダイアログには上記引用と法務ドキュメントへのリンクを載せる。
→ **A（statusLine）と B（ローカル JSONL）だけで指示書 §1 の目的の大半は満たせる**ため、C なしを既定とする。

---

## 6. 未確認事項（指示書 §0 末尾の要求により明記）

| # | 未確認項目 | 理由 | 実装側のフォールバック |
|---|---|---|---|
| 1 | ~~statusLine の実 JSON~~ | ✅ **解決済み**（§2-3、14サンプル取得） | — |
| 2 | ~~`rate_limits` がこの機体で出るか~~ | ✅ **解決済み**（14/14 サンプルに存在） | — |
| 2b | **初回 API 応答前**に `rate_limits` が absent になる状態 | ダンプ設置時点で既に応答済みのセッションだった | docs を信頼して absent 分岐を実装。欠損時は `—` + 理由ツールチップ（「Claude Code セッション未起動」/「初回 API 応答前」/「API キー認証では非提供」） |
| 2c | **API キー認証時**に `rate_limits` が出ないこと | この機体は OAuth 認証のみ | 同上 |
| 3 | **Windows** のパス・statusLine 起動方法 | ユーザー判断により後回し（Mac 優先） | パスは `os.homedir()` ベースで解決。Windows 固有分岐は Phase 4 で対応 |
| 4 | Windows の**資格情報保存先** | 同上 | C 自体が既定 OFF のため現時点で影響なし |
| 5 | `GET /api/oauth/usage` の**実レスポンス形状** | 非公開 API・C は既定 OFF のため未検証 | `seven_day_*` を含む未知キーを**汎用ループで表示**する設計（指示書 §3-C 準拠） |
| 6 | `speed: "fast"` 時の JSONL 表現 | この機体では `"standard"` のみ出現 | `speed` を読み、`fast` なら fast 単価を適用。単価不明時は標準単価＋警告バッジ |
| 7 | `service_tier: "batch"` の出現 | 未出現 | 同上（batch は 50% 引きだが Claude Code では通常出ない） |

---

## 7. この調査から確定した設計判断

1. **`pricing.json` は cacheWrite を 5m / 1h で分離する。** §3-1 の実測により必須。
2. **重複排除は `message.id` + `requestId`、最初の1件採用。** §3-2 で妥当性を実証（過大計上 +89.4%）。
3. **モデル ID 正規化は `[...]` 除去 → 完全一致 → 日付サフィックス除去 の順。**
   §2-3(2) で statusLine 側が `claude-opus-5[1m]`、JSONL 側が `claude-opus-5` と判明したため。未知モデルは UI に可視化。
4. **`rate_limits` は全階層 optional。`five_hour` だけ来る状態を正規に扱う。** §2-1（docs 明記）。
5. **`resets_at` は Unix 秒。** ミリ秒と誤解して 1970 年を表示しないこと。§2-3 で実測裏取り済み。
5b. **`used_percentage` は表示前に丸める。** §2-3(1) で `14.000000000000002` を実測。
5c. **フィールド単位の last-known-good を保持する。** §2-3(3) で `workspace.repo` の明滅を実測。
   欠損＝即クリアにすると UI がチラつく。ただし鮮度（◯分前 / 5分でグレーアウト）は必ず併記する。
6. **A 由来（公式）と B 由来（推定）は UI で明確に分離。** B には「推定」バッジ。指示書 §3-B 準拠。
7. **ブリッジは元コマンドのパススルーを実装する。** 現在は未設定だが将来設定されうる。§1。
8. **Windows 対応は Phase 4 に先送り。Phase 1〜3 は macOS で完結させる。**（ユーザー判断）
