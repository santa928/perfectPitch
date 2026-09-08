# Issue #21 評価契約 v1

2026-09-08。baseline: `e1f2bbda77097f2b1e807566d64717211bbcd426`（PR #23取り込み済み）。本契約は新しいvalidation/holdoutの音声・正解を解析する前に固定する。

## 分割と判定順序

vocadito v3の全40録音を使用する。既使用の7録音だけでなく、その話者の全録音をdevelopmentへ置く。公式論文 §2.1 は40録音に同一compositionの重複がないと明記するため、melodyGroupはtrack単位とする。speakerGroupは公式metadataのsinger_id。変形・再標本化・雑音付加は必ず元録音のsplitを継承する。

| split | track番号 | 用途 |
| --- | --- | --- |
| development | 1,2,3,4,8,15,17,24,35,36,37,38,39 | 過去調整の影響を隔離。候補選択・原因分析 |
| validation | 5,7,9,11,13,16,19,21,23,26,28,30,33 | 候補の採否。結果を見て再調整したら調整履歴を残す |
| final-holdout | 6,10,12,14,18,20,22,25,27,29,31,32,34,40 | ソース・設定のhash固定後の一回の最終判定 |

分割はプロジェクト独自。原録音・F0・各注釈のSHA256、sample rate、長さ、speaker/melody/source groupをmanifestに保存する。holdoutを見て製品を変えた場合、このholdoutは以後回帰集合とし、新しい未知データを要求する。合成集合はすべてdevelopment-regressionであり未知の鼻歌ではない。

## 指標（推論へ正解を渡さない）

- F0は人手注釈のnative clockで、推定の最近傍中心が半hop以内の場合だけ照合。欠測・範囲外の正解有声も分母に残す。voiced recall、unvoiced false positive、正解有声を分母とする±50 cents、±1200 centsの整数倍から50 cents以内のoctave error、検出有声のsigned/absolute error分布とその件数を出す。
- `initialGate.candidateHz`（有声棄却前）、live、offline、continuity後を別に採点する。候補Hzが存在するだけでは声とは主張しない。
- 音符は連続MIDIを保持し、pitch±50 cents、onset±50ms、offset±max(50ms,正解長20%)の最大1対1照合。onsetのみ/offset込みのprecision, recall, F1, TP, FP, FNを別計算。空の分母はnull。既存の100ms/整数MIDI評価は改変しない。
- 各曲・各注釈A1/A2を保持し、良い方を選ばない。曲macroと注釈別microを出す。A1/A2相互一致も測定する。長音≥2s、短音≤120ms（合成100msを別記）、同音再発音のglobal match recallと時間coverage、最大欠落、不要分断を出す。カテゴリ別precisionを都合よく推定音の除外で上げない。
- 真の休符は音符注釈の補集合として音符占有率を評価。F0無声とは混ぜない。音符中の子音はF0=0でも休符とは限らない。
- PerformanceNotesとScoreを別評価。Scoreは手動120 BPM、originを原音秒へ戻して評価し、自動テンポ成功と呼ばない。量子化に対する音符対応は音高+時間重なりで消失・追加・duration誤差を診断。再発音数とtie数を記録。参照譜/BPMのない歌唱では正しい拍・tieを断定しない。C-D-C→Cは正しい入力音符から別途再現する。
- Basic Pitchは本番の単音decoderと休符回復を含む。ネイティブF0は本番APIが返さないのでN/Aとし、音符由来の半音F0 proxy/coverageを独立表示する。pYIN/CREPEは同じ55–1000Hz、10ms hopで比較し、そのF0→現行melodyも別方式として扱う。

## 採用基準と未達の扱い

初期目標はIssue #21のまま：未知実鼻歌でvoiced recall≥95%、無声FP≤2%、onset F1≥90%、offset F1≥85%、長音coverage≥95%、偽100ms超欠落なし、合成100ms実短音recall≥90%。未達を明示し、測定後に緩和しない。

長音coverageの目標は音符macroとduration加重microの両方へ適用する。A1/A2別集計と合算を併記し、長音の実件数を必ず示す。休符も注釈別の秒数・誤占有秒数・比率を保持する。不確かさは曲別・話者別の分布を残し、少数集合から母集団の精度を断定しない。これらはholdout開封前の集計明確化であり、split・照合閾値・採用目標の変更ではない。

候補採用は平均値だけでは決めない。原因と実装の対応、validationのF0/音符両段階、短音・長音・実休符・octave jumpの対照とPR #19/#23の既存回帰を確認する。holdoutの一部悪化・不確かさを明記し、未知の実鼻歌未取得なら汎化改善を主張しない。モデル標準化や大規模設計変更の根拠が不足なら、評価基盤を先に独立PRとする。

## 性能・境界

参照環境は既存Docker/Linux arm64、Playwright Chromium、48kHz mono、同じホスト。10/30/60秒の合成入力でlive処理、offline処理、Basic Pitch Workerを分ける。取得量・初回/キャッシュ・経過時間・プロセスメモリの測定範囲を記録する。live p95 150ms、10秒停止後5秒を目安とする。Python CPU値とブラウザ値、プロセスRSSとJS heap、仮想環境と実機を混同しない。

受け入れ条件：固定split/ハッシュ、再現ランナー、段階別生結果、標準照合、既存回帰、独立レビュー、PR。非対象：Python backend、音声送信、#22全面実装、merge/公開。リスクと対策：リークはspeaker/曲/source監査とholdout seal、注釈差は両注釈、公開歌唱の分布差は実鼻歌0件を明記。実iPhone/Android・物理マイク・第三者による譜面実演は未検証のまま残す。

## 一次資料

- [vocadito公式論文](https://arxiv.org/html/2110.05580v2) / [固定v3配布](https://zenodo.org/records/5578807)。CC BY 4.0、著者・出典・変更表示が必要。音声・注釈原本はGitへ入れない。F0はpYINをTonyで人手修正したもので、pYIN比較にannotation biasがあり得る。
- [mir_eval transcription](https://mir-eval.readthedocs.io/latest/api/transcription.html)。本評価は閾値を固定した最大二部照合を用いる。
- [Basic Pitch論文](https://arxiv.org/html/2203.09893v1)はGuitarSet/MAESTRO/Slakh/iKala/MedleyDBの学習を記載。vocaditoは記載なしだが、配布checkpointの録音単位の非重複を保証するものではない。上流評価・選択への利用も含め完全未知とは呼ばない。
- [HumTrans論文](https://arxiv.org/html/2309.09623v2) / [公式実装](https://github.com/shansongliu/HumTrans) / [データ](https://huggingface.co/datasets/dadinghh2/HumTrans)。鼻歌だが譜面由来MIDIと実演時刻を区別する。[後続研究](https://arxiv.org/abs/2410.05455)はonset/offset注釈の問題を指摘。採用前に配布条件・話者/曲分割・注釈対応を追加確認する。

## holdout前の採否固定

境界候補V2（`5dc3a429a9427314fab7b841fdf75e40462f76526d0e4b9e98d4860c45ce42ff`）はdevelopment/validationの休符誤占有悪化と周期環境音の反例により不採用。探索実装は再現資料として` scripts/evaluation/boundary-candidate.ts`へ隔離し、製品から参照しない。16kHz YIN、pYIN、CREPE tiny/fullも開発比較から採用しない。final holdoutでは現行48kHz YINと任意Basic Pitchだけのbaselineを測り、候補の再調整に使わない。未知データでの改善は主張しない。
