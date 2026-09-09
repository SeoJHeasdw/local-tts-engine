from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.course_pilot import generate_candidate_audio, production_pronunciation
from local_tts_engine.english_voice import EnglishVoiceRouter, speech_segments
from local_tts_engine.pronunciation import apply_pronunciation, comparison_pronunciation, pronunciation_preflight, merge_pronunciation_dictionaries
from local_tts_engine.speech_quality import evaluate_candidate


def inline(source, reading, target=None):
    return {"from": source, "to": target or source, "literal": True,
            "inline": True, "comparisonReading": reading}


def test_approved_observation_uses_one_korean_call_with_original_reference_and_adapter():
    dictionary = production_pronunciation()
    source = '다음 판단에 넣을 새로운 Observation입니다.'
    prepared = apply_pronunciation(source, dictionary)
    calls = []
    layer = SimpleNamespace(lora_a=1, lora_b=1, scale=.6)
    model = SimpleNamespace(named_modules=lambda: [('layer', layer)])
    def generate(**kwargs):
        calls.append(kwargs)
        assert layer.scale == .6
        yield SimpleNamespace(audio=np.full(72000, .05, dtype=np.float32), sample_rate=24000, peak_memory_usage=1.)
    result = generate_candidate_audio(generate, {'text': prepared, 'lang_code': 'Korean', 'ref_audio': 'ref.wav', 'ref_text': '한국어 참조'},
                                      voice_router=EnglishVoiceRouter(dictionary, model))
    assert prepared == source
    assert len(calls) == 1 and calls[0]['text'] == source
    assert calls[0]['lang_code'] == 'Korean' and calls[0]['ref_text'] == '한국어 참조'
    assert 'voiceRouting' not in result['cleanup']
    report = pronunciation_preflight(source, dictionary)
    assert report['requiredPronunciations'] == ['Observation']
    assert report['unresolvedAscii'] == []


def test_multiword_inline_term_does_not_switch_voice_or_break_an_english_quote():
    dictionary = [inline('Anthropic', '앤스로픽'), inline('permission_denied', '퍼미션 디나이드', 'permission denied'),
                  inline('permission denied', '퍼미션 디나이드'), {'from': 'Agent', 'to': '에이전트'}]
    text = apply_pronunciation('오류는 permission_denied입니다.', dictionary)
    assert text == '오류는 permission denied입니다.'
    assert speech_segments(text, dictionary) == [{'text': text, 'language': 'Korean'}]
    quote = '문장은 "Anthropic calls an Agent."입니다.'
    assert apply_pronunciation(quote, dictionary) == quote
    assert speech_segments(quote, dictionary)[1]['language'] == 'English'
    assert apply_pronunciation('custom_permission_denied_code입니다.', dictionary) == 'custom_permission_denied_code입니다.'


def test_inline_comparison_uses_syllables_but_keeps_a_missing_term_detectable(tmp_path):
    dictionary = production_pronunciation()
    source = '다음 판단에 넣을 새로운 Observation입니다.'
    assert comparison_pronunciation(source, dictionary) == '다음 판단에 넣을 새로운 옵저베이션입니다.'
    path = tmp_path / 'three-seconds.wav'
    sf.write(path, np.sin(np.arange(72720) * .03) * .1, 24000)
    for reading in (source, '다음 판단에 넣을 새로운 옵저베이션입니다.'):
        result = evaluate_candidate(expected_text=source, recognized_text=reading, audio_path=path,
                                    dictionary=dictionary, required_pronunciations=['Observation'])
        assert result['passed'] and result['phoneticErrorRate'] == 0
        assert result['speakingCharactersPerSecond'] < 7
    missing = evaluate_candidate(expected_text=source, recognized_text='다음 판단에 넣을 새로운 것입니다.', audio_path=path,
                                 dictionary=dictionary, required_pronunciations=['Observation'])
    assert not missing['passed']


def test_inline_definition_requires_separate_synthesis_and_comparison_spellings():
    with pytest.raises(ValueError):
        merge_pronunciation_dictionaries([{'from': 'Observation', 'to': 'Observation', 'inline': True}])


def test_user_selection_preserves_approved_terms_and_leaves_deferred_terms_in_hangul():
    dictionary = production_pronunciation()
    approved = {'Observation', 'Anthropic', 'permissiondenied', 'permission_denied', 'permission denied',
                'Artificial Analysis', 'Intelligence Index', 'Boris Cherny', 'Y Combinator'}
    assert {d['from'] for d in dictionary if d.get('inline')} == approved
    text = apply_pronunciation('Authentication과 Authorization, Attention Budget과 knowledge cutoff입니다.', dictionary)
    assert text == '어센티케이션과 어서라이제이션, 어텐션 버짓과 널리지 컷오프입니다.'
    approved_text = 'Anthropic의 Artificial Analysis Intelligence Index와 Boris Cherny, Y Combinator입니다.'
    assert apply_pronunciation(approved_text, dictionary) == approved_text
    assert speech_segments(approved_text, dictionary) == [{'text': approved_text, 'language': 'Korean'}]
