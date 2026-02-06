# perfectPitch

ブラウザでピッチ検出・録音レビュー・メロディ再生ができるボーカル練習ツールです。

## 機能概要

- マイク入力から音名 / Hz / cents を推定
- ターゲット音に対するピッチのズレをゲージ表示
- 録音→振り返り（平均ズレ・安定度・ビブラート傾向）
- 録音フレーズを簡易メロディとして再生（速度変更対応）

## UIデザイン

- `.pen`: `design/perfectPitch-ui.pen`

## 使い方（ローカル）

```bash
npm install
npm run dev
```

## ビルド（ローカル）

```bash
npm run build
```

## ビルド（Docker）

```bash
docker compose run --rm build
```

## GitHub Pages

`vite.config.ts` の `base` は `/perfectPitch/` に設定済みです。

### 公開方法

現在は GitHub Actions で公開しています。`main` ブランチへの push で自動デプロイされます。  
設定ファイル: `.github/workflows/deploy.yml`

手動で実行したい場合は GitHub の Actions 画面から `Deploy to GitHub Pages` を `workflow_dispatch` で起動してください。

## SoundFont

基準音・メロディ再生は FluidR3_GM soundfont を利用しています（CC BY 3.0）。  
Source: https://github.com/gleitz/midi-js-soundfonts
