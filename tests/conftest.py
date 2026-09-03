"""Stand-in models so the whole generation pipeline can run without a GPU.

`synthesize_excerpt` is the piece that decides what a lecture costs and what
lands in the manifest, and it is also the piece nobody can execute in CI: it
wants Metal, a 1.7B TTS model, Whisper, and a forced aligner. Every bug this
project has shipped lived there — a missing dict key, an unguarded index, a
phase ordering — and none of them needed a real model to reproduce.

So the models are replaced and everything else is real: real ffmpeg loudness
normalization, real WAV files, real deck parsing, real manifest assembly. The
fakes are deliberately dumb and deterministic; each test says what its fake is
supposed to have said, and the pipeline has to agree.
"""

from __future__ import annotations

import json
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf


SAMPLE_RATE = 24_000


# ─── MLX stand-ins ────────────────────────────────────────────────────────────

class FakeRandom:
    def __init__(self) -> None:
        self.seeds: list[int] = []

    def seed(self, value: int) -> None:
        self.seeds.append(int(value))


class FakeMx(types.ModuleType):
    """Just enough of `mlx.core` for the pipeline's bookkeeping."""

    def __init__(self) -> None:
        super().__init__("mlx.core")
        self.random = FakeRandom()
        self.cleared = 0

    def clear_cache(self) -> None:
        self.cleared += 1

    def get_peak_memory(self) -> float:
        return 13.4 * 1024**3


@dataclass
class FakeAudioResult:
    audio: np.ndarray
    sample_rate: int
    peak_memory_usage: float


class FakeTtsModel:
    """Speaks by emitting a tone whose length follows the text.

    `reading` maps a chunk's text to what the reviewer will claim it heard, and
    `broken` names chunk texts whose audio should come out unusable.
    """

    def __init__(self, *, silent_for: set[str] | None = None) -> None:
        self.silent_for = silent_for or set()
        self.calls: list[dict[str, Any]] = []

    def generate(self, **kwargs: Any):
        text = str(kwargs["text"])
        self.calls.append(dict(kwargs))
        seconds = max(0.6, len(text) / 4.2)
        samples = round(seconds * SAMPLE_RATE)
        if text in self.silent_for:
            audio = np.zeros(samples, dtype=np.float32)
        else:
            at = np.arange(samples, dtype=np.float32) / SAMPLE_RATE
            audio = (np.sin(2 * np.pi * 190 * at) * 0.12).astype(np.float32)
            # A little edge silence, so trimming has something real to remove.
            pad = np.zeros(round(0.2 * SAMPLE_RATE), dtype=np.float32)
            audio = np.concatenate([pad, audio, pad])
        yield FakeAudioResult(audio, SAMPLE_RATE, 11.6 * 1024**3)


@dataclass
class FakeTranscript:
    text: str


class FakeAsrModel:
    """Reads a clip back as whatever the test said it would hear.

    `readings` is keyed by the text a chunk was asked to say. A value can be:

    * a string — always heard that way;
    * a list of strings — one per *take*, so a test can make the first seed bad
      and the next one good. Both decoding passes over the same take agree,
      which is what a genuinely bad take looks like;
    * a list of two-element lists — ``[at temperature 0.0, at temperature 0.2]``
      for each take, which is what decoder noise looks like: one take, two
      readings that disagree.

    Anything not listed is heard exactly as spoken. Takes are told apart by
    clip path, since each seed writes its own file.
    """

    def __init__(self, readings: dict[str, Any] | None = None) -> None:
        self.readings = readings or {}
        self.calls: list[tuple[str, float]] = []
        self.spoken: dict[str, str] = {}
        self._takes: dict[str, list[str]] = {}

    def generate(self, audio_path: str, **kwargs: Any) -> FakeTranscript:
        path = str(audio_path)
        temperature = float(kwargs.get("temperature", 0.0))
        self.calls.append((path, temperature))
        text = self.spoken.get(path, "")
        script = self.readings.get(text)
        if script is None:
            return FakeTranscript(text)
        if isinstance(script, str):
            return FakeTranscript(script)

        seen = self._takes.setdefault(text, [])
        if path not in seen:
            seen.append(path)
        reading = script[min(seen.index(path), len(script) - 1)]
        if isinstance(reading, str):
            return FakeTranscript(reading)
        return FakeTranscript(reading[0] if temperature == 0.0 else reading[-1])


class FakeAligner:
    """Spreads a chunk's words evenly across its clip."""

    def generate(self, *, audio: str, text: str, language: str) -> Any:
        from local_tts_engine.course_pilot import alignment_tokens

        tokens = alignment_tokens(text)
        info = sf.info(audio)
        total_ms = round(info.frames * 1000 / info.samplerate)
        step = total_ms / max(1, len(tokens))
        items = [
            types.SimpleNamespace(
                text=token,
                start_time=index * step / 1000,
                end_time=(index + 1) * step / 1000,
            )
            for index, token in enumerate(tokens)
        ]
        return types.SimpleNamespace(items=items)


# ─── the harness ──────────────────────────────────────────────────────────────

@dataclass
class Studio:
    """A complete, disposable lecture project plus the fakes driving it."""

    root: Path
    reference: Path
    reference_text: Path
    tts: FakeTtsModel
    asr: FakeAsrModel
    mx: FakeMx

    def run(self, **overrides: Any) -> dict[str, Any]:
        from local_tts_engine import course_pilot

        output_dir = overrides.pop("output_dir", self.root / "out")
        options: dict[str, Any] = {
            "source_project": self.root,
            "output_dir": output_dir,
            "reference_path": self.reference,
            "reference_text_path": self.reference_text,
            "target_seconds": 30.0,
            "start_chapter": "ch00",
            "start_slide": None,
            "seed": 20_260_903,
            "use_cache": False,
        }
        options.update(overrides)
        course_pilot.synthesize_excerpt(**options)
        return json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))


@pytest.fixture
def studio(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Build a lecture project wired to fake models.

    The returned factory takes the deck's slide order, its script markdown and
    an optional pronunciation dictionary, so each test writes only the lecture
    it cares about.
    """

    def build(
        *,
        slides: dict[str, list[str]],
        scripts: dict[str, str],
        dictionary: list[dict[str, str]] | None = None,
        readings: dict[str, Any] | None = None,
        silent_for: set[str] | None = None,
    ) -> Studio:
        deck = tmp_path / "deck"
        chapters = deck / "src/production/chapters"
        script_dir = deck / "script/course"
        narration = deck / "narration"
        for directory in (chapters, script_dir, narration):
            directory.mkdir(parents=True, exist_ok=True)
        for chapter, slide_ids in slides.items():
            (chapters / f"{chapter}-test.ts").write_text(
                "".join(f'  id: "{slide_id}"\n' for slide_id in slide_ids),
                encoding="utf-8",
            )
        for chapter, body in scripts.items():
            (script_dir / f"{chapter}.md").write_text(body, encoding="utf-8")
        (narration / "pronunciation.ko.json").write_text(
            json.dumps(dictionary or [], ensure_ascii=False), encoding="utf-8"
        )

        reference = tmp_path / "reference.wav"
        at = np.arange(SAMPLE_RATE * 3, dtype=np.float32) / SAMPLE_RATE
        sf.write(reference, (np.sin(2 * np.pi * 180 * at) * 0.1).astype(np.float32), SAMPLE_RATE)
        reference_text = tmp_path / "reference.txt"
        reference_text.write_text("참조 음성입니다.\n", encoding="utf-8")

        tts = FakeTtsModel(silent_for=silent_for)
        asr = FakeAsrModel(readings)
        mx = FakeMx()

        mlx = types.ModuleType("mlx")
        mlx.core = mx
        monkeypatch.setitem(sys.modules, "mlx", mlx)
        monkeypatch.setitem(sys.modules, "mlx.core", mx)

        tts_utils = types.ModuleType("mlx_audio.tts.utils")
        tts_utils.load_model = lambda path: tts
        stt_utils = types.ModuleType("mlx_audio.stt.utils")
        stt_utils.load_model = lambda path: (
            asr if "whisper" in str(path).lower() else FakeAligner()
        )
        audio_utils = types.ModuleType("mlx_audio.utils")
        audio_utils.get_model_path = lambda repository, **_: Path(repository)
        for name, module in {
            "mlx_audio": types.ModuleType("mlx_audio"),
            "mlx_audio.tts": types.ModuleType("mlx_audio.tts"),
            "mlx_audio.tts.utils": tts_utils,
            "mlx_audio.stt": types.ModuleType("mlx_audio.stt"),
            "mlx_audio.stt.utils": stt_utils,
            "mlx_audio.utils": audio_utils,
        }.items():
            monkeypatch.setitem(sys.modules, name, module)

        from local_tts_engine import course_pilot, pilot

        # Repositories resolve to themselves; the fake loaders key off the name.
        monkeypatch.setattr(pilot, "snapshot_revision", lambda path: "fake-revision")
        monkeypatch.setattr(course_pilot, "snapshot_revision", lambda path: "fake-revision")
        monkeypatch.setattr(course_pilot, "resolve_model_path", lambda repository, _d: Path(repository))
        monkeypatch.setattr(
            course_pilot, "LOCAL_QUALITY_ASR_PATH", tmp_path / "no-local-whisper"
        )
        monkeypatch.setattr(course_pilot, "version", lambda name: "0.0.0-fake")

        # The reviewer needs to know what each clip was asked to say. The real
        # ASR learns that from the audio; the fake is told.
        original = course_pilot.trim_and_fade_audio

        def remember(audio, rate):
            return original(audio, rate)

        monkeypatch.setattr(course_pilot, "trim_and_fade_audio", remember)

        real_write = sf.write
        pending: list[str] = []

        def note_text(**kwargs):
            pending.append(str(kwargs["text"]))
            return FakeTtsModel.generate(tts, **kwargs)

        def tracked_generate(**kwargs):
            text = str(kwargs["text"])
            for result in FakeTtsModel.generate(tts, **kwargs):
                tracked_generate.last_text = text
                yield result

        def writing(path, data, rate, *args, **kwargs):
            result = real_write(path, data, rate, *args, **kwargs)
            if getattr(tracked_generate, "last_text", None) is not None:
                asr.spoken.setdefault(str(Path(path).resolve()), tracked_generate.last_text)
            return result

        tts.generate = tracked_generate
        monkeypatch.setattr(sf, "write", writing)
        monkeypatch.setattr(course_pilot.sf, "write", writing)

        return Studio(tmp_path, reference, reference_text, tts, asr, mx)

    return build
