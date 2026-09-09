from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from local_tts_engine.course_pilot import generate_candidate_audio, production_pronunciation
from local_tts_engine.english_voice import EnglishVoiceRouter, speech_segments
from local_tts_engine.pronunciation import (
    apply_pronunciation, comparison_pronunciation, declared_readings,
    merge_pronunciation_dictionaries, pronunciation_preflight,
)
from local_tts_engine.speech_quality import check_pronunciation, evaluate_candidate


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


def test_declared_readings_separate_an_asr_spelling_from_a_misread_vowel(tmp_path):
    """Anthropic이 '안쓰로픽'으로 읽혀도 통과하던 구멍을 막는다.

    이 강의 받아쓰기에서 실제로 나온 표기는 엔스로픽·엔트로픽·안쓰로픽·안트로픽
    이고, 앤스로픽에서 넷 다 정확히 0.10이다. 거리로는 갈라지지 않는다 — 갈리는
    것은 어느 자모가 다른가다. 그래서 받아들일 표기를 사전이 직접 적는다.
    """
    dictionary = [{**inline('Anthropic', '앤스로픽'), 'comparisonVariants': ['앤트로픽']}]
    source = 'Anthropic은 평가가 좋아질 때 남깁니다.'
    path = tmp_path / 'clip.wav'
    sf.write(path, np.sin(np.arange(72720) * .03) * .1, 24000)

    def verdict(recognized):
        result = evaluate_candidate(expected_text=source, recognized_text=recognized, audio_path=path,
                                    dictionary=dictionary, required_pronunciations=['Anthropic'])
        return next(c for c in result['pronunciationChecks'] if c['term'] == 'Anthropic')

    for accepted in ('엔스로픽은 평가가 좋아질 때 남깁니다.', '엔트로픽은 평가가 좋아질 때 남깁니다.',
                     '앤쓰로픽은 평가가 좋아질 때 남깁니다.', 'Anthropic은 평가가 좋아질 때 남깁니다.'):
        assert verdict(accepted)['status'] == 'ok', accepted
    for misread in ('안쓰로픽은 평가가 좋아질 때 남깁니다.', '안트로픽은 평가가 좋아질 때 남깁니다.'):
        check = verdict(misread)
        assert check['status'] == 'warning' and check['reason'] == '지정 발음 확인 필요'
        # 무엇으로 들렸는지가 곧 확인 근거다. 들어 보기 전에 판단이 선다.
        assert check['heardReading'].startswith(misread[:4])
        assert check['declaredReadings'] == ['앤스로픽', '앤트로픽']
    assert verdict('평가가 좋아질 때 남깁니다.')['status'] == 'failed'


def test_production_declares_one_reading_so_every_other_spelling_is_shown(tmp_path):
    """제작 사전은 아직 표준 표기만 선언한다 — 나머지는 사람이 듣고 정한다.

    θ를 트로 적은 '엔트로픽'이 받아쓰기 표기차인지 실제로 T로 읽은 것인지는
    귀로만 갈린다. 그래서 미리 받아주지 않고 확인 항목으로 올린다. 들어 보고
    정상이면 그 항목의 comparisonVariants에 한 줄 넣으면 다음부터 통과한다.
    """
    dictionary = production_pronunciation()
    assert declared_readings('Anthropic', dictionary) == ('앤스로픽',)
    source = 'Anthropic은 평가가 좋아질 때 남깁니다.'
    path = tmp_path / 'clip.wav'
    sf.write(path, np.sin(np.arange(72720) * .03) * .1, 24000)
    check = next(c for c in evaluate_candidate(
        expected_text=source, recognized_text='엔트로픽은 평가가 좋아질 때 남깁니다.', audio_path=path,
        dictionary=dictionary, required_pronunciations=['Anthropic'])['pronunciationChecks']
        if c['term'] == 'Anthropic')
    assert check['status'] == 'warning' and check['heardReading'] == '엔트로픽은'
    # 표기 하나를 받아들이기로 하면 그 자리에서 통과로 바뀐다.
    accepted = [{**item, 'comparisonVariants': ['앤트로픽']} if item.get('from') == 'Anthropic' else item
                for item in dictionary]
    assert check_pronunciation('Anthropic', source, '엔트로픽은 평가가 좋아질 때 남깁니다.', accepted)['status'] == 'ok'


def test_a_correct_reading_does_not_cover_for_a_second_wrong_one():
    """두 번 나온 용어를 한 번만 제대로 읽으면 그 사실이 남아야 한다.

    거리는 받아쓰기 전체에서 가장 잘 맞는 자리로 재므로, 하나만 맞아도 0이다.
    세는 기준도 판정과 같아야 나머지 하나가 뒤에 숨지 않는다.
    """
    dictionary = [{**inline('Anthropic', '앤스로픽'), 'comparisonVariants': ['앤트로픽']}]
    source = 'Anthropic은 평가를 봅니다. 그래서 Anthropic은 남깁니다.'
    both = check_pronunciation('Anthropic', source, '앤스로픽은 평가를 봅니다. 그래서 앤트로픽은 남깁니다.', dictionary)
    assert both['status'] == 'ok' and (both['expectedCount'], both['heardCount']) == (2, 2)
    one = check_pronunciation('Anthropic', source, '앤스로픽은 평가를 봅니다. 그래서 안쓰로픽은 남깁니다.', dictionary)
    assert one['status'] == 'warning' and one['reason'] == '지정 발음 일부 누락'
    assert (one['expectedCount'], one['heardCount']) == (2, 1) and one['distance'] == 0


def test_terms_without_a_declared_reading_keep_the_tolerant_spelling_gate():
    """숫자와 약어의 받아쓰기 표기까지 엄격하게 보면 멀쩡한 페이지가 걸린다.

    같은 강의에서 A2041은 '에이 이공사일'로 지정했는데 받아쓰기는 '에이이영사일'
    로 적는다. 0과 영·공처럼 표기만 다른 경우가 이 층에 여전히 필요하다.
    """
    dictionary = production_pronunciation()
    source = '주문 A-2041을 확인합니다.'
    check = check_pronunciation('에이 이공사일', source, '주문 에이 이영사일을 확인합니다.', dictionary)
    assert check['status'] == 'ok' and 0 < check['distance'] <= .15
    assert 'declaredReadings' not in check


def test_accepted_spellings_must_be_hangul_and_belong_to_a_declared_reading():
    with pytest.raises(ValueError, match='comparisonVariants'):
        merge_pronunciation_dictionaries([{**inline('Anthropic', '앤스로픽'), 'comparisonVariants': ['Anthropic']}])
    with pytest.raises(ValueError, match='comparisonVariants'):
        merge_pronunciation_dictionaries([{'from': 'Agent', 'to': '에이전트', 'comparisonVariants': ['에이젼트']}])
    assert declared_readings('Anthropic', [inline('Anthropic', '앤스로픽')]) == ('앤스로픽',)
    assert declared_readings('에이전트', [{'from': 'Agent', 'to': '에이전트'}]) == ()
