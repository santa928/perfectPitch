# perfectPitch

歌声や普通の話し声の音程を、タイムラインで見て、元の声とピアノで聴き比べるブラウザアプリです。Vite / TypeScript、GitHub Pages構成を維持しています。

## 操作方法

1. 「歌声」か「話し声」を選び、「録音する」でマイクを許可します。
2. 最初の約0.3秒は静かにし、そのあと声を出してください。最大60秒で自動停止します。
3. 「録音を止める」のあと再解析が終わったら、「元の声 / ピアノ」を選び、ひとつの再生ボタンで聴きます。
4. 再生設定で「元のズレを残す（ピアノ風）」と「鍵盤に丸める」を切り替えられます。歌声は前者、話し声は後者が初期設定です。
5. 表示音域を明示的に切り替えられます。再生位置スライダーで8秒表示範囲と再生開始位置を移動します。声の種類変更は保持PCMから再解析します。
6. 録音後に「楽譜とドレミを見る」を開くと、推定の五線譜と固定ドのカタカナ音名を表示します。ド4が中央のド、♯は半音上です。仮のテンポ120を歌に合わせて40〜240 BPMへ調整できます。

青い線が連続した声の高さ、薄いバーが近くの半音です。「正解メロディ」や採点ではありません。無音・無声音・不明な区間は空白です。

## 起動・検証（Docker）

```sh
# 開発サーバー http://localhost:4173/perfectPitch/
docker compose -f docker-compose.test.yml up dev
# 停止
docker compose -f docker-compose.test.yml down
# TypeScript + Vite本番ビルド（公開しません）
docker compose run --rm build
# 解析・録音境界・再生モデルの自動テスト（Node 24）
docker compose -f docker-compose.test.yml run --rm unit
# 比較測定（出力レポートを更新します）
docker compose -f docker-compose.test.yml run --rm unit node --experimental-strip-types scripts/benchmark-pitch.ts
# ブラウザテスト用の許諾済み音源を取得（外部通信）
docker compose -f docker-compose.test.yml run --rm unit node scripts/fetch-piano-fixture.mjs
# Docker Chromium + 合成マイク、375px / 1280px
docker compose -f docker-compose.test.yml run --rm browser
```

必須環境変数はありません。依存はDocker volume、合成音・ブラウザ証拠はGit非追跡の `output/` に生成します。ホストでのnpm実行は不要です。公開ビルドはNode 20を維持し、Node標準のTypeScriptテスト実行のみNode 24を使います。

## 対応条件と既知の制限

- 一人の近くの声、静かな場所を基本条件とします。55〜1000 Hz。YIN、歌80ms / 話60msの窓、10ms更新です。冒頭300msは環境音の測定に使います。
- HTTPSまたはlocalhost、AudioWorklet / Worker / Web Audio / マイク権限が必要です。非対応の場合は明示エラーにします。画面離脱や音声中断後に勝手に録音・再生を再開しません。
- 録音と原音再生はmono Float32 PCMを使用し、MediaRecorderのMP4/WebMコーデック差を避けます。60秒上限、48kHzで1コピー11.52MB。再解析・再生時には追加コピーが必要です。
- 10dB SNRの合成雑音条件は精度目標未達です。周期的環境音・テレビ・伴奏・他人の声の分離は保証しません。
- 窓内で音程が変わる境界は不確実になります。音符終端は最大約半窓分、元音声より短くなる場合があります。
- 楽譜は最初の検出音を1拍目とする4/4・16分単位の表示です。調・拍子・テンポを自動推定した正解の採譜ではありません。量子化で消えた短音は件数を表示します。楽譜設定は音程解析と再生を変更しません。PDF/MIDI出力、楽譜通りの再生は含みません。
- iPhone Safari / Android Chromeの実機マイク、電話等のOS音声中断、実際の騒音環境は未検証です。自動化ブラウザ確認と区別します。

[要件と受け入れ状況](docs/要件定義書.md)・[実装仕様](docs/仕様書.md)・[検証報告](docs/evaluation/verification.md)・[合成音の比較](docs/evaluation/synthetic-report.md)・[実音声の出典](docs/evaluation/real-audio-sources.md)を参照してください。

## プライバシーと音源

音声・解析データはブラウザ内だけで扱い、サーバーに送信しません。録音は永続保存せず、再録音またはページ終了で破棄します。ピアノ再生時は `gleitz.github.io` から音源を取得するため、通常のHTTPリクエスト情報は音源配信元へ送られます。音声送信とは別です。フォントの外部取得はありません。

Piano: FluidR3_GM acoustic grand piano、[Benjamin Gleitzman / MIDI.js Soundfonts](https://github.com/gleitz/midi-js-soundfonts)、[CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/)。元のMP3サンプルをデコードし、音高・音量・発音時間を変更して再生します。音源ロード失敗時に簡易音へ黙って代替しません。外部JavaScriptは実行せず、音源のデータ部分だけを検証・解析します。

実音声評価にはCC BY-SA 4.0のPJS corpusをローカル取得して使用します。評価音声はGitやアプリの配布物へ含めません。出典・取得コマンド・ハッシュは上記資料を参照してください。

楽譜は[VexFlow 5.0.0](https://github.com/vexflow/vexflow)のBravura同梱版をパネル展開時に読み込みます。MITとSIL OFL 1.1のライセンス全文を `public/licenses/` に同梱し、画面から参照できます。楽譜表示にも音声送信・外部フォント取得はありません。

## GitHub Pages

`vite.config.ts` の `base: '/perfectPitch/'` と `.github/workflows/deploy.yml` は維持しています。main push / workflow_dispatchで公開される既存設定です。リニューアルPR #14はユーザー承認後にマージ・公開済みです。Issue #13は未完了項目を追跡するため開いたままです。楽譜追加は別PRで扱います。

UIの現行資料は [docs/UI設計.md](docs/UI設計.md)。既存の `design/perfectPitch-ui.pen` と `docs/issues/ui-redesign.md` は旧デザイン資料です。
