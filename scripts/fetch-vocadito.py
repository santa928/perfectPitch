"""固定した公式 vocadito v3 から評価用7曲を output/ 内へ用意する（標準はdevのみ）。"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import stat
import urllib.request
import zipfile
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path, PurePosixPath
from typing import TypedDict

SOURCE = "https://zenodo.org/records/5578807"
URL = "https://zenodo.org/api/records/5578807/files/vocadito.zip/content"
SIZE = 58_492_257
MD5 = "dea40fd18f14d899643c4ba221b33a46"
SHA256 = "e0d6b99d3f9c594afe5ae5c4d7bdacebe569e53b809e90b89d1c771c4f9990e3"
LICENSE = "https://creativecommons.org/licenses/by/4.0/"
ATTRIBUTION = (
    "Rachel Bittner, Katherine Pasalo, Juan José Bosch, Gabriel Meseguer Brocal, "
    "David Rubinstein (2021), vocadito v3, doi:10.5281/zenodo.5578807, CC BY 4.0. "
    "Original audio/F0/notes CSV unchanged; derived reference JSON converts pitch Hz "
    "to nearest integer MIDI and duration to end time."
)
PROJECT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Track:
    """音声分析前に固定した、歌手が重ならないプロジェクト内の分割。"""

    number: int
    split: str

    @property
    def name(self) -> str:
        """公式配布物に一致するIDを返す。"""
        return f"vocadito_{self.number}"


TRACKS = tuple(Track(i, "development") for i in (1, 2, 17)) + tuple(
    Track(i, "final") for i in (4, 24, 35, 37)
)


class ReferenceNote(TypedDict):
    """アプリには渡さず、推論後の採点だけに使用する正解音符。"""

    start: float
    end: float
    midi: int


def output_path(value: Path) -> Path:
    """symlink解決後もプロジェクトの output/ 配下にある書き込み先だけ許可する。"""
    path = value.resolve()
    root = (PROJECT / "output").resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError("出力先はこのプロジェクトの output/ の子ディレクトリにしてください")
    return path


def verify_archive(path: Path) -> None:
    """公式MD5と取得時固定SHA256・正確なバイト数を全て照合する。"""
    sha, md5 = hashlib.sha256(), hashlib.md5(usedforsecurity=False)
    size = 0
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            size += len(block)
            if size > SIZE:
                raise ValueError("vocadito archive exceeds pinned size")
            sha.update(block)
            md5.update(block)
    if (size, sha.hexdigest(), md5.hexdigest()) != (SIZE, SHA256, MD5):
        raise ValueError("vocadito archive size/SHA256/MD5 mismatch")


def download_archive(path: Path) -> None:
    """未取得時だけ公式URLから上限付きで取得し、検証済みファイルへrenameする。"""
    if path.exists():
        verify_archive(path)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".download")
    # 'xb' avoids overwriting an unrelated or concurrent partial download.
    with temporary.open("xb") as sink:
        try:
            with urllib.request.urlopen(URL, timeout=60) as response:
                size = 0
                while block := response.read(1024 * 1024):
                    size += len(block)
                    if size > SIZE:
                        raise ValueError("Download exceeds pinned size")
                    sink.write(block)
            sink.flush()
            verify_archive(temporary)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    temporary.rename(path)


def read_member(archive: zipfile.ZipFile, name: str, limit: int) -> bytes:
    """完全一致allowlistの通常ファイルだけを、展開せずサイズ上限付きで読む。"""
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("Unsafe ZIP member path")
    matches = [item for item in archive.infolist() if item.filename == name]
    if len(matches) != 1:
        raise ValueError(f"Missing or duplicate ZIP member: {name}")
    item = matches[0]
    mode = item.external_attr >> 16
    if item.is_dir() or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
        raise ValueError(f"Not a regular ZIP member: {name}")
    if item.file_size > limit or item.flag_bits & 1:
        raise ValueError(f"Oversized/encrypted ZIP member: {name}")
    with archive.open(item) as source:
        data = source.read(limit + 1)
    if len(data) != item.file_size or len(data) > limit:
        raise ValueError(f"Invalid expanded ZIP member: {name}")
    return data


def notes_from_csv(data: bytes) -> list[ReferenceNote]:
    """公式の start秒,pitchHz,duration秒 を整数MIDIへ変換し、不正行は拒否する。"""
    notes: list[ReferenceNote] = []
    for row in csv.reader(io.StringIO(data.decode("utf-8"))):
        if len(row) != 3:
            raise ValueError("Note CSV must have exactly three columns")
        start, hz, duration = map(float, row)
        if not all(map(math.isfinite, (start, hz, duration))) or start < 0 or hz <= 0 or duration <= 0:
            raise ValueError("Invalid note timing/frequency")
        midi = math.floor(69 + 12 * math.log2(hz / 440) + 0.5)
        end = start + duration
        if not 0 <= midi <= 127 or not math.isfinite(end):
            raise ValueError("Invalid MIDI/end time")
        notes.append({"start": start, "end": end, "midi": midi})
    if not notes or any(a["start"] > b["start"] for a, b in pairwise(notes)):
        raise ValueError("Empty or unsorted note CSV")
    return notes


def save_original(path: Path, data: bytes) -> None:
    """原音・注釈を新規保存する。既存の異なるファイルは上書きしない。"""
    output_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"Existing file differs: {path.name}")
    else:
        with path.open("xb") as sink:
            sink.write(data)


def main() -> None:
    """ラベルと音声を分離して保存し、選定理由と改変内容をmanifestへ残す。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-final", action="store_true", help="固定後の最終4曲も抽出する")
    parser.add_argument("--archive", type=Path, help="取得済みの公式ZIP（読み取りのみ）")
    parser.add_argument("--output", type=Path, default=PROJECT / "output/service-quality/vocadito")
    args = parser.parse_args()
    destination = output_path(args.output)
    archive_path = args.archive or destination.parent / "vocadito.zip"
    if args.archive:
        verify_archive(archive_path)
    else:
        output_path(archive_path)
        download_archive(archive_path)
    selected = [track for track in TRACKS if track.split == "development" or args.include_final]
    records = []
    with zipfile.ZipFile(archive_path) as archive:
        metadata = list(csv.DictReader(io.StringIO(read_member(archive, "vocadito_metadata.csv", 50_000).decode())))
        for track in selected:
            folder = destination / track.name
            members = {
                "input.wav": (f"Audio/{track.name}.wav", 12_000_000),
                "f0.csv": (f"Annotations/F0/{track.name}_f0.csv", 2_000_000),
                **{f"notes{a}.csv": (f"Annotations/Notes/{track.name}_notes{a}.csv", 200_000) for a in ("A1", "A2")},
            }
            hashes = {}
            for filename, (member, limit) in members.items():
                data = read_member(archive, member, limit)
                save_original(folder / filename, data)
                hashes[filename] = hashlib.sha256(data).hexdigest()
                if filename.startswith("notes"):
                    annotation = filename.removeprefix("notes").removesuffix(".csv")
                    rendered = (json.dumps(notes_from_csv(data), indent=2) + "\n").encode()
                    target = folder / f"reference{annotation}.json"
                    # Existing equivalent JSON from the pilot may use different whitespace.
                    if target.exists() and json.loads(target.read_text()) == json.loads(rendered):
                        continue
                    save_original(target, rendered)
            meta = next(row for row in metadata if int(row["track_id"]) == track.number)
            records.append({"id": track.name, "split": track.split, "metadata": meta, "sha256": hashes})
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {"source": SOURCE, "download": URL, "version": "v3", "archiveBytes": SIZE,
                "archiveMd5": MD5, "archiveSha256": SHA256, "license": LICENSE, "attribution": ATTRIBUTION,
                "partition": {"development": [1, 2, 17], "final": [4, 24, 35, 37]},
                "selection": "Fixed before candidate audio evaluation; seven distinct singers; not an official split or guarantee of model-training independence.",
                "includeFinal": args.include_final, "tracks": records}
    manifest_path = output_path(destination / "fetch-manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    save_original(destination / "ATTRIBUTION.txt", (ATTRIBUTION + "\n" + SOURCE + "\n" + LICENSE + "\n").encode())
    print(f"Prepared {len(selected)} public tracks; final enabled={args.include_final}")


if __name__ == "__main__":
    main()
