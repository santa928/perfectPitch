# 実音声評価サンプルの出典

## 目的と扱い

Issue #13 の解析経路を、合成音とは別に実在する歌声と日本語話声で確認する。
音声には独立した正解 F0 ラベルがないため、音程精度の保証には使わない。
取得物は `tests/fixtures/downloads/` にだけ保存し、Git・配布物・公開ページへ含めない。

## PJS corpus ver.1.1

- 一次配布ページ: <https://sites.google.com/site/shinnosuketakamichi/research-topics/pjs_corpus>
- 作成者: Junya Koguchi, Shinnosuke Takamichi
- 許諾: 配布ページがコーパス内の全データを CC BY-SA 4.0 と明記
- ライセンス本文: <https://creativecommons.org/licenses/by-sa/4.0/>
- 収録条件: 歌声100曲、対応する読み上げ100発話、静かな部屋、48 kHz
- 固定した配布物: `PJS_corpus_ver1.1.zip`
- アーカイブ SHA-256: `683c00253ee35a62d50de0375bb9d8e003a74338d4ce3495ac3f7ad096abc1ca`

配布アーカイブ内の MusicXML は作曲上の音域・音価であり、歌唱実績の正解 F0 ではない。
このメタデータと実測したWAV長から、次の少数セットを選んだ。

| 用途 | ローカル名 | 選定根拠 | WAV長 | SHA-256 |
| --- | --- | --- | ---: | --- |
| 公式個別サンプル歌声 | `pjs056_song.wav` | 公式ページが歌声例として個別公開、MusicXML MIDI 57–69 | 16.000秒 | `92037425e4b461b4efbcf1c38585e8e5122a3dfb5b41e589ae8c9a9390c250b4` |
| 楽譜上の低音域 | `pjs012_song.wav` | MusicXML MIDI 42–57（選択した4曲中で最低） | 18.000秒 | `7e6f8aaa7de849bc221b932d4ba073d5229902b3957d33b5751eb79878486116` |
| 楽譜上のロングトーン | `pjs068_song.wav` | MusicXML上に4拍の音符、MIDI 47–59 | 12.000秒 | `9da2a1dbdc43000ff1a8dcbbc9c38d774566417c0f29d6ef4ac62db38b109115` |
| 楽譜上の高音域 | `pjs087_song.wav` | MusicXML MIDI 52–72（100曲中で最高音） | 22.286秒 | `e0818ba9c6439b3e18d049bb0bd3fd5e438ad1c0816e0575790afe56467b6ddc` |
| 短い歌唱 | `pjs091_song.wav` | 100曲中で最短のWAV、MusicXML MIDI 48–60 | 6.545秒 | `bbba9a5c8b41b4fedf03a5493b805de549c31293f7529d15efa4f6e19621b32f` |
| 通常の日本語話声 | `pjs056_speech.wav` | 公式ページでも個別公開されている通常発話 | 6.250秒 | `7103bc6a578eafa41e75846969c039f61a4f28b563950b453237e09e0ca09e0e` |

全件とも実測で 48 kHz、mono、24-bit PCM WAV。歌声5件は同一話者の音域・長さの差を見られるが、話者多様性は評価できない。
正解 F0 ラベルは付属しないため、検出率、誤検出率、cents誤差の基準値には使わない。

音声をリポジトリ、成果物、GitHub Pagesへ再配布・アップロードしない。
公開結果に音声または翻案物を含める場合は、CC BY-SA 4.0 の表示・継承条件を別途満たす必要がある。

## 取得

ホストを汚さないため、リポジトリのルートで Docker から実行する。

```sh
docker run --rm \
  -v "$PWD:/workspace" \
  -w /workspace \
  python:3.12-bookworm \
  python scripts/fetch-evaluation-audio.py --accept-license
```

`--accept-license` は、上記の出典と CC BY-SA 4.0 の条件を確認したことを明示するために必要。
約260 MBのアーカイブはコンテナ内の一時領域だけに置き、ハッシュ検証後、上表の6件だけを
`tests/fixtures/downloads/` へ展開する。スクリプトは各WAVのハッシュとフォーマットも検証する。

## 選ばなかった候補

- JVS corpus: <https://sites.google.com/site/shinnosuketakamichi/research-topics/jvs_corpus>
  - 通常の日本語読み上げとして適切だが、公式条件はアカデミック研究、非商用研究、個人利用に限定し、音声の再配布を禁止している。今回の用途はPJSで満たせるため取得しない。
- VocalSet: <https://doi.org/10.5281/zenodo.1193957>
  - 多様な歌唱技法を含むが、公開アーカイブが大きく、日本語話声も含まない。今回の小規模評価セットには取得しない。
