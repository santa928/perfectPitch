# perfectPitch

鼻歌のメロディをピアノとドレミ付き五線譜で確認し、元の声とも聴き比べるブラウザアプリです。話し声の音程表示・連続音高の再生も維持しています。Vite / TypeScript、GitHub Pages構成です。自動採譜は推定で、音程・休符・リズムの誤りは残ります。

倍音の誤選択と短い音の分断を調整しています。マイクのノイズ抑制は無効を要求し、実適用値を画面に表示します。静かな場所で録音してください。ピアノ・楽譜では30ms未満の孤立音を除き、短い境界の倍音候補を限定補正します。元の声と原軌跡は保持します。[比較結果と未検証項目](docs/evaluation/pitch-continuity.md)を参照してください。

## 操作方法

1. 「歌声」か「話し声」を選び、「録音する」でマイクを許可します。
2. 最初の約0.3秒は静かにし、そのあと声を出してください。最大60秒で自動停止します。
3. 「録音を止める」のあと「分析中」の進捗を待ちます。前後の音を見直したら、「元の声 / ピアノ」を選び、ひとつの再生ボタンで聴きます。分析だけ失敗した場合は元音声を残し、再生設定から再解析できます。
4. 再生設定で「元のズレを残す（ピアノ風）」と「鍵盤に丸める」を切り替えられます。歌声・話し声ともに「元のズレを残す」が初期設定です。
5. 表示音域を明示的に切り替えられます。再生位置スライダーで8秒表示範囲と再生開始位置を移動します。声の種類変更は保持PCMから再解析します。
6. 録音後に「楽譜とドレミを見る」を開くと、推定の五線譜と固定ドのカタカナ音名を表示します。歌声では揺れを音符へまとめます。ド4が中央のド、♯は半音上です。
7. 「譜面どおりに聴く」は、表示と同じ音符・休符・タイでピアノを鳴らします。テンポ候補（根拠が弱い場合は仮120）を40〜240 BPMで調整すると、譜面とこの再生が一緒に変わります。元の声や上のピアノ再生は変わりません。新録音・別の再生・パネルを閉じる操作で譜面再生は止まります。
8. 「音声ファイルを開く」では、ボイスメモなど60秒・20 MiBまでの音声を端末内で読み込めます。ファイルの冒頭に無音は不要です。対応形式はブラウザのデコーダーに依存します。中止・入力失敗では直前の録音を保持します。
9. 歌声の「途切れを抑えて採譜」は、音符活動と発音から別の推定を作ります。初回は約14 MBを同じサイトから取得し、キャッシュ状況によって再取得します。速い音・跳躍・音の終わりを取り違える場合があるため、「元の推定」と聴き比べて選んでください。標準のYIN解析や元音声は変えません。
10. 五線譜の音符または「音符を直す」の一覧から、音程・開始・長さを0.25拍単位で変更できます。休符化・音符追加・50件のUndo/Redoに対応します。手直し後のテンポ変更は音価を保って速度だけを変えます。推定の切替では各推定の手直しを保持します。再解析・ファイル読込の成功や録音開始で手直しは消えますが、再解析・読込の失敗時は直前の結果を保持します。
11. 「MIDIを保存」で、表示・譜面再生と同じ音程・音価・テンポを楽器アプリへ渡せます。MIDIはカタカナや五線譜の画像、元の音声を含みません。PDF出力は未対応です。

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

- 一人の近くの声、静かな場所を基本条件とします。55〜1000 Hz。YIN、歌80ms / 話60msの窓、10ms更新です。マイク録音の冒頭300msは環境音の測定に使い、ファイル入力では除外しません。
- HTTPSまたはlocalhost、AudioWorklet / Worker / Web Audio / マイク権限が必要です。非対応の場合は明示エラーにします。画面離脱や音声中断後に勝手に録音・再生を再開しません。
- 録音と原音再生はmono Float32 PCMを使用し、MediaRecorderのMP4/WebMコーデック差を避けます。60秒上限、48kHzで1コピー11.52MB。再解析・再生時には追加コピーが必要です。
- 10dB SNRの合成雑音条件は精度目標未達です。周期的環境音・テレビ・伴奏・他人の声の分離は保証しません。
- 窓内で音程が変わる境界は不確実になります。音符終端は最大約半窓分、元音声より短くなる場合があります。
- ライブは直前音との1フレーム候補比較、停止後は前後の波形候補を追跡します。20ms以上の安定した観測を保持し、短い不確実区間は40ms窓で再検出できた場合だけ回復します。長い誤判定や途切れは残ります。[停止後解析の比較と限界](docs/evaluation/offline-review.md)を参照してください。
- 楽譜は最初の検出音を1拍目とする4/4・16分単位の推定です。調・拍子の自動推定はなく、テンポ候補にも倍/半分などの曖昧さがあります。量子化で消えた短音は件数を表示し、譜面再生も同じ省略を反映します。鼻歌の音符化・同音再発音・再生との一致の[比較と限界](docs/evaluation/melody-verification.md)を参照してください。
- iPhone Safari / Android Chromeの実機マイク、電話等のOS音声中断、実際の騒音環境は未検証です。自動化ブラウザ確認と区別します。

[要件と受け入れ状況](docs/要件定義書.md)・[実装仕様](docs/仕様書.md)・[検証報告](docs/evaluation/verification.md)・[合成音の比較](docs/evaluation/synthetic-report.md)・[実音声の出典](docs/evaluation/real-audio-sources.md)を参照してください。

## プライバシーと音源

音声・解析データはブラウザ内だけで扱い、サーバーに送信しません。録音は永続保存せず、再録音またはページ終了で破棄します。ピアノ再生時は `gleitz.github.io` から音源を取得するため、通常のHTTPリクエスト情報は音源配信元へ送られます。音声送信とは別です。フォントの外部取得はありません。

任意の再採譜はSpotify Basic Pitchの公式ONNXモデル（Apache-2.0）とONNX Runtime Web（MIT）を同じ配信元から読み込み、専用Worker内のWebAssembly・1スレッドで実行します。モデル未使用時は取得しません。学習モデルの出力をF0測定値や正解確率とは扱いません。[比較・不採用案・最終4歌唱の結果](docs/evaluation/service-quality-models.md)に改善と悪化の両方を記載しています。

Piano: FluidR3_GM acoustic grand piano、[Benjamin Gleitzman / MIDI.js Soundfonts](https://github.com/gleitz/midi-js-soundfonts)、[CC BY 3.0 US](https://creativecommons.org/licenses/by/3.0/us/)。元のMP3サンプルをデコードし、音高・音量・発音時間を変更して再生します。音源ロード失敗時に簡易音へ黙って代替しません。外部JavaScriptは実行せず、音源のデータ部分だけを検証・解析します。

実音声評価にはCC BY-SA 4.0のPJS corpusをローカル取得して使用します。評価音声はGitやアプリの配布物へ含めません。出典・取得コマンド・ハッシュは上記資料を参照してください。

さらにCC BY 4.0のVocaditoから、人手F0と2人の音符注釈を持つ7人の歌声を評価します。初回は3人を開発用、4人を候補固定後の最終確認用として選定しました。各注釈を別に採点し、不明なBPMを推定成功として扱いません。[出典と再現方法](docs/evaluation/vocadito-sources.md)。初回の未使用素材は、その後の[曲中の休符再判定](docs/evaluation/service-quality-rest-recovery.md)では既使用の回帰素材です。モデルの学習・開発データとの非重複は保証しません。

追加で原テンポ80/120/180 BPMの単独歌唱3曲を公式MusicXMLと比較しました。[取得方法](docs/evaluation/vocal-score-sources.md)・[曲別結果と残る誤り](docs/evaluation/vocal-score-verification.md)。記譜時の不要な再打鍵を修正しましたが、自動テンポの確定や正確な全音符復元は未達です。公式譜面との一致を実歌唱のF0精度とは呼びません。

楽譜は[VexFlow 5.0.0](https://github.com/vexflow/vexflow)のBravura同梱版をパネル展開時に読み込みます。MITとSIL OFL 1.1のライセンス全文を `public/licenses/` に同梱し、画面から参照できます。楽譜表示にも音声送信・外部フォント取得はありません。

## GitHub Pages

`vite.config.ts` の `base: '/perfectPitch/'` と `.github/workflows/deploy.yml` は維持しています。main push / workflow_dispatchで公開される既存設定です。リニューアルPR #14はユーザー承認後にマージ・公開済みです。Issue #13は未完了項目を追跡するため開いたままです。楽譜追加は別PRで扱います。

UIの現行資料は [docs/UI設計.md](docs/UI設計.md)。既存の `design/perfectPitch-ui.pen` と `docs/issues/ui-redesign.md` は旧デザイン資料です。
