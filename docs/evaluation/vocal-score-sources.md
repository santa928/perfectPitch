# 複数テンポ歌唱と公式譜面の評価用データ

## 出典と利用範囲

PJS corpus ver.1.1（作成者: Junya Koguchi / 小口純矢、Shinnosuke Takamichi / 高道慎之介）を使う。
[公式配布ページ](https://sites.google.com/site/shinnosuketakamichi/research-topics/pjs_corpus) は、歌声100曲、対応する話声、MIDI・MusicXML・音素ラベルを公開し、コーパス内の全データを [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) としている。公式ページを2026-09-07に確認した。

音源、原譜面、Float32、音符基準データ、比較用PNG、試聴用WAVは ignored `output/pjs-evaluation/` のみに保存する。
この文書と取得・評価コード、音源を含まない集計結果を公開対象とし、音声や譜面をGit・Web配布物へ含めない。
`reference.json` にも作者、出典、ライセンス、原ファイルのパスとハッシュを保持する。

公式譜面は**作曲上の音高・音価・BPMの基準**であり、実際の歌唱を人手で正解付けしたF0ラベルではない。
歌手の発音の遅れ、ビブラート、音価の揺れ、無声子音は公式譜面と一致しない場合がある。
譜面との差をそのまま解析器のF0誤りと解釈しない。3曲は同じPJS話者のため、話者の多様性は検証できない。

## 解析結果を見る前に固定した選定規則

1. 既存の実音声評価で使用した `pjs012`、`pjs056`、`pjs068`、`pjs087`、`pjs091` を除く。
2. 単一テンポ80・120・180 BPMそれぞれについて、4/4かつタイ統合後12〜40音の譜面に絞る。
3. 各テンポでIDが最小の曲を採用する。音声解析の成否やスコアから曲を差し替えない。

ローカルのメタデータ検査で100 IDを確認した。XMLファイルは101件で、`pjs015` のみ `.musicxml` と `.xml` が共存する。
この重複は今回の3対象に影響しない。80・120・180 BPMの条件適合候補は順に7・8・3件で、最小IDは次のとおり。
採用後の時刻変換は汎用のXML読み取り処理で行い、曲別の音階・時刻補正は設けない。

| ID | BPM | タイ統合後の音符数 | 譜面長 | 元WAV長 | 用途 |
| --- | ---: | ---: | ---: | ---: | --- |
| `pjs010` | 80 | 27 | 18秒 | 18秒 | 調整確認 |
| `pjs017` | 120 | 38 | 16秒 | 16秒 | 候補固定後の最終確認 |
| `pjs040` | 180 | 21 | 8秒 | 8秒 | 調整確認 |

元音声のタイムストレッチでテンポ数を増やさない。`pjs017` は取得・譜面変換のみ先に行い、候補固定までは解析器へ渡さない。
最終確認結果を見て実装修正した場合、その後の `pjs017` の評価を未使用データによる検証とは呼ばない。

## 固定配布物とハッシュ

- ZIP: `PJS_corpus_ver1.1.zip`、275,179,158 bytes
- 公式経路: 上記配布ページ → Google Drive の ver.1.1 Download
- ZIP SHA-256: `683c00253ee35a62d50de0375bb9d8e003a74338d4ce3495ac3f7ad096abc1ca`

| ID | 元WAV SHA-256 | 元MusicXML SHA-256 |
| --- | --- | --- |
| `pjs010` | `02d65da7f6f41cde7b964d03ac47603d5bfc8dea24ac8359cebf60faa0701ad7` | `b7c32a48a8ed4ceb964068152a13226ba46d56f61fcf668c3babbdc496061fce` |
| `pjs017` | `18546ed596335969a0e10d2b70a8998c251bd41003ce0fd72be63071a92eca2b` | `0e180d23bba678beb562bab9ed2a0969470d87bef347c588fc67c9e5d99efd9b` |
| `pjs040` | `2ceff3fc16f5da0bd3d8ecf90e2120c40cdefa2aca90ea9249a48a3127ac5bbd` | `b177be43dc642b1dc081cd5ba3921547d1414c906001fb05566647f94504c623` |

## 取得と生成

ライセンス条件を確認してから、リポジトリのルートでDockerから実行する。実行時の追加Python依存はない。
既存の公式ZIPを再利用する場合も、サイズとSHA-256を毎回検証する。

```sh
docker run --rm \
  -v "$PWD:/workspace" -w /workspace \
  python:3.12-bookworm \
  python scripts/fetch-score-evaluation.py \
  --archive output/pjs-evaluation/PJS_corpus_ver1.1.zip \
  --accept-license
```

`--archive` を省略すると、公式ページのGoogle Drive経路から約275 MBをコンテナの一時領域へ取得する。
`--output-dir` の既定値は `output/pjs-evaluation`。各IDの配下に次を生成する。

| ファイル | 内容 |
| --- | --- |
| `input.wav` | アーカイブにある48 kHz・mono・24-bit PCMの原音をそのまま保持 |
| `input.f32` | 原音の符号付きPCMを `sample / 8388608` で正規化したlittle-endian Float32 |
| `source.musicxml` | 原MusicXMLをそのまま保持 |
| `reference.json` | `{id, role, bpm, notes: [{start,end,midi}], duration, audioDuration, sampleRate, frames, referenceKind, timeOrigin, source, hashes}` |

JSONの `start` / `end` / `duration` は秒。譜面開始を0秒とし、先頭・途中・末尾の休符を除去しない。
`duration` は譜面の全長、`audioDuration` は原WAVの全長。歌唱や推定音符に合わせて時刻原点を移動しない。
元波形の振幅、速度、調は変更しない。正解JSONや原譜面を `src/` の本番解析器へ渡さない。

ZIP全体のハッシュ検証後、固定3 IDのWAVとMusicXMLだけを固定保存先へ書き出す。
重複するZIPメンバー、リンク等の通常ファイル以外、上限を超えるファイル、60秒超の音声・譜面は拒否する。
XMLは2 MiB、WAVは60秒のPCMサイズとヘッダ余裕分を上限とし、XMLのエンティティ宣言も拒否する。
既存出力が同一なら再利用し、内容が異なる場合は上書きせず新しい出力先を要求する。

譜面は `part`、`measure`、`divisions`、`duration`、`rest`、`alter`、`sound tempo`、連続する同音のタイを解釈する。
四分音符単位の有理数で累積するため、divisionsが変わっても時刻を保持する。
タイのない同音再発音は統合しない。多声、和音、テンポ変更、移調楽器、反復、装飾音、4/4以外、崩れたタイは明示的に失敗させる。

2026-09-07の既存ZIP再利用では、ハッシュ検証・3曲展開・Float32/JSON生成に1.180秒を要した。
生成した12ファイルの合計は14,197,467 bytes（元WAV 6,060,288、Float32 8,064,000、原XML 63,536、JSON 9,643 bytes）。
これは当該Docker実行の実測であり、端末一般の性能目標や解析速度を表す値ではない。

## 比較APIと指標

`scripts/score-evaluation.ts` は入出力のみを扱う純粋な評価helperで、音声解析器をimportしない。

```ts
interface ReferenceNote { start: number; end: number; midi: number }
evaluateNotes(reference: readonly ReferenceNote[], estimated: readonly ReferenceNote[])
evaluateTempo(referenceBpm: number, estimatedBpm: number)
```

- `onset`: MIDI完全一致、発音時刻誤差100 ms以内を満たす最大1対1照合。
- `onsetOffset`: 上記に加え、終了時刻誤差が `max(100 ms, 正解音長の20%)` 以内となる最大1対1照合。`onset` とは独立に計算する。
- それぞれ `matched`、`precision`、`recall`、`f1`、`falsePositives`、`falseNegatives` を返す。1つの正解に重複推定音を複数対応させない。
- `pitchSequence`: 発音順の絶対MIDI列のLevenshtein距離。挿入・削除・置換は各1。`normalizedEditDistance` は距離を `max(1, 正解音符数)` で割るため、挿入が多い場合は1を超える。
- テンポの `absoluteError = abs(推定BPM - 正解BPM)`、`relativeError = absoluteError / 正解BPM`。相対誤差1は100%を意味する。
- `octaveReference` は正解BPMの0.5・1・2倍の中で相対誤差が最小の候補を示す参考値。通常BPM誤差は保持し、倍・半分を正解にはしない。

移調、時間シフト、DTW、正解BPMへの強制を行わない。Scoreの相対時刻を評価するときは、Score自身が持つ `origin` を加え、元音声時計へ戻してから渡す。
入力は非負の有限時刻、正の音長、整数MIDI 0〜127、正の有限BPMを要求する。異常値は `RangeError` として拒否する。
両音符列が空ならF1=1、片側のみ空ならF1=0。分母が空のprecision/recallは1とするため、空集合のF1は2PR式ではなく一致数と全音符数から直接定義する。

この取得工程では3曲の解析スコアを算出していない。音符省略・無声区間・同音再発音・BPMの未達は、後続の解析・生成譜面評価で曲ごとに報告する。
