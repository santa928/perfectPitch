# 鼻歌採譜の正解付き評価（Issue #21）

現行YIN・Basic Pitchと評価用pYIN/CREPEを比較し、段階別に失敗を保存する基盤を追加した。**製品アルゴリズムの変更は採用していない。未知データでの改善は未実証で、鼻歌採譜の完成を意味しない。** 境界補正はvalidationで平均F1を改善したが、禁止条件である真休符の補完を起こしたため退けた。

対象の製品SHAは `e1f2bbda77097f2b1e807566d64717211bbcd426`（PR #23 merge済み）。`src/`・モデル・package lockはこのbaselineのまま。評価コード、設定、環境、入力hashとholdout前のsealは[結果JSON](humming-results.json)、分割は[manifest](humming-manifest-v1.json)、採点と採否条件は[評価契約](humming-protocol.md)を参照。

## データと独立性

| 集合 | 録音 | 話者 | 秒数 | 役割 |
| --- | ---: | ---: | ---: | --- |
| development | 13 | 7 | 319.59 | 既使用7録音の話者全体を隔離、候補開発 |
| validation | 13 | 10 | 255.00 | 固定した境界候補V2の採否 |
| final holdout | 14 | 12 | 242.53 | ソース・閾値・環境固定後のbaseline判定 |
| 合成回帰 | 18 | 該当なし | 条件別 | 開発専用。未知歌唱でも実鼻歌でもない |
| 実鼻歌 | **0** | **0** | **0** | 不足。公開歌唱を鼻歌と呼び換えない |

vocadito v3はCC BY 4.0。原音・F0・A1/A2 CSVは再配布せず、公式出典・著者・変更内容をmanifestへ記載した。連続Hzを連続MIDIへ換算し、正解音高を整数へ丸めない。公式論文は40曲にcompositionの重複がないとする。同一話者・曲・元録音はsplitを跨がず、派生PCMも元splitを継承する。29話者・40曲だけで言語・歌い方・機器一般への汎化は保証しない。

HumTransも調べた。公開メタデータではCC-BY-NC-4.0、音声ZIP約14.69 GB、MIDI ZIP約5.47 MB。鼻歌という点は適するが、伴奏譜面由来MIDIと実際の歌声の音高・発音時刻が同じとは限らず、後続研究も時刻注釈の問題を報告している。今回はダウンロード・採点へ進めていない。追加評価には話者と曲の両方の分割、人手による実演F0/onset/offset/休符の点検、配布条件確認が必要。

Basic PitchとCREPEの公表学習集合にはvocaditoの記載がないが、配布checkpoint単位の非重複は保証できない。さらにvocaditoのF0はTony/pYIN出力を人手修正した注釈であり、pYINに有利なannotation biasがあり得る。プロジェクト内holdoutであることと、学習・モデル選択から完全未知であることを区別する。出典は[評価契約の一次資料](humming-protocol.md#一次資料)にまとめた。

評価環境の配布metadataでも[torchcrepe](https://github.com/maxrmorrison/torchcrepe)のMITと[librosa](https://librosa.org/)のISCを確認した。[CREPE公式](https://github.com/marl/crepe)の学習集合記載と、既存[Basic Pitch/ORTのライセンス確認](service-quality-models.md)も参照。今回、候補モデルの重みや公開音声を新たに製品へ同梱していない。

## 処理経路と不可逆な派生

| 段階 | 何を変更するか | 戻り先・音符を失う条件 |
| --- | --- | --- |
| PCM | ブラウザdecodeした48kHz mono。入力ファイルをhash固定 | 原ファイルとdecoded PCMを保持。録音時校正とファイル入力を分離 |
| YIN候補 | 80ms窓、10ms hop、55–1000Hz。候補順位・周期性・RMS | 候補配列と`initialGate`を保存。弱い基音・曖昧な周期では候補から欠ける |
| voicing | RMS・周期性・noise floorで有声/無声/不明を判定 | PCMと棄却理由へ戻れる。候補が正しくても棄却され得る |
| offline review | 原PCMの候補を将来の支持とともに再判定 | liveとreviewedを別保存。全ての有声穴を復元するわけではない |
| continuity | 安定した前後へ20ms以内に戻る大きな低音急落を派生補正 | 原frameは不変。PR #19/#23の実短音・休符回帰を保持 |
| PerformanceNotes | 有声島内の整数音高列と再発音を推定 | 30ms未満の島を落とす。無声穴で分断、滑らかな遷移・再発音の意図を誤る |
| 通常ピアノ | `buildNotes`の独立経路。半音または連続contour | `extractMelody`の譜面用音符と同一ではない。roundedを別ablationとして記録 |
| Score | 手動120 BPM、16分tick、originを先頭推定音へ設定、休符/タイ構成 | PerformanceNotesは保持。短音のstart/endが同tickになり省略、隣接同音も結合し得る |
| 五線譜/譜面ピアノ/MIDI | 共通Scoreを表示・再生・SMFへ変換 | Scoreですでに失った音は出力先では戻らない |
| Basic Pitch | 48kHz PCM→本番Worker内22.05kHz resample→ONNX→単音decoder/休符回復→Notes→共通Score | 原PCMとYINを保持し任意で比較。モデルのpitch/onset出力を連続F0の正解率とは呼ばない |

歌唱精度は実際のファイル経路（校正なし）で測定。録音時の初期雑音校正はPR #23の合成回帰と性能測定で別検証した。推論ブラウザには音声と本番モジュール・モデルだけを渡す。注釈・manifest・`@fs`経由の正解アクセスが拒否されることをブラウザで検証し、採点は推論終了後にNode側で行う。

## 比較結果

以下のF0は正解有声全フレームを分母にしたmicro±50 cents。音符P/R/F1は各曲・両注釈のmacro、onset許容50ms、offset許容max(50ms,正解長20%)。短音は≤120msのA1+A2 event recallで、独立録音数ではない。注釈別micro、各曲/話者分布、誤差分布、rest秒数はJSONへ残す。

YINの表のF0列は**continuity前のoffline**、音符列は`extractMelody`内のcontinuity後。両F0 stageを公開JSONで分離しており、holdoutのcontinuity後は±50c 82.17%、octave 3.257%である。

### 開発13曲：同一PCM・正解・採点条件

| 方式 | F0 ±50c | 有声recall | 無声FP | octave率 | P | R | onset F1 | offset F1 | 短音recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 現行YIN | 88.22% | 89.60% | 5.49% | 0.179% | 49.48% | 57.14% | 52.51% | 42.55% | 41.85% |
| Basic Pitch | N/A | N/A | N/A | N/A | 63.15% | 55.37% | 58.28% | 36.04% | 31.28% |
| pYIN＋現行melody | 96.14% | 99.44% | 37.07% | 0.000% | 40.39% | 63.75% | 49.04% | 37.35% | 56.83% |
| CREPE tiny＋現行melody | 86.01% | 87.62% | 25.52% | 0.574% | 39.22% | 63.89% | 47.85% | 30.97% | 65.64% |
| CREPE full＋現行melody | 86.96% | 88.02% | 23.35% | 0.211% | 40.92% | 64.99% | 49.41% | 30.57% | 67.84% |

Basic PitchはネイティブF0を本番APIで返さない。音符由来の半音proxyは±50c 78.59%、占有recall 93.89%、無声FP 24.47%だが、連続F0推定とは別指標。声の揺れ・glideは半音化によって誤差になる。

pYIN/CREPEは同じブラウザdecode PCMをsoxr_hqで16kHzへ再標本化してCPU実行。pYINは80ms窓・10ms hop・center=True、CREPEはViterbi、periodicity≥0.21、silence -60dB、pitch平滑化なし。各モデルのnative voicingを使い、YINの閾値をconfidenceへ流用していない。これらの設定での比較であり、各方式の到達可能な最高性能とは主張しない。

YINを16kHzへ落とす案も試したが、F0 87.17%、onset F1 51.71%、offset F1 41.49%、短音40.97%へ悪化したため不採用。pYINはF0改善と引き換えに無声FP・休符誤占有を大幅に増やし、同じmelodyを通した音符F1も上がらない。CREPEは短音recallを上げるがprecision/offset/休符で不利。Python backendや重いモデルのdefault化は追加していない。

長音は開発でA1/A2合算わずか2イベント。同じ長音への別注釈を独立標本に数えない。YIN/pYINの正音時間coverageは100%、CREPE tinyは98.69%だが、全方式のonset一致は0/2。少数かつ「長さは覆っても開始が合わない」ため、長音品質達成とは判定できない。

### validation13曲と境界候補の不採用

| 方式 | P | R | onset F1 | offset F1 | 短音recall | 注釈休符の誤占有 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 現行YIN | 45.33% | 52.93% | 48.49% | 37.32% | 42.68% | 5.74% |
| Basic Pitch | 60.22% | 44.08% | 49.06% | 27.67% | 23.17% | 25.26% |
| 境界候補V2（不採用） | 46.11% | 53.80% | 49.31% | 38.16% | 42.93% | **5.85%** |

V2は既存音符の外側40msだけを短いPCM窓で調べ、周期性・同音高・局所音量が揃うと境界を延長する。音符追加/削除/音高変更をしないので検出器交換より小さな案だったが、**歌声終了後に半振幅の同音周期環境音が残る反例で、正しいend=1.000sを1.040sへ延長した**。開発でも休符誤占有6.9288%→7.0036%と悪化した。平均F1の改善では真休符非補完の条件を満たさないため、holdoutへ進めなかった。

V2は開発時hash `5dc3a429a9427314fab7b841fdf75e40462f76526d0e4b9e98d4860c45ce42ff` のまま、評価用scriptだけに残す。追加テストは「この不採用理由を再現する」テストであり、望ましい製品動作を固定するものではない。連続contourを単一点へ置換する問題、弱い立ち上がりに反応しない問題もあり、合成18clipでは境界変更evidenceが0件だった。製品からは一切importしない。

### final holdout14曲

| 方式 | F0 ±50c | 有声recall | 無声FP | octave率 | P | R | onset F1 | offset F1 | 短音recall | 休符誤占有 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 現行YIN | 82.13% | 87.83% | 8.88% | 3.291% | 42.88% | 58.42% | 49.04% | 37.70% | 38.79% | 5.95% |
| Basic Pitch | N/A | N/A | N/A | N/A | 63.94% | 56.73% | 59.33% | 31.06% | 30.60% | 24.42% |

短音は90/232対71/232、同音再発音は99/221対72/221。2秒以上の正解長音は**0件**で、このholdoutから長音の未知データ性能は評価できない。YINの曲別onset F1は27.93〜67.21%、Basic Pitchは47.62〜77.73%。YINの`vocadito_34`はF0 ±50cが36.20%で、開発時より大きいoctave誤りも残った。

Scoreの音響時計onset F1はYIN41.88%、Basic Pitch46.42%。量子化消失は187件/12件、`omittedNotes`は173件/11件。入力音符数・短音の検出率が異なるため、Basic Pitchの消失件数の小ささだけで最終旋律が正しいとは判定しない。

候補の不採用と製品維持を決めた後に測定したbaselineである。holdoutで閾値調整はしていない。「改善後」は製品変更なしのためbaselineと同一で、数値向上は主張しない。この集合を後から調整へ使う場合、新しい未知集合が必要になる。

## 代表的失敗と最大のボトルネック

最大の問題は、連続F0を「意図した発音・長さを持つ音符列」へ変換する境界・voicing/segmentationと、その後のScore消失。holdoutで顕在化したF0候補のoctave誤りも残るため、境界だけ直せば十分という意味ではない。[段階トレースJSON](humming-failure-traces.json)は開発区間のPCM hash、正解F0/音符、raw候補・棄却理由、accepted F0、PerformanceNotes、Scoreを並べる。

- **vocadito_37**：F0 ±50c 97.53%でもA1 onset F1は55%。1.50〜1.72sは候補もaccepted F0も存在し、滑らかに上がる。A1の音符開始1.57270sに対しMIDI57のPerformanceNoteは1.635s（62ms遅れ）、Scoreは1.695s。検出欠測ではなく連続pitchからの音符境界と量子化が別々に遅らせる例。
- **vocadito_4**：0.32/0.34/0.35sなどに139〜140Hz候補があっても`ambiguous`で棄却。offlineは一部を復元するが0.44〜0.47sは不明のまま、0.48〜0.49sの20ms島もmelodyでは落ちる。無条件な穴埋めでは休符を壊す。
- **合成100ms**：YINは4/4イベントが標準onset/offset許容へ一致しても、正音coverageは平均68.75%、PR #19の低音は30%。「recall 100%」だけで十分な演奏長とは言えない。Basic Pitchは1/4。
- **合成glide**：発音後150msで3半音下から目標MIDI60へ上がる。連続F0正解と「MIDI60の一音として歌う」音符正解を別に持つ。YINのonset F1は0で、長音カテゴリの正音coverage欠落にも入るが、これは全区間が無声になったことを意味しない。
- **周期環境音**：環境音のみでもYINは3.93秒を音符化。合成の真休符と周期音を別々に試すだけでは、両者を組み合わせたV2の反例を見逃す。
- **Score**：正しいC4 0〜0.2s / D4 0.2〜0.3s / C4 0.3〜1sを実`buildScore`へ渡すと、120 BPMでC4一音になり、`omittedNotes=1`。最大対応の消失はDだけでなく後続Cの再発音を含め2件となる。これは推定器と独立した#22の未修正問題。

開発YINの量子化消失132件（`omittedNotes`127件）、validation197件（同191件）。前後同音の結合まで含めるため数値が異なる。追加音、誤休符の秒数、reattack数、tie数、対応音のduration誤差をJSONへ保存。手動120 BPMでの秒時計診断であり、正しい譜面/BPMのない歌唱で拍やtieの正解率を捏造しない。

#22では最初に、正しいPerformanceNotesからC-D-Cと100ms実音・同音再発音を消さない量子化を直す。原秒・論理音符IDを保持し、表現できない音を無言で省略しない設計が必要。そのうえでBPM/拍節候補と元の演奏タイミングを分離し、共通Score→五線譜/ピアノ/MIDIで同じ音符を検証する。

## 性能と実装可能性

| 音源 | cache | live処理合計 | chunk RTT p95 | offline | Basic Pitch | Chromium RSS合計peak |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 10秒 | cold context | 3.62s | 11.8ms | 3.54s | 1.20s | 587,800 KiB |
| 10秒 | warm HTTP | 3.68s | 11.9ms | 3.53s | 1.12s | 591,924 KiB |
| 30秒 | cold context | 11.82s | 11.9ms | 11.45s | 2.02s | 641,124 KiB |
| 30秒 | warm HTTP | 11.50s | 11.8ms | 11.37s | 1.98s | 637,388 KiB |
| 60秒 | cold context | 23.34s | 11.8ms | 23.06s | 4.03s | 670,736 KiB |
| 60秒 | warm HTTP | 23.43s | 11.9ms | 23.17s | 3.45s | 678,476 KiB |

この性能runの後に評価の完走/公開hash検証を追加した。元artifactと当時のsourceHashesは保存し、公開時に本番src・資産・package/lock・Vite/tsconfig・性能runnerがsealと一致することを確認する。性能に関係しない評価コードの差分はJSONの`performanceApplicability`に明示し、当時のhashを現行値へ書き換えない。

ブラウザはDocker Linux arm64、Chromium 151 / Playwright 1.62.1、Node 24.18.1。1024-sample chunkを順次Workerへ渡す測定で、RTTは処理サービス時間であり、AudioWorklet/物理マイク/出力デバイスまでの遅延ではない。冷contextでもOS/Vite cacheは温まっている。RSSは50ms間隔でChromium全プロセスを合計し共有ページを重複計上する。main-page JS heapはWorker/WASMメモリを含まない。

Basic Pitch重み230,444 bytes、WASM 13,961,845 bytes（mjs等を別途ロード）。Workerは呼び出しごとに生成/破棄されるので、HTTP cacheが温まっても推論sessionの初期化は残る。CREPE tinyは1,962,363 bytes、fullは88,991,291 bytes。pYINはニューラル重み不要。Web移植には音響処理/decoderの同等性・WASM/ONNX対応とmobile性能の追加確認が必要で、今回Pythonをbackendとして組み込んでいない。

Pythonは3.12、librosa 1.0.0、torch 2.14.0+cpu、torchcrepe 0.0.24、numpy 2.5.3、scipy 1.18.1、2 CPU threads。開発319.59秒に対する推論合計はpYIN16.78秒、tiny36.51秒、full722.85秒。process peak RSSはそれぞれ798,848 / 597,576 / 928,336 KiB。探索時の共有負荷・起動warmupを含むため速度ランキングには使わない。pYIN行も共通Python processのtorch importを含み、最小必要メモリではない。

10秒停止後5秒という目標との比較はofflineの単独処理値で行い、UI準備や譜面生成を含む端末総時間達成とは呼ばない。実iPhone/Android、物理マイク、ネットワーク速度の異なる初回取得、第三者の譜面実演は未検証。60秒の処理と数百MiBのプロセスメモリから、desktop結果だけでmobile適合とは判断できない。

## 検証と未達

- strict TypeScript（製品と評価用tsconfig）、関連52 tests成功。追加のseal/完走CLI/公開hashテスト3件も個別確認。PR #19/#23のノイズ・実100ms跳躍・長音末尾の回帰を含む。
- Python ruff 0.12.11 / mypy 1.17.1成功。基盤の最大1対1照合、50ms/20%offset境界、全正解有声分母、group漏洩、未完走/重複拒否を検証。
- 実ブラウザでYIN/offline/Basic Pitch Workerと採点前の注釈アクセス拒否を確認。通常ページUIや物理機器の全体QAを代用するものではない。
- 独立レビューでV2の休符補完・contour破棄を再現し不採用にした。製品runtimeを変えないため全Browser matrix・Lighthouse・公開URL smokeは実施しない。runtime/レイアウト変更または公開時に再実行する。
- 初期開発runnerのrounded ablationに引数順序誤りがあった。保存済みreviewed framesから正しい引数で再構成して別`*-audited`結果に記録。YIN/Basic Pitchの推論・headline数値は影響なし。元artifactと再採点hashを保持し、失敗した途中runを完走結果へ混ぜていない。
- Issue #21の実鼻歌目標（有声≥95%、無声FP≤2%、onset≥90%、offset≥85%等）は**未達/未検証**。数値に合わせて目標を緩和せず、Issue #21を解決済みにはしない。

## 再現

開発・依存取得・評価の実行はすべてDocker内。音声と生出力は`.gitignore`の`output/`へ保存する。公開するのはコード、固定manifest、集計、短い開発トレース。既存の旧100ms/整数音高評価は改変しない。

```sh
# 公式ZIPが未取得の場合。ネットワークで約58.5MB取得、既存の検証/安全な保存処理を使用。
docker run --rm -v "$PWD:/app" -w /app python:3.12-bookworm python scripts/fetch-vocadito.py --output output/service-quality/issue21-download
# 既存archive: output/service-quality/vocadito.zip（manifestのSHA256と一致が必要）
docker run --rm --network none -e PYTHONDONTWRITEBYTECODE=1 -v "$PWD:/app" -w /app python:3.12-bookworm python scripts/evaluation/prepare.py --split development
# 評価用依存だけをDocker volumeへ作成。製品依存を増やさない。
docker run --rm -v "$PWD:/app" -v perfectpitch_browser_modules:/app/node_modules -w /app mcr.microsoft.com/playwright:v1.62.1-noble bash -c 'npm ci && npm run prepare:transcription'
# 以下の node コマンドも上記image/volume/workdir、--network none のDocker内で実行する。
node --experimental-strip-types scripts/evaluation/run.ts --split development --output output/issue21/new-dev
node --experimental-strip-types scripts/evaluation/run.ts --split synthetic --output output/issue21/new-synthetic
node --experimental-strip-types scripts/evaluation/summarize.ts output/issue21/new-dev/results.json
node --experimental-strip-types scripts/evaluation/export-pcm.ts development
# pYIN/CREPEのPython環境・設定・重みhashは結果JSONのprovenanceを参照。
# 全依存snapshotはscripts/evaluation/python-environment.txt。既存環境のpip checkは成功。
# 新規環境を作る場合はDocker volumeへvenvを作成し、cpu wheel indexも指定して導入する。
# /deps/bin/pip install --extra-index-url https://download.pytorch.org/whl/cpu -r scripts/evaluation/python-environment.txt
python scripts/evaluation/python-candidates.py --method pyin --split development --output output/issue21/new-pyin
node --experimental-strip-types scripts/evaluation/score-candidates.ts output/issue21/new-pyin
node --experimental-strip-types scripts/evaluation/summarize.ts output/issue21/new-pyin/results.json
# validation準備→固定候補の採否→コードと全設定を凍結。再現時もholdoutで再調整しない。
node --experimental-strip-types scripts/evaluation/run.ts --split final-holdout --freeze --output output/issue21/new-frozen
python scripts/evaluation/prepare.py --split final-holdout
node --experimental-strip-types scripts/evaluation/run.ts --split final-holdout --seal output/issue21/new-frozen/seal.json --output output/issue21/new-final
node --experimental-strip-types scripts/evaluation/summarize.ts output/issue21/new-final/results.json
node --experimental-strip-types scripts/evaluation/performance.ts output/issue21/new-performance.json
node_modules/.bin/tsc -p scripts/evaluation/tsconfig.json
```

`--freeze`は音声・正解を読む前にソース/設定/manifest/Node/Chromium/依存versionを固定する。holdoutは`--only`禁止、seal一致必須、14件完走しなければ集計拒否。Python候補・PCM export・境界候補・再採点CLIはholdout入力を拒否する。これは不用意な再調整を防ぐ実行契約であり、ローカルファイルを読む権限を持つ人への秘密保持機構ではない。

旧開発runの3件はcomplete flag導入前のため、`audit-legacy.ts`がID全集合、pageErrors/blockedRequestsが空、各clipのmetricsと最終checkpoint一致、stages存在、原音hashを明示監査した別artifactへ変換する。新たな推論成功やholdoutと呼ばず、元結果hashと監査範囲を保存する。すべての通常集計はcomplete/expectedIds必須で、summaryは元JSONのSHA256を持ち、公開時に再照合する。
