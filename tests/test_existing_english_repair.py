import importlib.util
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

spec = importlib.util.spec_from_file_location('retrofit', Path(__file__).parents[1] / 'scripts/retrofit_course_english.py')
retrofit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retrofit)


@pytest.mark.parametrize('localized_valid', [True, False])
def test_collapsed_words_require_real_local_realignment_and_preserve_the_first_evidence(tmp_path, localized_valid):
    path = tmp_path / 'source.wav'
    sf.write(path, np.sin(np.arange(48000) * .03) * .1, 48000, subtype='PCM_24')
    calls = []
    def generate(**kwargs):
        audio, rate = sf.read(kwargs['audio'])
        assert rate == 48000 and len(audio) == 48000
        calls.append(kwargs)
        bounds = [(0, .2), (.2, .2), (.6, .6), (.6, 1.)]
        if len(calls) > 1 and localized_valid:
            bounds = [(0, .2), (.2, .45), (.45, .65), (.65, 1.)]
        return SimpleNamespace(items=[SimpleNamespace(text=word, start_time=a, end_time=b)
                                     for word, (a, b) in zip(['약', '십오', '배를', '여기'], bounds)])
    aligner = SimpleNamespace(generate=generate)
    if not localized_valid:
        with pytest.raises(ValueError, match='Localized alignment'):
            retrofit.align_checked_audio(aligner, path, '약 십오 배를 여기')
    else:
        words, original, repairs = retrofit.align_checked_audio(aligner, path, '약 십오 배를 여기')
        assert original[1]['startMs'] == original[1]['endMs'] == 200
        assert words[1]['startMs'] == 200 and words[1]['endMs'] == 450
        assert repairs[0]['method'] == 'localized-independent-alignment'
    assert len(calls) == 2
    assert calls[1]['audio'] != str(path)
