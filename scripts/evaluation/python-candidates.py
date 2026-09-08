"""評価専用pYIN/CREPE。ブラウザdecoded PCMのみを入力し、正解注釈を読み込まない。"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import resource
import time
from pathlib import Path
from typing import TypedDict, cast

import librosa
import numpy as np
from numpy.typing import NDArray
import torch
import torchcrepe


class InputRecord(TypedDict):
    """ブラウザexportの入力と元時計。"""
    id: str
    split: str
    path: str
    sampleRate: int
    samples: int
    sha256: str


class Frame(TypedDict):
    """共通melodyへ渡すF0と、その方式固有の有声判定根拠。"""
    t: float
    frequency: float | None
    midi: float | None
    rms: float
    periodicity: float
    state: str
    candidateHz: float | None


def make_frames(pcm: NDArray[np.float32], hz: NDArray[np.float64],
                voiced: NDArray[np.bool_], confidence: NDArray[np.float64]) -> list[Frame]:
    """本番と同じ80ms RMSを別途測り、モデルconfidenceをYIN閾値へ流用しない。"""
    result: list[Frame] = []
    for i, (pitch, yes, score) in enumerate(zip(hz, voiced, confidence, strict=True)):
        t = i * .01
        if t >= len(pcm) / 48000:
            break
        segment = pcm[max(0, round((t - .04) * 48000)):min(len(pcm), round((t + .04) * 48000))]
        rms = float(np.sqrt(np.mean(segment.astype(np.float64) ** 2))) if len(segment) else 0.
        raw = float(pitch) if np.isfinite(pitch) and pitch > 0 else None
        accepted = raw if yes else None
        result.append({"t": t, "frequency": accepted, "candidateHz": raw,
                       "midi": 69 + 12 * np.log2(accepted / 440) if accepted else None,
                       "rms": rms, "periodicity": float(score) if np.isfinite(score) else 0.,
                       "state": "voiced" if accepted else "unvoiced"})
    return result


def main() -> None:
    """全方式の設定を先に固定し、音源ごとに完了結果とプロセスpeak RSSを保存する。"""
    parser = argparse.ArgumentParser(description=__doc__)
    # 不採用の探索候補はholdoutへ進めない。将来の採用には環境/モデルを含むsealを追加する。
    parser.add_argument("--split", choices=["development", "validation", "synthetic"], default="development")
    parser.add_argument("--method", choices=["pyin", "crepe-tiny", "crepe-full"], required=True)
    parser.add_argument("--only")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists() or not args.output.resolve().is_relative_to(Path("output/issue21").resolve()):
        raise ValueError("Choose a new output/issue21 directory")
    records = cast(list[InputRecord], json.loads(Path(f"output/issue21/pcm-{args.split}.json").read_text())["records"])
    if args.only:
        records = [r for r in records if r["id"] == args.only]
    if not records:
        raise ValueError("No selected input")
    args.output.mkdir(parents=True)
    torch.set_num_threads(2)
    torch.manual_seed(21091)
    versions = {name: importlib.metadata.version(name) for name in ["librosa", "numpy", "scipy", "torch", "torchcrepe", "resampy"]}
    config = {"method": args.method, "rate": 16000, "hop": 160, "fmin": 55, "fmax": 1000,
              "pyinFrameLength": 1280, "pyinCenter": True, "pyinResolution": .1,
              "crepeDecoder": "viterbi", "crepeThreshold": .21, "silenceDb": -60,
              "pitchSmoothing": False, "confidenceMedian": False, "threads": 2}
    weights = list((Path(torchcrepe.__file__).parent / "assets").glob("*.pth")) if args.method != "pyin" else []
    provenance = {"versions": versions, "config": config, "platform": platform.platform(),
                  "weights": [{"file": p.name, "bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in weights],
                  "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    (args.output / "provenance.json").write_text(json.dumps(provenance, indent=2))
    for item in records:
        raw = Path(item["path"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != item["sha256"]:
            raise ValueError("PCM hash mismatch")
        pcm = np.frombuffer(raw, dtype="<f4").copy()
        began = time.perf_counter()
        data = librosa.resample(pcm, orig_sr=48000, target_sr=16000, res_type="soxr_hq")
        resample_seconds = time.perf_counter() - began
        infer_start = time.perf_counter()
        if args.method == "pyin":
            pitch, voiced, probability = librosa.pyin(data, sr=16000, fmin=55, fmax=1000,
                frame_length=1280, hop_length=160, resolution=.1, center=True)
        else:
            audio = torch.from_numpy(data).reshape(1, -1)
            with torch.inference_mode():
                pitch_tensor, periodicity = torchcrepe.predict(audio, 16000, 160, 55, 1000,
                    args.method.removeprefix("crepe-"), decoder=torchcrepe.decode.viterbi,
                    return_periodicity=True, batch_size=64, device="cpu")
                periodicity = torchcrepe.threshold.Silence(-60.)(periodicity, audio, 16000, 160)
            pitch = pitch_tensor.squeeze(0).numpy().astype(np.float64)
            probability = periodicity.squeeze(0).numpy().astype(np.float64)
            voiced = probability >= .21
        inference_seconds = time.perf_counter() - infer_start
        frames = make_frames(pcm, pitch, voiced, probability)
        result = {"id": item["id"], "split": item["split"], "method": args.method,
                  "inputSha256": item["sha256"], "duration": len(pcm) / 48000,
                  "resampleSeconds": resample_seconds, "inferenceSeconds": inference_seconds,
                  "peakProcessRssKiB": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                  "frames": frames}
        (args.output / f"{item['id']}.json").write_text(json.dumps(result, allow_nan=False))
        print(json.dumps({k: v for k, v in result.items() if k != "frames"}), flush=True)


if __name__ == "__main__":
    main()
