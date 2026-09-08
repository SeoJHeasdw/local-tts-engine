"""Acoustic restart warnings and their generation retry contract."""
from pathlib import Path

import numpy as np
import soundfile as sf

from local_tts_engine.restarts import acoustic_restarts, confirm_restarts, RESTART_WARNING
from local_tts_engine.speech_quality import review_candidate_prosody, chunk_severity


def sound(path, second_frequency=310, weak_first=True):
    rate = 24000
    audio = np.zeros(rate * 2, dtype=np.float32)
    for start, duration, frequency in [(.3, .12, 310), (.56, .4, second_frequency)]:
        t = np.arange(round(duration * rate)) / rate
        tone = .12 * np.sin(2 * np.pi * frequency * t) + .05 * np.sin(2 * np.pi * frequency * 3 * t)
        if start == .3 and weak_first:
            tone *= .3
        audio[round(start * rate):round(start * rate) + len(t)] = tone
    sf.write(path, audio, rate)
    return path


def test_repeated_short_onset_is_an_acoustic_candidate(tmp_path):
    candidates = acoustic_restarts(sound(tmp_path / 'repeat.wav'))
    assert candidates
    assert 290 <= candidates[0]['startMs'] <= 320
    assert 550 <= candidates[0]['restartMs'] <= 580


def test_different_sounds_and_silence_are_not_repetition(tmp_path):
    assert not acoustic_restarts(sound(tmp_path / 'different.wav', 1700))
    assert not acoustic_restarts(sound(tmp_path / 'equal.wav', weak_first=False))
    sf.write(tmp_path / 'silent.wav', np.zeros(48000), 24000)
    assert not acoustic_restarts(tmp_path / 'silent.wav')


def test_source_repetition_and_word_boundaries_are_protected():
    candidate = {'startMs': 300, 'endMs': 710, 'restartMs': 560, 'similarity': .95}
    assert confirm_restarts([candidate], [{'text':'초안','startMs':280,'endMs':980}], '초안 뒤의 일')
    assert not confirm_restarts([candidate], [{'text':'똑똑한','startMs':280,'endMs':980}], '똑똑한 사람')
    assert not confirm_restarts([candidate], [{'text':'하나하나','startMs':280,'endMs':980}], '하나하나 봅니다')
    assert not confirm_restarts([candidate], [{'text':'초','startMs':280,'endMs':430}, {'text':'초안','startMs':550,'endMs':980}], '초 초안')
    assert not confirm_restarts([candidate], [{'text':'초안','startMs':280,'endMs':980}], '초 초안')
    assert not confirm_restarts([candidate], [{'text':'반복됩니다','startMs':280,'endMs':980}], '반복됩니다')
    assert not confirm_restarts([candidate], [], '초안')
    assert not confirm_restarts([candidate], [{'text':'초안','startMs':float('nan'),'endMs':980}], '초안')
    assert not confirm_restarts([candidate], [{'text':'초안','startMs':280,'endMs':980}], '다른 대본')


def test_clean_transcript_still_requests_retry_on_acoustic_restart(tmp_path):
    path = sound(tmp_path / 'repeat.wav')
    original = {'passed':True,'audioPath':str(path),'expectedText':'초안 뒤의 일',
                'recognizedText':'초안 뒤의 일','waveform':{'durationMs':2000},
                'warnings':[],'failures':[],'score':0}
    evaluated = review_candidate_prosody(original, lambda *_: [], lambda *_:[{'text':'초안','startMs':280,'endMs':980}])
    assert not evaluated['passed']
    assert RESTART_WARNING in evaluated['warnings']
    assert evaluated['restarts']['checks'][0]['term'] == '초안'
    assert original['passed']
    assert chunk_severity([evaluated, evaluated], evaluated) == 'warning'
    # Without independent word coverage this remains a recorded candidate.
    unchecked = review_candidate_prosody(original, lambda *_: [])
    assert unchecked['passed']
    assert unchecked['restarts']['status'] == 'alignment-unavailable'
