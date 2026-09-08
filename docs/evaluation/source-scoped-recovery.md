# 回復した雑音基準を発声区間へ限定する

2026-09-08。[再レビュー5140703429](https://github.com/santa928/perfectPitch/pull/23#pullrequestreview-5140703429)への対応。比較元はDraft head `470c21cdf6d38a9c7e6f535a0a66d6b64b9036e8`。前回の定常雑音付き長音の修正は維持し、別音源へ回復値を無条件継承する回帰を修正した。元main `2befdef5` と初版PR `6b55ff9` の比較は [長音欠落](sustained-voicing.md) / [定常雑音](reviewed-sustained-noise.md) に履歴として保存する。

## 再現した原因

0〜0.3秒white peak0.05、0.3〜1秒220Hz peak0.02+white0.003、以後173Hz peak0.008+white0.003。現headの実モジュールで、live/offlineの背景161窓がすべて有声になり、既存の期待`[0,0]`が`[161,161]`で失敗することを再確認した（`output/source-scope-before.log`）。PCM自体に欠落はない。

回復値が単なるグローバル数値だったため、支持した発声が終了しても別の候補へ使われ続けていた。音高だけで回復を打ち切ると実旋律の跳躍を落とすため、回復を支持した発声と、新しい候補列の根拠を区別する。

## 現在の方式

- 100msの安定した候補と強い周期性による回復条件は維持する。回復値には支持音高、直近約100msのRMS履歴、最終支持時刻を持たせる。
- 同じ発声は現在の候補音高が直前支持から100c以内、周期性0.9以上、必要RMS以上のときだけ維持する。前のHzをコピーせず、滑らかなビブラート/グライドは現在候補へ追従する。
- 最終支持から100ms+解析窓（歌180ms/話160ms）が経過すると回復値は失効する。支持のない窓や休符を有声にする猶予ではない。
- 別音高はまず現在のbackgroundFloorで通常の採用条件を評価する。回復が必要な場合、新しい候補列の連続2窓と、各窓の末尾20msのRMSが前発声のRMS中央値の半分以上であることを要求する。新候補自身の最大残差と前回復値の大きい方を、その新しい発声の回復値にする。前音が混ざった窓の全体RMSだけで弱い新音源を救わない。
- 発声の混在窓を避けて非周期PCMが100ms続けば、その最大RMSから過大なbackgroundFloorを下方再測定する。これにより休符後は最近の実背景で新しい発声を判定できる。開始混在窓が背景値を再汚染しないよう、この再測定は下方更新に限定する。
- live/offlineは同じ判定器を通る。offlineは確認された支持区間に限って各窓の実測候補を再判定する。新音高確認待ちの1hopも対象となり、未知区間の補間はしない。initialGateには支持の種類と期限を残す。

製品差分は今回pipelineのみ。offlineの支持区間再判定をそのまま再利用した。検出器、原PCM、時計、#19の20ms急落補正、編集済みScore、MIDI、#18の自然なピアノ再生は変更していない。通常画面への診断数値追加や外部送信はない。

## 数値比較

[変更前JSON](source-scope-before.json) / [変更後JSON](source-scope-after.json)。`scripts/benchmark-source-scope.ts`で、変更していない470c21cの実srcをread-only mountし、同じfixtureを直接importして比較した。Node v24.18.0 / Linux arm64。

| 173Hz対照（16/44.1/48kHzすべて同じ結果） | 470c21c | 今回 |
| --- | --- | --- |
| 弱い別音源の有声窓、live/offline | 161/161 | 0/161 |
| 同音量の100ms実跳躍+white0.005、liveの正しい窓 | 6/11 | 5/11 |
| 同実跳躍、offlineの正しい窓 | 6/11 | 6/11 |
| 同実跳躍の連続音符長、live/offline | 60ms/60ms | 50ms/60ms |
| 400ms実休符後の再発声、live/offline | 121/121 | 121/121 |

新音高のlive確認には1hop=10msの追加待機がある。100msのPCMがそのまま100msの音符になるとは主張しない。元から解析窓による境界短縮があり、今回のliveでの1hop差と、#22の音符境界/記譜課題を分けて残す。

指定レビューの元PCMと3周波数の対照は別にテストしている。`tests/source-scope.test.ts`は16/48kHz、歌/話、live/offline、110/173/330Hzについて、弱い背景の有声0と、0.97未満の窓を含む雑音付き100ms実跳躍の正しい窓3個以上・連続音符30ms以上を確認。100/400ms休符、同音/別音高での再開、一括/固定/可変chunk、PCM非破壊も含む。音量60%への100ms跳躍も3周波数・両mode/live/offlineで30ms以上の音符を保持した。

前レビューの6秒220Hz+white0.005は、16/44.1/48kHzのlive/offlineで引き続き481/481。元Issue #20の純音99%以上、漸減、即発声、低高音、弱い基音/倍音/ビブラート、実休符・再発音、100ms実低音/20ms偽急落の回帰も維持する。

## 試行と独立レビュー

最終ローカル検証は **単体170件の全suite成功、独立レビュー後に期限失効1件を加えた関連10件も全成功（計171件）、TypeScript/Vite build成功、Chromium34件すべて成功**。追加時に製品コードは変更していない。VexFlow約729kBの既存chunk警告は残る。ブラウザはPlaywright v1.62.1のDockerイメージ、ソースを固定して実行した。

実AudioBuffer→MediaStream→AudioWorklet→CaptureSession→Workerの合成録音は、定常雑音あり/なしでlive/offline後半100%。ACK/受信/保持PCMは307,840 samplesで内容一致。同じ取得PCMをFloat32 WAVとして通常ファイル入力へ渡し、時計と中盤Hzを比較した。雑音ありの最終有声中心は録音/ファイルとも6.01秒、音符末尾6.015秒。Worker出力はモックしていない。

定常雑音付き30/60秒PCMの本番timeout付きWorker解析は11.750/23.910秒で完了し、末尾29.96/59.96秒、2,993/5,993 frames、進捗1。Docker単回値で、実機性能保証や物理マイク連続録音の証拠ではない。無音・white・息状・子音状対照は全mode/校正対照で0/231、音符0。既知の強い60Hz周期環境音は231/231のまま。

- 最初の新音高確認は20ms追加待機だった。雑音付き100msの330Hzや音量60%の短音でliveの正解が2窓へ短縮し、30ms音符条件を満たさなかった。60/80msの解析窓に待機を重ねたことが原因。連続2実測窓（1hop待機）へ変更し、期待値を緩めず保持を確認した。
- 背景の高速再測定を上下両方へ適用する試行では、発声開始の混在窓が静かな基準を再び高くした。下方更新に限定し、400ms休符後の再開と9秒静音後の弱い発声回帰を回復した。
- 独立レビューは実際の差分と固定PCMをDocker内で確認し、最終1hop版にblocking指摘はなかった。非blocking指摘の「100/400ms休符をともに失効と呼ぶ」「期限自体がテストされない」にも対応。休符テスト名を修正し、400ms後に前発声の回復値より大きい実背景を使って再開する対照を追加、期限切れの回復値を流用した場合は検出できるようにした。未知の話者/音源に対する普遍的な分離性能は評価していない。

## 要件差分・受入範囲

| 要件 | 状態 | 内容 |
| --- | --- | --- |
| REQ-20-01 長音末尾の保持 | 維持 | 元固定入力99%以上、定常雑音付きの追加入力95%以上 |
| REQ-20-02 原PCM・実休符・短音・編集/再生 | 維持 | Hzをコピーせず、実跳躍と音符保持を対照に含める |
| REQ-20-03 校正回復・録音後再判定 | 維持 | 同じ実測支持区間に限定 |
| REQ-20-04 モデル比較・記譜再設計 | 非対象を維持 | #21/#22で扱い、自動クローズしない |
| REQ-20-05 回復値の帰属と寿命 | 追加 | 指定161/161反例を0へし、3音高・休符・短音も検証 |

受入条件は上記固定対照と既存回帰。非対象は全面的な声/環境音分離、#21のモデル比較、#22の記譜再設計。リスクと対策は下記の識別限界の明示と正負対照。性能目標は60秒PCMで30秒目安・本番Worker timeout 60秒以内を維持する。追加処理は固定長履歴と末尾20msの走査で録音時間に比例し、追加YIN走査はない。元PCMの保持量は変えない。

## 再現コマンド

開発実行は全てDocker。依存は既存Docker volume、ログや中間PCMはGit対象外のoutput/。比較JSONは合成音の集計と少数の診断窓のみで、個人音声は含めない。

```sh
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types --test tests/source-scope.test.ts tests/review-sustained-noise.test.ts
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types scripts/benchmark-source-scope.ts
# /absolute/path/to/base は470c21cの未変更srcを含むcheckout
docker run --rm -v /absolute/path/to/base:/baseline:ro -v "$PWD":/app -w /app node:24-bookworm-slim node --experimental-strip-types scripts/benchmark-source-scope.ts --baseline
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types scripts/benchmark-sustained-noise.ts
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm browser sh -lc 'npm run build && npx playwright test'
```

## 識別限界と未検証

RMSの半分という条件は音源の同一性を証明しない。音量が連続する別の周期環境音や、同じ音高/滑らかに変化する環境音は採用され得る。逆に、別音高へ移ると同時に測定RMSが半分未満へ下がる本人発声は欠落し得る。入力gainの比率と末尾20msの測定RMS比は、位相/低音の周期/雑音で一致しない。この境界を「半分までの声を全て保証」と解釈しない。明瞭な支持のない弱い開始も未解決で、一般の鼻歌精度/環境音分離は#21の未知音源評価に残す。短音のタイミング/記譜と楽譜どおりの実演品質は#22に残す。

今回のユーザー音声は未取得。物理マイク、iPhone Safari/Android、Bluetooth、OS中断、実騒音下の主観品質は未検証。合成AudioWorklet/WorkerやPlaywright Chromiumは物理端末の代替ではない。WebKit/Firefox行列、Lighthouse、公開URL smokeは、ブラウザAPI/UIを変更せずマージ/公開もしないため未実施。実機互換性の変更または公開前に必要なゲートを実施する。

実機ではPRブランチの検証版で、6秒の長音を途中から弱める、短く音高を上下する、100/400ms休んで同音または別音で再開する、を試す。元の声・青線・連続音高・譜面末尾を照合し、通常ピアノの自然減衰を音符欠落と混同しない。声の後に環境音だけ残る試行も対にする。iPhoneにはPRブランチのHTTPS検証版が必要だが、今回は配信しない。個人音声をGitHubへ公開添付しない。
