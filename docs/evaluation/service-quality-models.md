# 端末内採譜モデルの比較と再現方法

追補：この初回比較の後、既使用素材で[曲中の休符再判定](service-quality-rest-recovery.md)を比較・追加した。以下の「固定」「最終確認」は初回の選定段階を指し、追補の回帰素材を新規holdoutとは呼ばない。

標準のYIN推定を維持し、Basic Pitchの単音デコードを**元推定へ戻せる任意の再採譜**に採用する。新規4曲の発音F1はほぼ同等で、終了時刻の精度と短音には悪化があるため、全面置換や自動選択を正当化する結果ではない。

集計の全数値・設定・ハッシュは [service-quality-models.json](service-quality-models.json)、素材の取得条件は [vocadito-sources.md](vocadito-sources.md)、PJSの由来は [vocal-score-sources.md](vocal-score-sources.md) に記録した。私的音声の結果や音符列はこの公開資料に含めない。

## 調べた方式と採用範囲

|方式|一次資料・配布条件|確認結果|
|---|---|---|
|Basic Pitch Python / ONNX|[公式ソース固定版](https://github.com/spotify/basic-pitch/tree/fa5997af0a8210982619003269994a1be25eddf3)、[Apache-2.0](https://github.com/spotify/basic-pitch/blob/fa5997af0a8210982619003269994a1be25eddf3/LICENSE)|note活動・onset・細かいpitch contourを出力。単音も対象だが標準音符デコードは多音対応。ONNXを採用|
|Basic Pitch TypeScript / TFJS|[公式TS固定版](https://github.com/spotify/basic-pitch-ts/tree/2d498f82b61c71898edf0e8dd661b99076676c8b)、Apache-2.0、npm 1.0.1|TFJS 3.21.0 CPU/WASMを実行。WASMで公式frame生成のFill dtypeエラーがあり、明示float32窓にして検証。公式ラッパー無改変での成功とは扱わない|
|ONNX Runtime Web|[公式Web API](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)、[実行環境設定](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html)、MIT|1.29.0のWASM CPUを実測。モデルとWASMを自己ホスト。商用配布でもライセンス・必要なthird-party noticeを保持|
|SwiftF0|[公式固定版](https://github.com/lars76/swift-f0/tree/64700fce8ef39c2970814bf427ac1d75a2f20d72)、[論文](https://arxiv.org/abs/2508.18440)、MIT|16kHzのF0/confidenceモデル。音符onsetの直接モデルではない。0.1.2と公式main ONNXをCPUで比較。標準置換は不採用|
|ROSVOT|[公式実装](https://github.com/RickyL-2000/ROSVOT)|MITコード、PyTorch/RMVPE等の経路。公式ブラウザ実行・checkpoint配布条件・サイズを十分確認できず、実測対象外|
|VOCANO|[公式実装](https://github.com/B05901022/VOCANO/tree/669b3faa2e3df4aaba84844496c7cb370b6feb1d)|MITコード、CFP/PatchCNN/PyramidNet。公式ブラウザ/ONNX配布は未確認、学習済み重みの配布条件・速度は実測対象外|

## 固定した単音デコード

Basic Pitchの88鍵note活動に休符状態を加えた系列選択を使う。音状態の観測費用は `-log(max(.015,p))-.4`、休符は `-log(max(.015,1-max(p)))`。同状態の移動費用は0、休符との移動は10、異なる音は `10*(1-.8*onset)`。YINが有声だったピッチへの必須絞り込みはしない。

同音の再発音はonset≥.5の局所極大、7フレーム以上の間隔、近傍±2フレームの活動回復がある場合に区切る。3フレーム未満は除外する。倍音の複数音符を並行して出さず、無声区間でも常に音を強制する構造にはしない。ただし長い持続を優先するため短い実音を消す反例が残る。

固定候補のSHA256は `d3b19d6aee70b4e068385335f52696bf616374deb48bd89581222b653c854885`。このハッシュは研究用exportのもの。本番への移植でファイル全体のハッシュは変わるため、再現ランナーは本番ソースとlockfileのハッシュを別途記録する。

公式ONNXはfloat32 mono 22,050Hz、入力 `serving_default_input_2:0`、形状 `[1,43844,1]`。先頭に3,840サンプルの0を付け、43,844窓を36,164 hopで送り、末尾を0埋めする。出力は `StatefulPartitionedCall:1` note `[1,172,88]`、`:2` onset同形、`:0` contour `[1,172,264]`。各窓の15〜156を結合し `floor(原サンプル数*86/22050)` フレームへ切る。時刻は公式補正 `i*256/22050 - ((256/22050)*(172-43844/256)+.0018)*floor(i/172)` を保持した。端末内のみで推論し、音声を外部サービスへ送信しない。

## 開発用で比較した候補

vocadito 1/2/17の2注釈、計6条件の発音F1平均。これらで調整した値は最終結果と混ぜない。

|方式|発音F1|扱い|
|---|---:|---|
|YIN＋現行音符化|0.6543|基準。旧開発比較は校正true|
|Basic Pitch公式TSデコード設定|0.5500|多音の余分な音符が残る|
|公式Pythonデコード設定|0.6066|最小長などがTS設定と異なる|
|固定単音DP|0.6523|任意の再採譜へ|
|YIN soft融合の最良開発候補|0.6482|不採用|
|固定DP＋短いYIN音の局所保護|0.5849|不採用|
|SwiftF0＋現行音符化|0.6006|不採用|
|SwiftF0公式segment_notes|0.6447|標準置換の根拠不足|

短音保護は、30〜150msの同一整数MIDI、有声periodicity≥.9、pitch幅≤.5、前後30ms以上が別pitchという固定ルールで音符を挿入し、隣接モデル音を局所分割した。無声ギャップは埋めないが、誤った短音も戻り、PJS010は28→56音、発音F1 .582→.482へ悪化した。

100msの本物octave変化では固定DPが音を欠落・誤octave化する反例が残る。長い倍音付き単音は1音、短い半音変化は3音を保持したが、短音保護後は後者が4音へ過分割した。特定反例の救済だけで標準化しない。

SwiftF0は開発用91.988秒で、F0のraw RPA50がYIN .9063→.9554、有声recall .9202→.9738へ改善した。採用有声に限るRPAは .9404。両方式とも有声だった地点の中央値cents誤差はYINの方が小さかった。合成12条件の正しい有声率はYIN96.22%に対しSwift46.64%、追加24条件でも90.53%対15.83%で、短音や音色の反例が強い。SwiftはCPU1thread、再標本化込み3.492秒、YIN31.094秒。Swiftブラウザ速度は未測定であり、CPU値をブラウザ値として示さない。

## 固定後の最終確認

最終4曲はvocadito 4/24/35/37。元44.1kHzからscipyのpolyphase再標本化で、YINへ48kHz、モデルへ22.05kHzを渡した。YINはファイル用の校正false。PJS017は以前の検証でも使った回帰素材で、新規holdoutから除く。

|新規4曲×2注釈の単純平均|YIN|固定モデル|
|---|---:|---:|
|生音符：発音F1|0.5846|0.5862|
|生音符：発音＋終了F1|0.5106|0.4443|
|生音符：正規化edit距離（小さい方が良い）|0.599|0.499|
|手動120 BPM譜面：発音F1|0.5620|0.5991|
|手動120 BPM譜面：発音＋終了F1|0.4992|0.4547|

vocadito24では推定54→17音となり、発音F1も悪化する。一方35/37では改善する。PJS017の生音符F1は .559→.588、120BPM譜面では .262→.537。このばらつきから任意選択と元推定への復帰を必要と判断した。

最終5素材×2方式のテンポ提案は全て `reliable=false`、通常経路は120 BPMへfallbackした。vocaditoの正解BPMは不明。PJS017は元譜が120 BPMでも、手動固定やfallbackを自動テンポ成功とは数えない。YIN校正true/falseは全5曲で音符数と発音F1が同じだったが、2曲で細かい時刻が変わった。開発trueと最終falseの無条件な合算は避ける。

音符照合は整数MIDI完全一致、onset許容100ms、offset許容 `max(100ms,正解音長の20%)`、最大1対1対応。音高列はLevenshtein距離。楽譜はタイを結合した `scoreToPiano` に `score.origin` を足し戻して原音時計で採点する。時刻合わせや移調はしない。

人手F0の時計で25ms以内の最近傍を採り、raw RPA/RCA50は推定有声判定にかかわらず利用できるHzを比較する。accepted RPAは推定有声も必要。Basic PitchのRPAは適用外で、0 Hz区間へのnote活動と最終音符coverageを分けた。人手音符も0 Hzにまたがるためcoverageだけで誤りとは断定しない。公開ランナーの本番APIはraw活動を返さず、音符coverageのみ再現する。

## サイズと速度

|配布物|bytes|gzip参考値|
|---|---:|---:|
|Basic Pitch公式ONNX|230,444|112,080|
|Basic Pitch TFJS model.json＋weights|916,929|436,125|
|ORT 1.29.0 SIMD threaded WASM|13,961,845|3,613,373|
|TFJS 3.21.0 threaded SIMD WASM|386,833|124,967|
|SwiftF0 0.1.2 ONNX|399,114|未測定|

ONNXモデルSHA256は `2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec`。モデルだけでなくORTのJS/WASMと通知文の配布容量も必要。JSONに個別assetハッシュを掲載した。gzip値は実ファイルの圧縮実測で、配信サーバの圧縮を保証しない。

|推論のみの秒数|PJS010（18秒）|PJS040（8秒）|
|---|---:|---:|
|TFJS CPU|21.115|8.614|
|TFJS WASM 2thread|2.653|0.805|
|ONNX native CPU 2thread|0.512|0.138|
|ONNX browser WASM 2thread|0.815|0.332|
|ONNX browser WASM 1thread|1.039|0.376|

Docker Desktop aarch64、10 CPU・8.218GB、Playwright 1.62.1 Chromiumで各1回。asset load、再標本化、DP、UI描画はこの表に含まない。最終4曲の1threadブラウザ推論は .726〜1.867秒、load .394秒。DPはNodeで .071〜.239秒測定したが、ブラウザDPの測定値ではない。モバイル・長時間メモリ・多ブラウザの保証は未達。

## 位相調整の試作

最初の発音を譜面originとする基準に対し、16分gridの前後0.5tickを129点探索した。二乗誤差を最小化する方式と、誤差を.04でclipして短音の重みを抑える方式を比較。正解の時刻をfitには使っていない。

開発vocadito 3曲×2注釈、手動120BPMで発音F1は基準 .6428、二乗誤差 .6367、robust .6288。終了F1も .5033→.4951/.4855へ悪化した。PJSに局所改善はあるが、一貫した改善がないため標準には採用しない。JSONの36行はPJS017の「手動120」と「公式120」が同じBPMになる重複条件を保持している。BPM推定性能の根拠には使わない。

## 公開スクリプトで再実行する

[benchmark-service-quality.ts](../../scripts/benchmark-service-quality.ts) はViteを自動起動し、Playwrightの実Chromiumから本番 `reanalyze`、`extractMelody`、`transcribeMelody`、`suggestTempo`、`buildScore`、`scoreToPiano` を呼ぶ。WAVをブラウザの `decodeAudioData` で48kHzにし、チャンネル平均でmono化する。モデル再標本化も本番API内で実行する。参照音符/F0はブラウザに渡さない。通信は同じローカルoriginだけを許可する。

```sh
# 取得後、DockerのPlaywright環境で依存を用意して実行（標準はdev3曲）
docker compose -f docker-compose.test.yml run --rm browser \
  sh -lc 'npm ci && npm run prepare:transcription && node --experimental-strip-types scripts/benchmark-service-quality.ts'

# 既取得の最終4曲とPJS010/017/040も含め、別の出力名へ保存
docker compose -f docker-compose.test.yml run --rm browser \
  sh -lc 'npm run prepare:transcription && node --experimental-strip-types scripts/benchmark-service-quality.ts --include-final --include-pjs --output output/service-quality/browser-all-NEW.json'
```

PJSは既存の `scripts/fetch-score-evaluation.py` で取得する。`--only vocadito_1` で小範囲のsmokeが可能。最終曲は `--only` を指定しても `--include-final` が必要。出力は既存ファイルを上書きしない。

新しいランナーは**現在の本番経路**を再現する。過去のTFJS実験、SwiftF0、32設定探索、soft融合、短音保護、位相fitの試作コード・活動配列は公開していないため、JSONはそれらの実験アーカイブとして読む。固定モデル試作と本番では再標本化実装・Worker境界が異なり、数値の完全一致を約束しない。新ランナーの `totalSeconds` はload・再標本化・DP込みで、過去の「推論のみ」と比較しない。ソースハッシュ、音声/注釈ハッシュ、実ブラウザ情報、両注釈の生音符・楽譜指標、manual/automatic BPMを出力する。

TypeScript strict型検査・CLIヘルプ、Pythonのruff/mypy、公式ZIP照合と開発3曲の一時抽出、CSV変換、不正値・ZIPパス/symlink拒否をDocker内で検証した。2026-09-07に本番経路の全10曲を再実行し、[本番結果JSON](service-quality-browser-results.json)・[検証記録](service-quality-verification.md)へ分離保存した。固定最終結果を使ったパラメータ再調整はしていない。最終4曲の再実行は新たな未使用素材の評価ではない。
