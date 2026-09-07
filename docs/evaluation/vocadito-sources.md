# vocadito 評価素材の取得と分割

出典は Bittner, Rachel; Pasalo, Katherine; Bosch, Juan José; Meseguer Brocal, Gabriel; Rubinstein, David (2021), **vocadito v3**, DOI [10.5281/zenodo.5578807](https://zenodo.org/records/5578807)。原データは [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) で提供される。40件の単音歌唱について、人手F0と2名の独立した音符注釈がある。公式データ構成の説明は[技術報告](https://arxiv.org/abs/2110.05580)も参照。

このリポジトリには原音・F0 CSV・音符CSV・歌詞を同梱しない。[取得スクリプト](../../scripts/fetch-vocadito.py)が公式の固定版をダウンロードし、音声と評価注釈を ignored `output/service-quality/vocadito/` へ分離保存する。歌詞は抽出しない。再配布する場合にも、上記著作者・出典・ライセンス・変更内容の表示を保持する。

## 固定アーカイブ

|項目|値|
|---|---|
|取得先|[Zenodo公式 v3 ZIP](https://zenodo.org/api/records/5578807/files/vocadito.zip/content)|
|正確なサイズ|58,492,257 bytes|
|公式MD5|`dea40fd18f14d899643c4ba221b33a46`|
|取得物のSHA256|`e0d6b99d3f9c594afe5ae5c4d7bdacebe569e53b809e90b89d1c771c4f9990e3`|

3条件全てを照合してから、完全一致するメンバー名だけを読み出す。ZIPを一括展開せず、重複名、symlink等の非通常ファイル、パス逸脱、暗号化、サイズ超過を拒否する。既存の原音や注釈と内容が異なる場合は上書きしない。

## プロジェクト内の固定分割

|用途|ID|歌手ID|言語（公式メタデータ）|
|---|---|---|---|
|開発|1|S1|Tagalog|
|開発|2|S2|Spanish|
|開発|17|S12|none（論文では「la」の歌唱）|
|最終確認|4|S3|Catalan/Valencian|
|最終確認|24|S19|French|
|最終確認|35|S28|Mandarin|
|最終確認|37|S29|Hawaiian+English|

7歌手が重ならず、低い声・高い声・言語なしの歌唱を開発側へ含める方針で、音声分析前に選んだ独自分割である。公式の標準分割ではない。最終4曲は候補ハッシュ固定後に初めて推論・採点した。公開後の再実行は回帰検証であり、新規holdoutではない。上流モデルの学習・評価データとの独立性は保証していない。特にSwiftF0の論文はvocaditoを評価に用いている。

## Docker内での取得

標準では開発用3曲だけを抽出する。公式ZIP全体はキャッシュするが、最終4曲の原音・注釈を個別に読み出さない。

```sh
docker run --rm -v "$PWD:/app" -w /app python:3.12-bookworm \
  python scripts/fetch-vocadito.py
```

候補を固定した後に、同じコマンド末尾へ `--include-final` を付ける。既存の公式ZIPを使う場合は `--archive output/service-quality/vocadito.zip`、別の評価ディレクトリへ保存する場合は `--output output/別名/vocadito` を指定できる。取得と保存先は `output/` 配下に限定する。ランナーの標準入力先は `output/service-quality/vocadito`。

各曲の `input.wav` と `f0.csv`、`notesA1.csv`、`notesA2.csv` は元バイト列を保持する。派生 `referenceA1.json` / `referenceA2.json` は、開始秒・Hz・長さ秒から `{start,end,midi}` へ変換する。MIDIは `floor(69+12*log2(Hz/440)+0.5)`、終了秒は開始秒＋長さ秒。正解注釈はブラウザの音声解析へ渡さず、推論後にNode側で採点する。

F0の0 HzはF0なしを表す。一方、音符注釈は子音などの0 Hz区間にまたがる場合がある。F0精度と音符の有声／無声区間への重なりを分け、A1/A2を別々に評価する。vocaditoの正解BPMはこの評価で利用できないため `null` とする。
