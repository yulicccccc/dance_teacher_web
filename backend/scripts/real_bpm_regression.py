"""Local-only BPM regression check against the user's confirmed course audio.

The repository stores only SHA-256 fingerprints and expected dance-count BPMs.
The WAV files stay under gitignored ``backend/data`` and are never copied or
uploaded.  Missing local fixtures are reported and skipped, so normal CI remains
portable; on the user's Mac all known fingerprints are expected to be present.
"""
from __future__ import annotations

import hashlib
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.services.beat_detector import detect  # noqa: E402


@dataclass(frozen=True)
class Golden:
    label: str
    bpm: float


# These are fingerprints of extracted mono WAVs, not of the user's videos.
GOLDENS: dict[str, Golden] = {
    "714fb91f1d1334afed82d129d46e7a9f6119a823336d513f6e05225e31650007": Golden(
        "Tyla - THAT GIRL", 88.0
    ),
    "3cec5d0af22c8d3aaf5a8a2c5ae645d27f1a51ef101b38f24e98354af48f1912": Golden(
        "43 秒课程", 118.01
    ),
    "7203bc9ce8809e7be4456871fe0053360a4ea883ff5083b2fcfd9c7e2e9792a8": Golden(
        "55 秒课程", 118.0
    ),
    "bdb18db69b216563836f646e0120e9911eb575b35d669c8b9085e5883a1ce38e": Golden(
        "66 秒课程", 116.0
    ),
    "67cd2754c55c5c6dd45fd0198bd54cc090dc77fca94a5f87ab0167dcba31eb2c": Golden(
        "90 秒课程", 88.0
    ),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    wav_dir = BACKEND / "data" / "wav"
    matched: dict[str, Path] = {}
    for path in sorted(wav_dir.glob("*.wav")):
        fingerprint = sha256(path)
        if fingerprint in GOLDENS and fingerprint not in matched:
            matched[fingerprint] = path

    failures = 0
    print("真实课程 BPM 回归（媒体只在本机读取）")
    for fingerprint, golden in GOLDENS.items():
        path = matched.get(fingerprint)
        if path is None:
            print(f"  SKIP  {golden.label}: 本机素材不存在")
            continue

        bpm, confidence, beats, duration = detect(str(path))
        relative_error = abs(bpm - golden.bpm) / golden.bpm
        expected_count = duration * golden.bpm / 60.0
        count_error = abs(len(beats) - expected_count) / max(1.0, expected_count)
        effective_bpm = 0.0
        if len(beats) >= 2:
            effective_bpm = 60.0 / float(np.median(np.diff(np.asarray(beats))))
        grid_error = abs(effective_bpm - bpm) / max(1.0, bpm)

        # Reference BPM can differ slightly when a screen recording has been
        # resampled, so 3% is the guardrail here.  It is intentionally tight
        # enough to catch every half/double-tempo regression.
        ok = relative_error <= 0.03 and count_error <= 0.06 and grid_error <= 0.005
        failures += int(not ok)
        verdict = "PASS" if ok else "FAIL"
        print(
            f"  {verdict}  {golden.label}: 参考 {golden.bpm:.2f}, 检测 {bpm:.2f}, "
            f"拍点 {len(beats)}/{math.floor(expected_count + 0.5)}, "
            f"置信度 {confidence:.2f}"
        )

    if not matched:
        print("  未找到本机 golden 素材；常规测试不受影响。")
        return 0
    print(f"完成：{len(matched) - failures}/{len(matched)} 通过")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
