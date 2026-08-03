# 📡 わろたんてな

5ちゃんねるまとめサイトの新着記事を1画面に集める、**自分用まとめアンテナ**([ワロタあんてな](https://matomeantena.com/) 風)。

- 📱 **スマホ最適化 + PWA** — ホーム画面に追加すればアプリとして使える
- 🚫 **広告なし** — このアプリ自体には広告が一切ない(記事タップで開く元サイト側の広告は元サイト次第)
- 💰 **完全無料・サーバー不要** — GitHub Actions が30分ごとに RSS を取得し、GitHub Pages で配信
- 🌙 ダークモード自動対応 / プルリフレッシュ / 検索 / NGワード / サイト別表示切替 / 既読管理

## 初回セットアップ(1回だけ)

1. この変更を **main ブランチにマージ**する
2. リポジトリの **Settings → Pages** を開き、**Source を「GitHub Actions」** に設定する
3. **Actions タブ → `update` ワークフロー → 「Run workflow」** で手動実行する(以後は30分ごとに自動実行)
4. 完了すると `https://<ユーザー名>.github.io/warota/` で開ける

> ⏰ 定期実行(スケジュール)は **デフォルトブランチ(main)にワークフローがあるときだけ**動きます。手順1のマージを忘れずに。
> また、リポジトリに60日間pushがないとGitHubがスケジュール実行を自動停止します。その場合はActionsタブから再有効化してください。

## スマホのホーム画面に追加(アプリ化)

- **iPhone (Safari)**: ページを開く → 共有ボタン → **「ホーム画面に追加」**
- **Android (Chrome)**: ページを開く → メニュー(⋮) → **「ホーム画面に追加」** または「アプリをインストール」

## 使い方

| 操作 | 機能 |
|---|---|
| 記事をタップ | 元サイトを新しいタブで開く(開いた記事はグレー表示) |
| 上部のタブ | カテゴリで絞り込み(総合 / ニュース / VIP / ゲーム…) |
| 🔍 | タイトル検索 |
| ↻ / 下に引っ張る | 手動更新(5分ごとに自動更新もされます) |
| ⚙ | NGワード、表示サイトの選択、既読を隠す、既読リセット |

## 収集サイトのカスタマイズ

[`feeds.json`](feeds.json) を編集して push するだけです。

```json
{ "name": "サイト名", "url": "https://example.com/index.rdf", "category": "総合" }
```

- livedoor系まとめブログの RSS は大抵 `https://ブログのURL/index.rdf`
- カテゴリは自由文字列。同じ文字列同士が1つのタブにまとまります
- 取得に失敗したサイトは自動でスキップされます(Actions のログで確認可能)

## 更新頻度を変える

[`.github/workflows/update.yml`](.github/workflows/update.yml) の `cron` を編集します(UTC表記)。
例: `*/20 * * * *` = 20分ごと。GitHub の仕様上、指定時刻より数分〜数十分遅れることがあります。

## ローカルでの開発

```sh
npm run fetch   # feeds.json から public/data.json を生成
npm run serve   # http://localhost:3000 でプレビュー
npm run icons   # アイコンPNGを再生成(デザイン変更時のみ)
```

## 仕組み

```
GitHub Actions (30分ごと)
  └─ scripts/fetch.mjs が feeds.json の各RSSを取得・整形
       └─ public/data.json を生成 → GitHub Pages にデプロイ
            └─ スマホの PWA (public/) が data.json を表示
```

依存パッケージゼロ(Node.js 標準機能のみ)。記事データは直近7日分・最大1000件を保持します。
