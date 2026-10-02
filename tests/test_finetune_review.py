import json
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.finetune_review import audio_measurements, review_dataset, transcript_agreement


def test_waveform_warnings_are_measured_without_changing_audio() -> None:
    sound = np.concatenate([np.zeros(2000), np.full(3000, 0.1)]).astype(np.float32)
    metrics = audio_measurements(sound, 1000)
    assert metrics['quietRatio'] == 0.4
    assert metrics['leadingQuietMs'] == 2000
    assert [warning['code'] for warning in metrics['warnings']] == ['long-silence']
    clipped = audio_measurements(np.ones(4000), 1000)
    assert clipped['clippingRatio'] == 1
    assert clipped['warnings'][0]['code'] == 'clipping'
    with pytest.raises(ValueError):
        audio_measurements(np.array([]), 1000)


def test_transcript_agreement_needs_two_nonempty_readings() -> None:
    assert transcript_agreement('안녕하세요.', '안녕 하세요!') == 1
    assert transcript_agreement('안녕하세요', '오늘은 비가 옵니다') < 0.9
    assert transcript_agreement('안녕하세요', '') is None
    assert transcript_agreement('', '') is None


def test_report_is_hash_bound_and_flags_source_tail(tmp_path: Path) -> None:
    audio = tmp_path / 'clip.wav'
    sf.write(audio, np.full(8000, 0.1), 1000, subtype='PCM_24')
    original = audio.read_bytes()
    row = {'id': 'one', 'audio': str(audio), 'text': '안녕하세요', 'asrText': '안녕하세요',
           'sourceAudio': str(audio), 'endMs': 8000, 'splitMethod': 'tail'}
    (tmp_path / 'metadata.jsonl').write_text(json.dumps(row, ensure_ascii=False) + '\n')
    (tmp_path / 'manifest.json').write_text(json.dumps({'originalSource': {'decodeNote': 'last packet warning'}}))
    report = review_dataset(tmp_path, comparison_model=tmp_path, reader=lambda _: '안녕하세요.')
    clip = report['clips'][0]
    assert clip['transcriptAgreement'] == 1
    assert clip['audio']['warnings'][0]['code'] == 'source-decode-tail'
    assert report['speakerSimilarity'] == 'not-measured'
    assert audio.read_bytes() == original
    # CPU-only analysis keeps prior independent readings only for identical bytes.
    assert review_dataset(tmp_path)['clips'][0]['independentText'] == '안녕하세요.'
    sf.write(audio, np.full(8000, 0.2), 1000, subtype='PCM_24')
    stale = review_dataset(tmp_path)['clips'][0]
    assert stale['independentText'] is None
    assert stale['transcriptAgreement'] is None
