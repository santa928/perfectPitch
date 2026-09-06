"""PJS公式配布物から許諾済みの実音声評価サンプルだけを取得する。"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import wave
import zipfile
from dataclasses import dataclass
from pathlib import Path

ARCHIVE_URL = (
    "https://drive.usercontent.google.com/download"
    "?id=1hPHwOkSe2Vnq6hXrhVtzNskJjVMQmvN_&export=download&confirm=t"
)
ARCHIVE_SHA256 = "683c00253ee35a62d50de0375bb9d8e003a74338d4ce3495ac3f7ad096abc1ca"


@dataclass(frozen=True)
class Fixture:
    """アーカイブ内の取得対象と検証値を表す。"""

    filename: str
    role: str
    sha256: str

    @property
    def member(self) -> str:
        """固定したPJS ver.1.1アーカイブ内のパスを返す。"""

        stem = self.filename.removesuffix("_song.wav").removesuffix("_speech.wav")
        return f"PJS_corpus_ver1.1/{stem}/{self.filename}"


FIXTURES = (
    Fixture(
        "pjs056_song.wav",
        "公式個別サンプル歌声",
        "92037425e4b461b4efbcf1c38585e8e5122a3dfb5b41e589ae8c9a9390c250b4",
    ),
    Fixture(
        "pjs012_song.wav",
        "楽譜上の低音域",
        "7e6f8aaa7de849bc221b932d4ba073d5229902b3957d33b5751eb79878486116",
    ),
    Fixture(
        "pjs068_song.wav",
        "楽譜上のロングトーン",
        "9da2a1dbdc43000ff1a8dcbbc9c38d774566417c0f29d6ef4ac62db38b109115",
    ),
    Fixture(
        "pjs087_song.wav",
        "楽譜上の高音域",
        "e0818ba9c6439b3e18d049bb0bd3fd5e438ad1c0816e0575790afe56467b6ddc",
    ),
    Fixture(
        "pjs091_song.wav",
        "短い歌唱",
        "bbba9a5c8b41b4fedf03a5493b805de549c31293f7529d15efa4f6e19621b32f",
    ),
    Fixture(
        "pjs056_speech.wav",
        "通常の日本語話声",
        "7103bc6a578eafa41e75846969c039f61a4f28b563950b453237e09e0ca09e0e",
    ),
)


def sha256(path: Path) -> str:
    """ファイルをストリーム読み込みしてSHA-256を返す。"""

    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_archive(destination: Path) -> None:
    """PJS公式アーカイブをコンテナ内の一時パスへ取得する。"""

    request = urllib.request.Request(
        ARCHIVE_URL,
        headers={"User-Agent": "perfectPitch-evaluation-fixture-fetcher/1.0"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        content_type = response.headers.get_content_type()
        if content_type not in {"application/zip", "application/octet-stream"}:
            raise RuntimeError(f"unexpected content type: {content_type}")
        with destination.open("wb") as target:
            shutil.copyfileobj(response, target, length=1024 * 1024)


def validate_wav(path: Path) -> tuple[int, float]:
    """評価条件の48 kHz・mono・24-bit PCMであることと長さを返す。"""

    with wave.open(str(path), "rb") as audio:
        properties = (
            audio.getcomptype(),
            audio.getnchannels(),
            audio.getsampwidth(),
            audio.getframerate(),
        )
        if properties != ("NONE", 1, 3, 48_000):
            raise RuntimeError(f"unexpected WAV properties for {path.name}: {properties}")
        frames = audio.getnframes()
        return frames, frames / audio.getframerate()


def extract_fixture(
    archive: zipfile.ZipFile, fixture: Fixture, output_dir: Path
) -> tuple[Path, int, float]:
    """指定メンバーだけを展開し、ハッシュとWAV形式を検証する。"""

    destination = output_dir / fixture.filename
    partial = destination.with_suffix(destination.suffix + ".partial")
    try:
        with archive.open(fixture.member) as source, partial.open("wb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
        actual = sha256(partial)
        if fixture.sha256 != "PENDING" and actual != fixture.sha256:
            raise RuntimeError(
                f"SHA-256 mismatch for {fixture.filename}: expected "
                f"{fixture.sha256}, got {actual}"
            )
        frames, seconds = validate_wav(partial)
        partial.replace(destination)
        return destination, frames, seconds
    finally:
        partial.unlink(missing_ok=True)


def main() -> int:
    """固定したPJS評価セットを取得し、出典に対応する検証値を表示する。"""

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("tests/fixtures/downloads"),
    )
    parser.add_argument(
        "--accept-license",
        action="store_true",
        help="PJSのCC BY-SA 4.0条件を確認した場合だけ取得する",
    )
    args = parser.parse_args()
    if not args.accept_license:
        parser.error(
            "取得には --accept-license が必要です。"
            "docs/evaluation/real-audio-sources.md を確認してください。"
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="perfect-pitch-pjs-") as temp_dir:
            archive_path = Path(temp_dir) / "PJS_corpus_ver1.1.zip"
            download_archive(archive_path)
            archive_digest = sha256(archive_path)
            if archive_digest != ARCHIVE_SHA256:
                raise RuntimeError(
                    f"archive SHA-256 mismatch: expected {ARCHIVE_SHA256}, "
                    f"got {archive_digest}"
                )
            with zipfile.ZipFile(archive_path) as archive:
                for fixture in FIXTURES:
                    path, frames, seconds = extract_fixture(
                        archive, fixture, args.output_dir
                    )
                    print(
                        f"{fixture.role}: {sha256(path)}  {path} "
                        f"({frames} frames, {seconds:.3f} s)"
                    )
    except (OSError, RuntimeError, urllib.error.URLError, zipfile.BadZipFile) as error:
        print(f"取得または検証に失敗しました: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
