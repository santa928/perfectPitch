# PR #23 追加レビュー：定常雑音下の長音欠落

以下は`470c21c`時点のDraft記録。再レビュー5140703429への対応で、回復値の帰属/寿命を導入して下記161/161回帰を修正した。現行の方式・検証・残る識別限界は [発声区間への回復値の限定](source-scoped-recovery.md) を参照。以下の「未解決1件」「最終方式」は当時の状態を示す。

**Draft・未解決回帰あり。指定レビューの長音入力は改善したが、修正全体の確認完了とは扱わない。** 明瞭な声の後の別音高の周期背景音を追加採用するため、期待0の単体テストを失敗のまま残した。マージ・公開しない。

2026-09-08。[レビュー5140352157](https://github.com/santa928/perfectPitch/pull/23#pullrequestreview-5140352157)を、対象SHA `6b55ff93b6e70974ca96c1d58dd1a082b5831f70` の実製品モジュールで独立再現した。元mainは `2befdef5a4ad168868d7d54dcd04cfb270787d3f`。初版の検証記録は [sustained-voicing.md](sustained-voicing.md)。ユーザーの今回の音声は未取得で、個人音声は使用・送信していない。

## 確認した原因と最終修正

48kHz/6秒の原PCMは288,000 samples、最後のフレーム中心は5.96秒まで存在した。0.8秒以降にpeak0.005の固定seed白色雑音を重ねると、5秒の候補は221.0908948Hz、周期性0.9606043、RMS 0.01457398。初版はnoiseFloor 0.02877791、requiredRms 0.08057815のまま、採用Hzはnull/uncertainになった。live/offlineとも後半1〜5.8秒が0/481。音符化より前の有声判定で落ちており、PCM欠落やピアノの減衰ではない。

初版は周期性0.97以上の現在窓でだけfloorを迂回し、noiseFloor自体を変更しなかった。周期性が下がると古いfloorへ戻り、uncertainでは更新しないため回復しない。今回は次の方式とした。

1. 100msの連続した現在候補（周期性0.9以上、RMS 0.0028以上、音高幅100c以内）に、周期性0.97以上の4窓の支持を求める。その残差振幅の最大値（下限0.001）で、過大なnoiseFloor自体を更新する。開始が明瞭に確認された後は、周期性が0.97未満になっても更新後のfloorで発声を維持する。
2. 低周期性PCMだけから得たbackgroundFloorを別に保持する。周期性0.9未満にはこちらを使い、明瞭な先行音の回復値が弱い周期環境音へ漏れないようにする。silence判定も同じ有効floorで行い、静かな部屋になった後の雑音追従を止めない。
3. offlineは回復が確認された同じ約100msの支持区間だけを見直す。各窓の原PCM由来のHz/周期性/RMSでuncertainを再判定し、候補のない区間・実休符・録音全体へ未来のfloorを流用しない。初版と同じ長い棄却は校正更新により生じなくなり、確認待ちの短い先頭区間も回復できる。
4. initialGateに更新前後のfloor、backgroundFloor、支持開始を保存し、offlineで見直した窓にはvoicingReviewを追加する。通常UIへの数値追加や自動送信はない。

製品変更はpipeline/offline。原PCM、sample clock、検出器、#19の20ms偽急落補正、編集済みScore、MIDI、#18の自然なピアノ再生の実装は変更していない。採用条件の詳細は [仕様書](../仕様書.md) に同期した。

## 修正前後

[レビュー対象の数値](reviewed-noise-before.json) / [最終方式の数値](reviewed-noise-after.json)。Docker Node v24.18.0 / Linux arm64、同一fixtureと実モジュールを直接import。比較元はgit archiveで取り出した変更していない元ソースをread-only mountした。

| 条件（16/44.1/48kHz、live/offlineそれぞれ） | 初版 | 今回 |
| --- | --- | --- |
| 0.8秒から定常雑音、校正あり、後半1〜5.8秒 | 0/481 | 481/481 |
| 同一PCM、校正なし | 481/481 | 481/481 |
| 冒頭だけ無音、校正あり | 481/481 | 481/481 |
| 回復済み純音へ2秒から雑音、2.2〜5.8秒 | 0/361 | 361/361 |
| 最後の有声中心（定常雑音あり） | 0.80秒 | 5.96秒 |
| 連続音符末尾（定常雑音あり） | 0.805秒 | 5.965秒 |

元Issue #20の純音固定再現99%以上、3レート、漸減、即発声、低高音、弱い基音/倍音/ビブラート、chunk時計、100ms実低音/20ms偽急落の既存回帰も維持する。レビュー入力の受入下限95%に対し実測は全481/481。

## 敵対的レビューで棄却した案・修正した反例

- 周期性0.9以上の100msだけで自己回復する試行は、173Hzの狭帯域雑音（peak0.012 + white0.004、seed71）をsongで0/221から221/221へ増やしたため不採用。最終方式はlive/offlineとも0/221。周波数173Hzの特例は実装していない。
- 明瞭な220Hzの先行音の後、周期性0.8501〜0.8784の173Hz背景音（peak0.012 + white0.006、seed923）をspeechで0/161から161/161へ増やす試行も棄却。低周期性へ回復値を適用しない最終方式は0/161。
- 二つのfloorを持つ試行では、回復後の低周期性white雑音をunvoicedとし、backgroundFloorの追従が止まる反例も見つかった。silence判定と有声判定の基準を揃えて修正。静かな背景9秒後の弱い発声をlive/offlineで95%以上保持する12秒回帰を追加した。
- **未解決:** 同じ明瞭な220Hzの先行音の後、173Hz peak0.008 + white0.003へ移ると、周期性約0.909〜0.927の背景をlive/offlineとも初版0/161から161/161へ増やす。先行音をwhiteへ置換すると0/161。回復値が別の音源にも適用されることが原因で、0.9未満だけにbackgroundFloorを使う制限では防げない。`未解決: 明瞭な先行音の回復値を別音高の周期背景音へ引き継がない` は期待 `[0,0]` に対し `[161,161]` で失敗する。音高変化だけで打ち切ると本物の跳躍を落とすため採用せず、回復の有効範囲と現在の雑音根拠を設計し直す必要がある。これは既知60Hzとは別の追加回帰で、Draft解除の阻害条件。
- 明瞭な支持が一度もない弱い雑音混じり発声（最初0.3秒の雑音の後、220Hz peak0.02 + white0.005だけが続く）は、最終方式も後半0/481。機械音との識別根拠なしに救う案を不採用とした結果であり、この条件を改善済みと数えない。元Issue固定入力やレビューの再現（先頭に明瞭な発声あり）とは区別する。後から明瞭な支持が得られた場合だけ、同じ100ms内の先頭窓をofflineで回復することを別にテストした。
- 無音、white、息状colored AM、子音状burstsの対照と、実休符・同音再発音・雑音下100ms低音・短い支持のリセットを維持。強い60Hz周期環境音を拾う初版の限界は残り、完全な声/雑音分離は主張しない。

## 要件差分と受入範囲

| 要件 | 状態 | 内容 |
| --- | --- | --- |
| REQ-20-01 長音末尾の保持 | 維持・拡張 | 純音に加え、指定レビューの定常雑音付き入力を追加 |
| REQ-20-02 原PCM・実休符・短音・編集/再生 | 維持 | 補間せず既存経路と回帰を検証 |
| REQ-20-03 校正回復・録音後再判定 | 追加 | floor更新と支持区間限定の再判定、独立反例を固定 |
| REQ-20-04 モデル比較・記譜再設計 | 非対象を維持 | #21/#22で扱う。自動クローズしない |

受入条件は指定固定入力の99%以上、追加レビュー入力95%以上、雑音/休符/短音/再発音回帰の維持。非対象は#21の全面的モデル比較と#22の記譜再設計。リスクと対策は周期環境音・弱い開始条件の明示と固定対照、実機未確認の分離。性能目標は既存60秒PCM/30秒目安および本番Worker timeout 60秒以内。追加計算は固定長支持列と短い再判定区間でO(フレーム数)、YIN追加走査はなく、原PCM保持量は変えない。

## 再現コマンド

最終のローカル検証は単体 **161件中160件成功・上記未解決1件失敗**。期待値を緩めずDraftのブロッカーとして保持。TypeScript/Vite build成功、Chromium **34件全成功**。途中のブラウザ実行1件はソース編集中のVite再読込で実行contextが失われたため無効とし、コード固定後に全34件を再実行した。既存VexFlow chunk約729kB警告は残る。

実AudioBuffer→MediaStream→AudioWorklet→CaptureSession→Workerの合成録音は、定常雑音あり/なしの両方でlive/offlineの正しい後半有声100%。ACK/受信/保持は307,840 samplesで内容一致。同じ取得PCMをFloat32 WAVにして通常ファイル入力へ渡し、時計と持続区間Hz列を比較した。雑音ありの最終有声中心は録音/ファイルとも6.01秒、音符末尾6.015秒。この合成経路はWorker出力をモックしていない。

本番timeout付きWorkerへ定常雑音付き30/60秒PCMを渡し、11.741/23.453秒で完了。有声中心は29.96/59.96秒、2,993/5,993 frames、進捗1。Dockerの単回値で実端末の性能保証ではなく、30/60秒の物理マイク連続録音でもない。無音/white/息状/子音状対照は両mode・校正ありなしで0/231・音符0。既知の強い60Hz環境音は231/231のまま。

開発実行は全てDocker。依存は既存Docker volumeを使用。生成ログ・trace・中間JSONはGit対象外のoutput/へ保存。

```sh
# 全単体（指定レビューと独立反例を含む）
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit
# レビュー入力だけを実モジュールで再現
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types --test tests/review-sustained-noise.test.ts
# 最終方式の3レート・対照・残る弱い開始条件を数値化
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types scripts/benchmark-reviewed-noise.ts
# /absolute/path/to/base は6b55ff93の未変更ソース
docker run --rm -v /absolute/path/to/base:/baseline:ro -v "$PWD":/app -w /app node:24-bookworm-slim node --experimental-strip-types scripts/benchmark-reviewed-noise.ts --baseline
# 雑音対照
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm unit node --experimental-strip-types scripts/benchmark-sustained-noise.ts
# 実Worklet/Worker、録音とファイル入力、30/60秒、既存編集・MIDI・ピアノ
docker compose -p pitch-issue20 -f docker-compose.test.yml run --rm browser sh -lc 'npm run build && npx playwright test'
```

## 未検証・実機確認

今回のユーザー録音、物理マイク、iPhone Safari、Bluetooth、OS中断、実騒音下の主観品質は未検証。Playwright Chromiumや合成PCMはその代替ではない。WebKit/Firefox行列、Lighthouse、公開URL smokeは、ブラウザAPI/UI構造を変えず公開もしないため未実施。実機互換性の変更または公開前に必要なゲートを実施する。#21には弱い開始・周期環境音・未知話者評価、#22には短音量子化・リズム/音符境界と楽譜どおりの実演品質を残す。

PRブランチをDockerのローカル検証版で開き、開始0.3秒静かにして6秒伸ばし、途中から声を弱める。別試行で小さな環境音がある状況、即発声、0.4秒休符を挟む同音再発音を比較する。元の声・青線・連続音高・譜面末尾を照合し、ピアノの自然減衰と音符終了を区別する。残る場合は端末/ブラウザ/マイク、切れる時点、元音声が続いているかを記録する。個人音声をGitHubへ公開添付しない。iPhone物理マイクにはこのブランチのHTTPS検証版が必要だが、今回マージ・公開は行わない。
