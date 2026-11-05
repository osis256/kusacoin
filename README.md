# くさコイン

架空コインを売買して遊ぶ、共有相場のミニゲームです。プレイヤー情報と相場はAPIサーバーに保存され、売買成立時と5分ごとに全プレイヤーの画面へ反映されます。売買には1%の手数料がかかります。総資産ランキングは現在価格で保有コインを評価します。

画面上の金額と価格は見た目の単位を100倍し、整数で表示します。成行・指値の注文数量も整数のみです。残高、保有コイン、各銘柄価格は毎日 00:00 JST に初期化され、プレイヤー名は維持されます。銘柄ごとの値動きやすさは5段階からサーバー内で日ごとに抽選され、画面やAPIには公開されません。

## 静的サイトとしてビルドする

静的ファイルは `out/` に生成されます。静的ホスティングに `out/` の中身を配置してください。

```sh
npm run build:static
```

静的サイトとAPIを別々にホストする場合は、APIサーバーのオリジンを指定してビルドします。

```sh
API_BASE_URL=https://api.example.com npm run build:static
```

APIサーバー側では静的サイトのオリジンを許可し、状態ファイルを永続化できるNode.jsホストで起動します。

```sh
ALLOWED_ORIGIN=https://game.example.com DATA_FILE=/path/to/persistent/game-state.json npm start
```

`API_BASE_URL` と `ALLOWED_ORIGIN` はそれぞれ接続先APIのオリジン、静的サイトのオリジンに合わせてください。Cookieを利用するため、独自ドメインを使い `game.example.com` と `api.example.com` のように同じサイト配下に配置することを推奨します。別サイト間ではブラウザーのサードパーティCookie制限により、プレイヤー情報が保持されない場合があります。

## サーバーとローカルで動かす

Node.js 18 以降で実行します。

```sh
npm run build
npm start
```

ブラウザーで `http://localhost:3000` を開きます。ポートを変える場合は `PORT=8080 npm start` のように指定できます。プレイヤーと現在価格は `data/game-state.json` に保存されます。

## コインを追加する

`coins.js` の配列に設定を追加します。`id` は一意の英数字、`initialPrice` は毎日の初期価格、`volatility` と `drift` は時間経過による小さな変動の基準値、`liquidity` と `maxImpact` は売買時の価格変動量、`characteristic` は画面に表示する値動きの説明です。

## テスト

```sh
npm test
```
