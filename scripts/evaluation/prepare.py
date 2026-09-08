"""vocadito v3を固定3分割へ準備する。音声/注釈はignored outputだけに保存する。"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import io
import json
import math
import sys
import wave
import zipfile
from pathlib import Path

# 既存のZIPサイズ/ハッシュ/通常ファイル/パス検証を再利用する。
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("vocadito_fetch", ROOT / "scripts/fetch-vocadito.py")
assert SPEC is not None and SPEC.loader is not None
fetch = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = fetch
SPEC.loader.exec_module(fetch)

DEVELOPMENT = [1, 2, 3, 4, 8, 15, 17, 24, 35, 36, 37, 38, 39]
VALIDATION = [5, 7, 9, 11, 13, 16, 19, 21, 23, 26, 28, 30, 33]


def main() -> None:
    """全manifestは原本hashだけを読み、指定splitの注釈だけ変換して保存する。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--split", choices=["development", "validation", "final-holdout"], default="development")
    parser.add_argument("--archive", type=Path, default=ROOT / "output/service-quality/vocadito.zip")
    args = parser.parse_args()
    fetch.verify_archive(args.archive)
    records: list[dict[str, object]] = []
    with zipfile.ZipFile(args.archive) as archive:
        metadata = csv.DictReader(io.StringIO(fetch.read_member(archive, "vocadito_metadata.csv", 50_000).decode()))
        for meta in metadata:
            number = int(meta["track_id"])
            name = f"vocadito_{number}"
            split = "development" if number in DEVELOPMENT else "validation" if number in VALIDATION else "final-holdout"
            members = {"input.wav": (f"Audio/{name}.wav", 12_000_000),
                       "f0.csv": (f"Annotations/F0/{name}_f0.csv", 2_000_000),
                       **{f"notes{a}.csv": (f"Annotations/Notes/{name}_notes{a}.csv", 200_000) for a in ["A1", "A2"]}}
            data = {filename: fetch.read_member(archive, member, limit) for filename, (member, limit) in members.items()}
            with wave.open(io.BytesIO(data["input.wav"])) as audio:
                rate, samples, channels = audio.getframerate(), audio.getnframes(), audio.getnchannels()
            records.append({"id": name, "split": split, "speakerGroup": meta["singer_id"],
                            "melodyGroup": name, "sourceGroup": name, "language": meta["language"],
                            "sampleRate": rate, "samples": samples, "channels": channels, "duration": samples / rate,
                            "kind": "singing", "sha256": {key: hashlib.sha256(value).hexdigest() for key, value in data.items()}})
            if split != args.split:
                continue
            folder = ROOT / "output/issue21/corpus" / name
            for filename, value in data.items():
                fetch.save_original(folder / filename, value)
            for annotator in ["A1", "A2"]:
                notes = []
                for row in csv.reader(io.StringIO(data[f"notes{annotator}.csv"].decode())):
                    start, hz, duration = map(float, row)
                    if not all(map(math.isfinite, [start, hz, duration])) or start < 0 or hz <= 0 or duration <= 0:
                        raise ValueError("Invalid note reference")
                    notes.append({"start": start, "end": start + duration, "midi": 69 + 12 * math.log2(hz / 440)})
                fetch.save_original(folder / f"reference{annotator}.json", (json.dumps(notes) + "\n").encode())
    manifest = {"version": 1, "baselineSha": "e1f2bbda77097f2b1e807566d64717211bbcd426",
                "source": fetch.SOURCE, "license": fetch.LICENSE,
                "attribution": fetch.ATTRIBUTION.replace("nearest integer MIDI", "continuous MIDI"),
                "archiveSha256": fetch.SHA256, "compositionIdentityEvidence": "https://arxiv.org/html/2110.05580v2#S2.SS1",
                "annotation": "Tony/pYIN followed by human correction; F0 + independent A1/A2 notes; continuous Hz retained",
                "modelTrainingOverlap": "not guaranteed; pYIN annotation bias; checkpoint-level training audio unavailable",
                "tracks": records}
    # 公開manifestへ絶対パス・音声・正解列を含めない。
    path = ROOT / "docs/evaluation/humming-manifest-v1.json"
    rendered = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode()
    if path.exists() and path.read_bytes() != rendered:
        raise ValueError("Frozen manifest changed")
    if not path.exists():
        path.write_bytes(rendered)
    print(f"Prepared {args.split}; manifest records={len(records)}")


if __name__ == "__main__":
    main()
