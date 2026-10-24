# テスト

PC で開発するときの自動テストです。スマホだけで運用している場合は実行不要です。

```
test/
  test.html        ブラウザで開くだけの単体テスト（QR解析・重複検知・集計）
  harness/         GAS を Node 上で動かす検証（gas/*.gs を実際に読み込む）
  pw/              管理画面をブラウザで動かすスモークテスト
```

## 実行方法

```bash
# 1) GAS のロジック（Node だけで動く・数秒）
node test/harness/all.js

# 2) 管理画面（Playwright と Chromium が必要）
node test/pw/smoke.js
```

`test/test.html` はブラウザで直接開いても確認できます（`node test/pw/smoke.js` の中でも実行しています）。

Playwright が入っていない環境では `test/pw/smoke.js` はスキップして正常終了します。導入する場合:

```bash
npm i -D playwright && npx playwright install chromium
```

## harness が何をしているか

`test/harness/gas-stub.js` が `SpreadsheetApp` / `FormApp` / `LockService` / `PropertiesService` / `MailApp` / `DriveApp` などを
メモリ上で模擬し、`gas/*.gs` を `vm` で読み込んで**本物の関数を実行**します。関数をモックして
その戻り値を確かめるテストではありません。

本番と食い違うとテストが通って本番で落ちるため、スタブはあえて「本物と同じ厳しさ」にしてあります。

| スタブの挙動 | 理由 |
|---|---|
| `LockService` が再入で例外になる | 本番の ScriptLock は再入不可。`takeBackup_` をロック内から呼ぶ設計の回帰を守る |
| `SpreadsheetApp.getUi()` が例外になる | スタンドアロンのスクリプトでは必ず例外。`initializeSpreadsheet` の無言上書きを検出する |
| `getRange('A1:B2')` の値の読み書きが例外になる | A1記法で別のセルを触るコードを検出する（書式設定だけは素通り） |
| `Utilities.formatDate` が秒まで置換する | `BK_yyyyMMdd_HHmmss` の採番が同一分内で衝突しないことを確かめる |
| `FormApp.create()` が**未公開**のフォームを作る | 未公開のフォームは回答を受け付けない。コードが明示的に公開していなければ落ちる |
| `SpreadsheetApp.create()` が別のスプレッドシートを作る | 既存のものを返すと上書き事故を再現できない |
| 時計を `__setNow` / `__advance` で固定できる | 採番や更新日時を決定的に検証する |

## スイートの内容

| ファイル | 守っていること |
|---|---|
| `harness/core.js` | 入荷・出荷の反映、分納の納期順消し込み、箱台帳の採番、ラベルPDF、安心在庫割れ通知、冪等性、入力検証、ロック取得失敗時の再処理 |
| `harness/setup.js` | `setupFormIntegration` の通しと再実行の安全性、**フォームが公開状態で作られること**、**`initializeSpreadsheet` が既存データへのリンクを黙って失わないこと** |
| `harness/inventory.js` | 棚卸の**「空欄」と「0」の区別**、部分棚卸、**解析エラーでバックアップ世代を消費しないこと**、復元との往復 |
| `harness/product.js` | 商品コードの検証（英大文字1〜12文字）、大文字小文字を無視した重複拒否、既定値、選択肢同期の失敗時の記録 |
| `harness/backup.js` | 採番の同秒衝突、保持世代の整理、プレビューの分類、範囲別の復元と取り消し、**ロック内から呼んでも止まらないこと** |
| `harness/webactions.js` | `doGet` 経由の全アクション、`data` の二重デコード対策、`addHistoryBatch` の並びと上限、`getFormConfig` |
| `pw/smoke.js` | 管理画面のフォームカード4枚、バックアップ画面のプレビュー→復元、**在庫の上書き事故の防止**、**GASがHTMLを返したときに保存成功と表示しないこと**、API無効時に何も壊れないこと |

## テストを足すとき

`harness/fixtures.js` の `boot()` が商品管理・履歴・設定・入力者・回答シートを用意します。

```js
const F = require('./fixtures');
const ctx = F.boot({ sheets: ['inv'] });          // 棚卸の回答シートも作る
const row = F.addRow(F.sheetOf(ctx, 'inv'), { 'タイムスタンプ': new Date(), ... });
ctx.processResponseRow_(F.sheetOf(ctx, 'inv'), row, {});
F.productRow(ctx, 'HEALTH');                       // 商品管理の行を見る
```

**新しいテストを書いたら、直した箇所をいったん元に戻して落ちることを確かめてください。**
落ちないテストは何も守っていません。
