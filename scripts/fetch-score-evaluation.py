"""PJS公式譜面と固定3曲を、解析器から独立した評価用データへ変換する。"""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import IO, TypedDict

SOURCE_URL = "https://sites.google.com/site/shinnosuketakamichi/research-topics/pjs_corpus"
ARCHIVE_URL = (
    "https://drive.usercontent.google.com/download"
    "?id=1hPHwOkSe2Vnq6hXrhVtzNskJjVMQmvN_&export=download&confirm=t"
)
ARCHIVE_SHA256 = "683c00253ee35a62d50de0375bb9d8e003a74338d4ce3495ac3f7ad096abc1ca"
ARCHIVE_BYTES = 275_179_158
MAX_DURATION = 60
SAMPLE_RATE = 48_000
MAX_XML_BYTES = 2 * 1024 * 1024
MAX_WAV_BYTES = MAX_DURATION * SAMPLE_RATE * 3 + 65_536


@dataclass(frozen=True)
class Fixture:
    """解析結果を見ずに固定した対象と譜面メタデータ。"""

    id: str
    bpm: int
    note_count: int
    role: str


FIXTURES = (
    Fixture("pjs010", 80, 27, "development"),
    Fixture("pjs017", 120, 38, "held-out"),
    Fixture("pjs040", 180, 21, "development"),
)


class ReferenceNote(TypedDict):
    """譜面開始を0秒とする作曲上の音符で、歌唱F0ラベルではない。"""

    start: float
    end: float
    midi: int


class Score(TypedDict):
    """固定テンポの単声譜面から得た秒単位の比較基準。"""

    bpm: float
    duration: float
    notes: list[ReferenceNote]


@dataclass
class TickNote:
    """division変更に依存しない四分音符単位の有理数区間。"""

    start: Fraction
    end: Fraction
    midi: int


def sha256(path: Path) -> str:
    """大きなファイルも一定メモリでSHA-256検証する。"""

    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def copy_limited(source: IO[bytes], target: IO[bytes], limit: int) -> None:
    """固定上限を超えるデータを保存せず、ストリームを複製する。"""

    total = 0
    for block in iter(lambda: source.read(1024 * 1024), b""):
        total += len(block)
        if total > limit:
            raise ValueError(f"file exceeds {limit} bytes")
        target.write(block)


def download_archive(destination: Path) -> None:
    """公式ページのGoogle Driveリンクを使い、検証前のZIPを一時領域へ取得する。"""

    request = urllib.request.Request(
        ARCHIVE_URL, headers={"User-Agent": "perfectPitch-score-evaluation/1.0"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.headers.get_content_type() not in {
            "application/zip", "application/octet-stream"
        }:
            raise ValueError("download was not a ZIP response")
        with destination.open("wb") as target:
            copy_limited(response, target, ARCHIVE_BYTES)


def positive_fraction(text: str | None, label: str) -> Fraction:
    """MusicXMLの数値が省略・不正・非正値なら明示的に拒否する。"""

    if text is None:
        raise ValueError(f"missing {label}")
    value = Fraction(text)
    if value <= 0:
        raise ValueError(f"nonpositive {label}")
    return value


def note_midi(note: ET.Element) -> int:
    """alterを含む実音高をMIDIへ変換し、微分音や音高欠落を拒否する。"""

    steps = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    step = note.findtext("pitch/step", "")
    octave = note.findtext("pitch/octave")
    alter = Fraction(note.findtext("pitch/alter", "0"))
    if step not in steps or octave is None or alter.denominator != 1:
        raise ValueError("unsupported or missing pitch")
    midi = 12 * (int(octave) + 1) + steps[step] + int(alter)
    if not 0 <= midi <= 127:
        raise ValueError("pitch outside MIDI 0–127")
    return midi


def parse_score(xml: bytes) -> Score:
    """単声4/4・固定BPMのMusicXMLを読み、休符と小節を保持してタイだけ統合する。"""

    if len(xml) > MAX_XML_BYTES or b"<!ENTITY" in xml.upper():
        raise ValueError("oversized XML or entity declaration")
    root = ET.fromstring(xml)
    for element in root.iter():
        element.tag = element.tag.rsplit("}", 1)[-1]
    parts = root.findall("part")
    if root.tag != "score-partwise" or len(parts) != 1:
        raise ValueError("exactly one score-partwise part is required")
    for tag in ("backup", "chord", "grace", "unpitched", "repeat", "transpose"):
        if root.find(f".//{tag}") is not None:
            raise ValueError(f"unsupported polyphony or notation: {tag}")
    times = root.findall(".//time")
    if not times or any(
        (item.findtext("beats"), item.findtext("beat-type")) != ("4", "4")
        for item in times
    ):
        raise ValueError("only fixed 4/4 scores are supported")
    tempo_values = {
        positive_fraction(sound.get("tempo"), "tempo")
        for sound in root.findall(".//sound") if sound.get("tempo") is not None
    }
    if len(tempo_values) != 1:
        raise ValueError("exactly one constant sound tempo is required")
    bpm = next(iter(tempo_values))
    cursor = Fraction(0)
    divisions: Fraction | None = None
    voices: set[str] = set()
    notes: list[TickNote] = []
    active_tie: TickNote | None = None
    initial_tempo = False
    for measure in parts[0].findall("measure"):
        measure_start = cursor
        for item in measure:
            if item.tag == "attributes":
                if item.find("divisions") is not None:
                    divisions = positive_fraction(item.findtext("divisions"), "divisions")
                continue
            if item.tag in {"direction", "sound"}:
                sounds = [item] if item.tag == "sound" else item.findall(".//sound")
                if any(sound.get("tempo") is not None for sound in sounds):
                    offset = Fraction(item.findtext("offset", "0"))
                    if not initial_tempo and (cursor != 0 or offset != 0):
                        raise ValueError("initial tempo must be specified at score start")
                    initial_tempo = True
                continue
            if item.tag not in {"note", "forward"}:
                continue
            if divisions is None or not initial_tempo:
                raise ValueError("divisions and initial tempo must precede notes")
            voices.add(item.findtext("voice", "1"))
            if len(voices) > 1 or item.findtext("staff", "1") != "1":
                raise ValueError("multiple voices or staves are unsupported")
            length = positive_fraction(item.findtext("duration"), "duration") / divisions
            end = cursor + length
            if item.tag == "forward" or item.find("rest") is not None:
                if active_tie is not None:
                    raise ValueError("rest interrupts an unfinished tie")
            else:
                midi = note_midi(item)
                ties = {tie.get("type") for tie in item.findall("tie")}
                ties.update(tie.get("type") for tie in item.findall("notations/tied"))
                if ties - {"start", "stop"}:
                    raise ValueError("unsupported tie type")
                if "stop" in ties:
                    if active_tie is None or active_tie.midi != midi or active_tie.end != cursor:
                        raise ValueError("tie stop has no contiguous same-pitch start")
                    active_tie.end = end
                    if "start" not in ties:
                        active_tie = None
                else:
                    if active_tie is not None:
                        raise ValueError("tie start has no stop")
                    current = TickNote(cursor, end, midi)
                    notes.append(current)
                    if "start" in ties:
                        active_tie = current
            cursor = end
        if cursor - measure_start != 4:
            raise ValueError(f"measure {measure.get('number')} is not four beats")
    if active_tie is not None or not notes:
        raise ValueError("unfinished tie or empty pitched score")
    seconds_per_beat = 60 / bpm
    duration = float(cursor * seconds_per_beat)
    if duration > MAX_DURATION:
        raise ValueError("score exceeds 60 seconds")
    return {
        "bpm": float(bpm),
        "duration": duration,
        "notes": [
            {"start": float(note.start * seconds_per_beat),
             "end": float(note.end * seconds_per_beat), "midi": note.midi}
            for note in notes
        ],
    }


def extract_member(archive: zipfile.ZipFile, member: str, destination: Path, limit: int) -> None:
    """allowlistの単一通常ファイルだけを固定の保存先へ展開する。"""

    entries = [item for item in archive.infolist() if item.filename == member]
    if len(entries) != 1:
        raise ValueError(f"missing or duplicate archive member: {member}")
    entry = entries[0]
    mode = entry.external_attr >> 16
    if (entry.is_dir() or stat.S_IFMT(mode) not in {0, stat.S_IFREG}
            or not 0 < entry.file_size <= limit):
        raise ValueError(f"unsafe archive member: {member}")
    with archive.open(entry) as source, destination.open("wb") as target:
        copy_limited(source, target, limit)


def wav_to_float32(source: Path, destination: Path) -> tuple[int, float]:
    """48kHz mono 24-bit PCMを正規化し、明示的little-endian float32として保存する。"""

    with wave.open(str(source), "rb") as audio, destination.open("wb") as target:
        properties = (
            audio.getcomptype(), audio.getnchannels(), audio.getsampwidth(), audio.getframerate()
        )
        if properties != ("NONE", 1, 3, SAMPLE_RATE):
            raise ValueError(f"unexpected WAV properties: {properties}")
        frames = audio.getnframes()
        if not 0 < frames <= SAMPLE_RATE * MAX_DURATION:
            raise ValueError("audio must be greater than 0 and at most 60 seconds")
        written = 0
        while raw := audio.readframes(16_384):
            if len(raw) % 3:
                raise ValueError("incomplete 24-bit PCM sample")
            values = [int.from_bytes(raw[i:i + 3], "little", signed=True) / 8_388_608
                      for i in range(0, len(raw), 3)]
            target.write(struct.pack(f"<{len(values)}f", *values))
            written += len(values)
        if written != frames:
            raise ValueError("truncated WAV data")
    return frames, frames / SAMPLE_RATE


def prepare_fixture(archive: zipfile.ZipFile, fixture: Fixture, output_dir: Path) -> None:
    """原音・譜面を検証後、出典とハッシュ付きの評価専用ファイルを生成する。"""

    destination = output_dir / fixture.id
    if destination.is_symlink():
        raise ValueError("fixture destination must not be a symlink")
    destination.mkdir(parents=True, exist_ok=True)
    prefix = f"PJS_corpus_ver1.1/{fixture.id}/{fixture.id}"
    with tempfile.TemporaryDirectory(prefix=".staging-", dir=destination) as temporary:
        staging = Path(temporary)
        audio_path, xml_path = staging / "input.wav", staging / "source.musicxml"
        extract_member(archive, f"{prefix}_song.wav", audio_path, MAX_WAV_BYTES)
        extract_member(archive, f"{prefix}.musicxml", xml_path, MAX_XML_BYTES)
        score = parse_score(xml_path.read_bytes())
        if score["bpm"] != fixture.bpm or len(score["notes"]) != fixture.note_count:
            raise ValueError(f"unexpected fixed score metadata for {fixture.id}")
        frames, audio_duration = wav_to_float32(audio_path, staging / "input.f32")
        reference = {
            "id": fixture.id, "role": fixture.role, **score,
            "audioDuration": audio_duration, "sampleRate": SAMPLE_RATE, "frames": frames,
            "referenceKind": "compositional-score-not-performed-f0",
            "timeOrigin": "score-and-original-wav-start-no-alignment",
            "source": {"url": SOURCE_URL, "creators": ["Junya Koguchi", "Shinnosuke Takamichi"],
                       "license": "CC BY-SA 4.0", "archive": "PJS_corpus_ver1.1.zip",
                       "audioMember": f"{prefix}_song.wav", "scoreMember": f"{prefix}.musicxml"},
            "hashes": {"archiveSha256": ARCHIVE_SHA256, "wavSha256": sha256(audio_path),
                       "musicxmlSha256": sha256(xml_path),
                       "float32Sha256": sha256(staging / "input.f32")},
        }
        (staging / "reference.json").write_text(
            json.dumps(reference, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        outputs = ("input.wav", "input.f32", "source.musicxml", "reference.json")
        for filename in outputs:
            target = destination / filename
            if target.is_symlink() or (target.exists() and sha256(target) != sha256(staging / filename)):
                raise ValueError(f"existing output differs; choose a new --output-dir: {target}")
        for filename in outputs:
            target = destination / filename
            if not target.exists():
                (staging / filename).replace(target)
    print(f"{fixture.id}: {fixture.bpm} BPM, {fixture.note_count} notes, "
          f"score={score['duration']:.6f}s, audio={audio_duration:.6f}s, frames={frames}")


def main() -> int:
    """既存ZIPの再利用または公式取得を選び、固定3曲だけを検証・生成する。"""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="公式ZIPを再ダウンロードせずハッシュ検証して再利用")
    parser.add_argument("--output-dir", type=Path, default=Path("output/pjs-evaluation"))
    parser.add_argument("--accept-license", action="store_true", help="CC BY-SA 4.0条件を確認済み")
    args = parser.parse_args()
    if not args.accept_license:
        parser.error("docs/evaluation/vocal-score-sources.mdを確認し --accept-license を指定してください")
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory(prefix="perfect-pitch-score-") as temporary:
            archive_path = args.archive or Path(temporary) / "PJS_corpus_ver1.1.zip"
            if args.archive is None:
                download_archive(archive_path)
            if archive_path.stat().st_size != ARCHIVE_BYTES or sha256(archive_path) != ARCHIVE_SHA256:
                raise ValueError("official archive size or SHA-256 mismatch")
            args.output_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(archive_path) as archive:
                for fixture in FIXTURES:
                    prepare_fixture(archive, fixture, args.output_dir)
        print(f"completed in {time.monotonic() - started:.3f}s; archive={ARCHIVE_BYTES} bytes")
    except (OSError, ValueError, ET.ParseError, urllib.error.URLError, zipfile.BadZipFile,
            wave.Error, EOFError) as error:
        print(f"取得または変換に失敗しました: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
