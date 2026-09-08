# 初期雑音後の長音欠落（Issue #20）

この文書の数値と修正説明はPR #23初版（`6b55ff9`）時点の記録。定常雑音を重ねた追加再現と現行の校正回復・offline再判定は [追加レビュー対応](reviewed-sustained-noise.md) を参照。現行の製品差分はpipelineとofflineで、初版の「pipelineだけ」「追加ヒステリシス不要」は置き換わる。

2026-09-08。比較元mainは `2befdef5a4ad168868d7d54dcd04cfb270787d3f`。着手時のGitHub mainも一致し、ローカル変更なし。専用worktree/ブランチ `codex/fix-sustained-voicing` で実施した。ユーザーの今回の音声は未取得で、以下は独立した合成PCM不具合の検証である。実機録音の直接原因を確定したものではない。

GitHub tree APIのblob SHAと `git rev-parse HEAD:...` が一致した元ファイルを直接importした。テスト用に製品の解析コードを複製・削除・書き換えていない。

- `src/analysis/pipeline.ts`: `8eb4da625c3d708ea98c3ecc8f032882233290ad`
- `src/analysis/detectors.ts`: `c588436a75ff5e3283adea7a6862e289095ec3d5`

PR #19前後（`HEAD^..HEAD`）でpipeline/detectors/captureの差分はない。今回これらのうち製品を変更するのはpipelineだけで、#19の急落補正は維持する。

## 再現と欠落段階

Issueの固定seedを使用。48kHz・6秒・288,000 samples。0〜0.3秒は一様雑音peak 0.05、0.3〜0.8秒は220Hz/peak 0.16、その後は同じ220Hz/peak 0.02。

製品変更前に `tests/sustained-gate.test.ts` を追加し、期待assertionで失敗した。

```text
{"correct":0,"total":481,"lastVoiced":0.8,"lastFrame":5.96}
AssertionError: Expected voiced coverage >= 99%; actual 0/481
tests 1 / pass 0 / fail 1 / exit 1
```

| 観測 | 修正前 | 修正後 |
| --- | --- | --- |
| PCM | 288,000 samples / 6秒 | 同一。非破壊をassert |
| 5.00秒の候補Hz（原窓をYINでも再測定） | 220.00209149 | 同じ |
| 同RMS / periodicity | 0.01417966 / 0.99998644 | 同じ |
| 同採用Hz・分類 | null / silence | 220.00209149 / voiced |
| 同一次理由 | 旧コードの音量先行分岐 | periodic-recovery |
| 録音終了時のnoiseFloor | 0.01526557（声のRMSへ自己固定） | 0.02877791（声を学習せず維持） |
| 修正後5秒のeffective floor / required RMS | 旧版にはなし | 0.001 / 0.0028 |
| 1〜5.8秒の正しい有声 | 0/481 | 481/481 |
| 最終フレーム中心 | 5.96秒 | 5.96秒 |
| 最終有声中心 | 0.80秒 | 5.96秒 |
| offlineの連続音符/メロディ末尾 | 0.805秒 | 5.965秒 |

旧noiseFloor値は入力完了後に実インスタンスから観測したもので、5秒時点の値ではない。生候補、RMS、周期性が存在し、時計も最後まで進むため、この固定PCMでは取得やピアノ減衰ではなく有声判定で欠落している。後段はnullで音符を閉じ、その短い音符を記譜する。Score経路も修正後は音符末尾が5.9秒以後に残ることをassertしている。ピアノの自然減衰自体は変更していない。

元の雑音判定は、周期性に先立つ `rms < noiseFloor * 1.6` で声をsilenceにし、そのRMSをnoiseFloorへ戻していた。floorが声のRMSへ近づいても1.6倍条件は成立する。単なる処理待ちでは回復しない。原PCMから再解析するofflineも同じ判定器なので、この不具合を繰り返していた。

## 採用した修正とレビュー

- 校正は維持。開始300msの低周期性窓だけで測定し、その間でも通常の有声条件を満たす即発声は残す。
- 現在窓の候補Hzと0.97以上の周期性が揃うときだけ、RMS×sqrt(1−periodicity)を残差振幅の目安として過大なfloorを制約する。式と分類は[仕様書](../仕様書.md)を参照。
- 声らしい周期信号を雑音学習に戻さない。未知の区間へ前のHzをコピーせず、発声開始/維持とも現在の音響的根拠を要求する。追加ヒステリシスは固定再現に不要だったため採用しない。
- 独立レビューで、回復floorの下限0.0003案がpeak 0.0015の周期背景音を拾い、同音の声の間に偽音符を作る反例を発見した。実テストで失敗→下限を未校正の初期値0.001へ変更→休符中央はlive/offlineとも全null、派生音符2個を確認。静かな校正から既に得たfloorは維持する。
- `initialGate` に一次候補Hz/周期性、floor、採用RMS条件、理由を残す。offlineの短窓再測定後の最終値とは区別する。通常画面は変更せず、開発用JSONで確認する。
- 最終独立レビューでは上記反例の解消、一次診断の整合、uncertainからの不適切なoffline回復の探索を確認し、blockingな再現指摘は残らなかった。

## 対照・回帰・性能

[修正前JSON](sustained-before.json) / [修正後JSON](sustained-after.json) は全条件と段階別数値を含む。いずれもDocker Node v24.18.0 / Linux arm64で実モジュールを実行した。

| 16/44.1/48kHzの各条件 | 修正前 | 修正後 |
| --- | --- | --- |
| 雑音導入・校正あり | 0/481 | 481/481 |
| 雑音導入・校正なし | 481/481 | 481/481 |
| 無音導入・校正あり | 481/481 | 481/481 |
| 無音導入・校正なし | 481/481 | 481/481 |

一括・1024・可変chunkは時刻、Hz、診断情報を含め完全一致。55/82.41/220/880/1000Hz、即発声、弱く始まる声、3秒の漸減、低中音の弱い基音/倍音/ビブラート、実休符・同音再発音を検査した。既存の100ms実低音/20ms偽急落の回帰に加え、雑音校正後の弱い長音の途中の100ms低音も保持した。

| 48kHz offline | 処理秒数：前→後 | 最終有声：前→後 | 音符末尾：後 |
| --- | --- | --- | --- |
| 6秒 | 2.339→2.344 | 0.80→5.96 | 5.965 |
| 10秒 | 3.883→3.886 | 0.80→9.96 | 9.965 |
| 30秒 | 11.702→11.683 | 0.80→29.96 | 29.965 |
| 60秒 | 23.397→23.559 | 0.80→59.96 | 59.965 |

単回計測で、一部ほかのDocker検証と同時実行した値。専有CPUベンチマークや実機性能保証ではない。追加の判定は1窓ごとO(1)、保存はO(フレーム数)で追加のYIN走査はない。既存の10秒5秒/60秒30秒目標とWorker timeout 60秒以内をこの環境では満たした。物理端末の処理遅延やピークメモリは未測定。

### 雑音の誤採用と残る限界

[雑音の修正前](sustained-noise-before.json) / [修正後](sustained-noise-after.json)。16kHz、歌/話、校正あり/なし。0.5〜2.8秒の231窓を測る。

- 無音・white noise・息状colored AM noise・子音状burstsはすべて0/231、音符0のまま。これらは合成の非周期雑音であり、実際の息/子音全般の分類保証ではない。
- **60Hzの周期環境音（peak 0.02 + white 0.001）は校正ありで0/231→231/231、音符0→1になる。** 校正なしでは旧新とも231/231。このトレードオフは残る。声と同様の周期波形を現在窓だけで識別できないため、環境音の分離は約束しない。
- 880Hzの弱い基音/強い倍音/±20c・4Hzビブラートを重ねた16kHz stressは72/231が誤音程。旧mainの校正なしでも同じ72/231で、原YIN候補が約291Hzとなる。この条件を音高99%達成とは扱わない。校正による追加欠落がないことは別にassertしている。1000Hzを上下に揺らすと対応域外の区間も生じるため、端点の基本回帰は域内の定常音を使う。

## ブラウザ・自動検証

- 変更前：既存134単体テスト成功。固定再現を追加すると期待assertionで失敗。
- レビュー後：全143単体テスト成功。その後に追加した雑音校正後100ms低音テスト1件も成功（製品差分は同じ）。既存のPCM/capture/Worker/編集済みScore/MIDI/自然なピアノの回帰を含む。
- TypeScript/Viteビルド成功。既存のVexFlow chunk約729kB警告は残る。
- 最終Chromium全33テスト成功。既存31件と新規2件。375px/1280pxの既存画面、録音、音声ファイル入力、原音・ピアノ、解析失敗/中止/再試行、編集/MIDIを含む。保存スクリーンショットを目視し、変更による主操作の崩れがないことを確認した。既存譜面の横スクロールは維持。
- 合成AudioBuffer→MediaStream→実AudioWorklet→CaptureSession→実Worker→offlineで録音。Worklet ACK、受信PCM、保持PCMはいずれも307,840 samplesで内容も一致。最終中心6.37秒、live/offlineとも後半の正しい有声率100%、録音の最終有声5.99秒、音符末尾5.995秒。
- その取得PCMをFloat32 WAVにして通常のファイル入力UIへ渡した。最終フレーム中心6.37秒と持続区間の周波数列は厳密一致、後半100%。ファイルは校正なしのため発声終端だけ6.03秒（40ms差）、音符末尾6.035秒。テストは中盤厳密一致と末尾差50ms以内を分けてassertし、この差を同一結果とは呼ばない。
- 本番timeout付きWorkerへ30/60秒PCMを渡すブラウザ試験では11.725/23.485秒で完了、2,993/5,993フレーム、最後の有声29.96/59.96秒、実進捗は1へ到達した。これは30/60秒の物理マイク連続録音試験ではない。

録音試験はWorker出力をモックしていない。メッセージの観測だけを追加した。既存UI試験にはWorker出力をモックするものもあるが、それを録音経路全体の証拠には数えない。ブラウザが渡すPCMの確認であり、ハードウェア未加工の音を保証しない。マイク入力効果の制約変更は今回しない。

### 再現コマンド

いずれもPRブランチのルートで実行。Docker volume内に依存を導入する。`output/` はGit対象外。比較元ディレクトリは基準SHAの既存checkoutを読み取り専用でマウントする。

```sh
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types --test tests/sustained-gate.test.ts
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types scripts/benchmark-sustained.ts
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types scripts/benchmark-sustained-noise.ts
# /absolute/path/to/base は2befdef5の変更していないcheckout。
docker run --rm -v /absolute/path/to/base:/baseline:ro -v "$PWD":/app -w /app node:24-bookworm-slim node --experimental-strip-types scripts/benchmark-sustained.ts --baseline
docker run --rm -v /absolute/path/to/base:/baseline:ro -v "$PWD":/app -w /app node:24-bookworm-slim node --experimental-strip-types scripts/benchmark-sustained-noise.ts --baseline
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm browser sh -lc 'npm ci && node scripts/create-test-voice.mjs && npm run build && npx playwright test'
docker compose -p pitch-issue20 run --rm build
```

ブラウザ全suiteのピアノfixtureはREADME記載の許諾済み素材が必要。今回は既存ローカルの `output/piano.js` をコピーして再利用した。新規音源や個人音声は取得・公開していない。修正前/各試行のログ、JSON、失敗traceは作業worktreeの `output/` に残す。publicな比較JSONは合成音だけである。

## 未検証と後続

- 利用者の今回の原PCM、iPhone Safari/Android Chrome/デスクトップの物理マイク、Bluetooth、OS中断、実騒音下の聴感。Playwright Chromiumや合成音をこれらの代替としない。WebKit/Firefox行列・Lighthouse・公開URL smokeは未実施（今回公開せず、ブラウザAPI/UI構造を変更しない。実機互換性/公開前に実施する）。
- #21：正解付きの未知話者/鼻歌データ、モデル比較、周期環境音、既存の高音/倍音誤検出、実機性能。
- #22：100ms音の記譜量子化による消失、音符境界・テンポ・リズム、同じScoreを演奏して旋律が一致する品質。今回の長音回復だけで採譜全体が完成したとは扱わない。#13/#21/#22は自動クローズしない。

### 実機での確認手順

本番サイトは未変更。まずPRブランチを検証する。デスクトップは `docker compose -p pitch-issue20 -f docker-compose.test.yml up dev` で `http://localhost:4173/perfectPitch/` を開ける。iPhoneの物理マイク確認にはこのブランチのHTTPS検証URLが必要（今回その配信は行っていない）。HTTPのLANアドレスをそのまま物理マイク検証に使わない。

1. 静かな場所で歌声モードを選び、開始0.3秒は静かにした後、一定の高さを6秒ほど伸ばす。途中から声を弱める。別試行では開始直後から発声する。
2. 「元の声」を最後まで聴き、青線、楽譜の長さ、「声の揺れを聴く（連続音高）」を照合する。通常のピアノが自然に減衰することと、線/音符の終了を分けて確認する。
3. 同じ音を途中0.4秒休み、もう一度発声する。休符と再発音が残るか確認。低音/高音、30秒/60秒も試し、停止後の待ち時間を記録する。
4. 不具合が残る場合、端末/OS/ブラウザ/マイク種類/表示された入力設定と、原音が続いているか・線/音符のどの段階で切れたかを記録する。個人音声やフレームJSONをGitHubへ公開添付しない。
