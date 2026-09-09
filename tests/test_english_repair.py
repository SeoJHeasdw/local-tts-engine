import importlib.util
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.pilot import sha256_file

spec = importlib.util.spec_from_file_location("render_english_repairs", Path(__file__).parents[1] / "scripts/render_english_repairs.py")
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def test_multiple_audio_replacements_preserve_every_sample_outside_edits(tmp_path):
    rate = 48000
    samples = np.sin(np.arange(4 * rate, dtype=np.float32) * .03) * .1
    replacements = []
    for index, (start, end, new_ms) in enumerate(((500, 1000, 250), (2000, 2500, 700))):
        path = tmp_path / f"{index}.wav"
        audio = np.sin(np.arange(round(new_ms * rate / 1000), dtype=np.float32) * .08) * .05
        sf.write(path, audio, rate, subtype="PCM_24")
        replacements.append({"startMs":start,"endMs":end,"selected":{"audioPath":str(path),"sha256":sha256_file(path)}})
    updated, evidence = repair.splice_audio(samples, rate, replacements)
    assert len(updated) == round(3.95 * rate)
    assert len(evidence) == 3
    for row in evidence:
        n, old, new = row["samples"], row["oldStartSample"], row["newStartSample"]
        assert np.array_equal(samples[old:old+n],updated[new:new+n])
    mapping = repair.AudioTimeMap(replacements)
    assert [mapping(t) for t in (100, 500, 1000, 1500, 2000, 2500, 4000)] == [100, 500, 750, 1250, 1750, 2450, 3950]


def test_overlapping_edits_and_conflicting_caption_anchors_fail():
    with pytest.raises(ValueError):
        repair.AudioTimeMap([{"startMs":1,"endMs":3,"replacementMs":2},{"startMs":2,"endMs":4,"replacementMs":2}])
    old={"totalMs":1000,"entries":[{"startMs":100,"endMs":1000,"transitionAtMs":1000}]}
    new={"totalMs":900,"entries":[{"startMs":100,"endMs":900,"transitionAtMs":900}]}
    with pytest.raises(ValueError,match="상충"):
        repair.video_anchors(old,new,[{"startMs":100,"endMs":800,"text":"caption"}],
            [{"startMs":110,"endMs":750,"text":"caption"}])


def test_video_map_uses_caption_boundaries_and_compresses_only_collinear_points():
    old={"totalMs":1000,"entries":[{"startMs":100,"endMs":1000,"transitionAtMs":1000}]}
    new={"totalMs":900,"entries":[{"startMs":100,"endMs":900,"transitionAtMs":900}]}
    anchors,compact=repair.video_anchors(old,new,
        [{"startMs":200,"endMs":800,"text":"caption"}],
        [{"startMs":200,"endMs":700,"text":"caption"}])
    assert (200,200) in compact and (800,700) in compact
    assert len(compact)<len(anchors)
    assert "fps=25" in repair.video_filter(compact)


def test_new_word_times_replace_old_english_while_korean_words_only_shift():
    original={"totalMs":1500,"entries":[{
        "key":"sample--0","startMs":0,"endMs":1500,"transitionAtMs":1500,
        "speechStartMs":100,"speechEndMs":1400,"audio":{"durationMs":1500},
        "sourceText":"설명 Hello world 끝입니다.","ttsText":"설명 Hello world 끝입니다.",
        "alignment":{"words":[{"text":"설명","startMs":100,"endMs":250},
            {"text":"Hello","startMs":350,"endMs":550},{"text":"world","startMs":550,"endMs":700},
            {"text":"끝입니다","startMs":1000,"endMs":1400}]},"forcedPauses":[]} ]}
    edits=[{"entryKey":"sample--0","startMs":300,"endMs":800,"replacementMs":600,"wordStart":1,"wordCount":2,
        "selected":{"alignment":[{"text":"Hello","startMs":80,"endMs":250},{"text":"world","startMs":300,"endMs":580}]}}]
    timeline,_=repair.patch_timeline(original,edits)
    entry=timeline['entries'][0]
    assert entry['sourceText']==original['entries'][0]['sourceText']
    assert entry['alignment']['words'][0]==original['entries'][0]['alignment']['words'][0]
    assert entry['alignment']['words'][1]['startMs']==380
    assert entry['alignment']['words'][2]['endMs']==880
    assert entry['alignment']['words'][3]['startMs']==1100
    assert timeline['totalMs']==1600
