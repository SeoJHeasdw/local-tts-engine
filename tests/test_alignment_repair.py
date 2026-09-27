from copy import deepcopy

from local_tts_engine.course.alignment_repair import repair_timeline


def entry(words, *, step=0, start=0, end=4700):
    return {"chapter": "ch01", "slideId": "test", "slideNumber": 1, "step": step,
            "sourceText": "원문 그대로", "ttsText": "읽는 말 그대로", "startMs": start,
            "endMs": end, "transitionAtMs": end, "gapAfterMs": 0,
            "speechStartMs": words[0]["startMs"], "speechEndMs": words[-1]["endMs"],
            "alignment": {"words": words}}


def word(text, start, end):
    return {"text": text, "startMs": start, "endMs": end}


def test_collapsed_phrase_and_final_sentence_return_to_separate_speech_islands():
    words = [word('클로드', 0, 400), word('코드나', 400, 800), word('코덱스라면', 800, 1600),
             word('서브에이전트', 1632, 1664), word('셋입니다', 1696, 1728),
             word('계약은', 1760, 2400), word('같습니다', 2400, 3120)]
    timeline = {"totalMs": 4700, "entries": [entry(words)]}
    before = deepcopy(timeline)
    silences = [{"startMs": 1561, "endMs": 1795}, {"startMs": 3115, "endMs": 3490}, {"startMs": 4475, "endMs": 4700}]
    fixed, report = repair_timeline(timeline, silences)
    revised = fixed['entries'][0]['alignment']['words']
    assert timeline == before
    assert [w['text'] for w in revised] == [w['text'] for w in words]
    assert revised[3]['startMs'] == 1795
    assert revised[4]['endMs'] == 3115
    assert revised[5]['startMs'] == 3490
    assert revised[-1]['endMs'] == 4475
    assert all(w['endMs'] - w['startMs'] >= 80 for w in revised)
    assert fixed['entries'][0]['alignment']['rawWords'] == words
    assert report['audioModified'] is False
    assert report['lexicalTimingGuaranteed'] is False
    assert repair_timeline(fixed, silences)[0]['entries'] == fixed['entries']


def test_transition_moves_out_of_next_utterance_and_corrects_its_first_word():
    timeline = {'totalMs': 11000, 'entries': [
        entry([word('첫문장입니다', 1300, 8700)], start=1300, end=9500),
        entry([word('다음문장입니다', 9620, 10700)], step=1, start=9500, end=11000)]}
    fixed, _ = repair_timeline(timeline, [
        {'startMs': 0, 'endMs': 1300}, {'startMs': 8800, 'endMs': 9280}, {'startMs': 10700, 'endMs': 11000}])
    a, b = fixed['entries']
    assert 8800 <= a['transitionAtMs'] <= 9280
    assert b['startMs'] == a['transitionAtMs']
    assert b['speechStartMs'] == 9280
    assert [(e['step'], e['sourceText'], e['chapter']) for e in fixed['entries']] == [
        (e['step'], e['sourceText'], e['chapter']) for e in timeline['entries']]


def test_weak_unvoiced_tail_does_not_steal_a_normal_multisyllable_word():
    timeline = {'totalMs': 4700, 'entries': [entry([
        word('단계마다', 2889, 3209), word('세어', 3209, 3529), word('봤습니다', 3609, 4089)], start=2600, end=4700)]}
    silence = [{'startMs': 0, 'endMs': 2600}, {'startMs': 4012, 'endMs': 4562}, {'startMs': 4651, 'endMs': 4700}]
    evidence = [{'startMs': 4562, 'endMs': 4651, 'rmsDb': -45.8, 'periodicVoiceMs': 0, 'weakNonSpeechCandidate': True}]
    fixed, report = repair_timeline(timeline, silence, speech_evidence=evidence)
    last = fixed['entries'][0]['alignment']['words'][-1]
    assert last == timeline['entries'][0]['alignment']['words'][-1]
    assert report['unassignedSpeechCandidates'][0]['startMs'] == 4562
    assert report['warnings'][0]['type'] == 'unassigned-weak-tail'


def test_tiny_waveform_island_cannot_compress_a_good_long_word_even_without_acoustic_evidence():
    timeline = {'totalMs': 4700, 'entries': [entry([
        word('단계마다', 2889, 3209), word('세어', 3209, 3529), word('봤습니다', 3609, 4089)], start=2600, end=4700)]}
    fixed, report = repair_timeline(timeline, [
        {'startMs': 0, 'endMs': 2600}, {'startMs': 4012, 'endMs': 4562}, {'startMs': 4651, 'endMs': 4700}])
    assert fixed['entries'][0]['alignment']['words'] == timeline['entries'][0]['alignment']['words']
    assert report['warnings'][0]['type'] == 'ambiguous-speech-islands'


def test_no_nearby_pause_leaves_transition_with_a_warning_instead_of_moving_words():
    timeline = {'totalMs': 8000, 'entries': [
        entry([word('앞입니다', 0, 3900)], end=4000),
        entry([word('뒤입니다', 4100, 7900)], step=1, start=4000, end=8000)]}
    fixed, report = repair_timeline(timeline, [])
    assert fixed['entries'][0]['transitionAtMs'] == 4000
    assert any(w['type'] == 'no-nearby-transition-silence' for w in report['warnings'])


def test_healthy_single_syllable_is_not_shortened_below_80ms_by_boundary_rounding():
    timeline = {'totalMs': 1000, 'entries': [entry([
        word('이', 100, 180), word('단어입니다', 180, 900)], end=1000)]}
    fixed, _ = repair_timeline(timeline, [{'startMs': 0, 'endMs': 116}, {'startMs': 900, 'endMs': 1000}])
    assert fixed['entries'][0]['alignment']['words'][0] == word('이', 100, 180)


def test_multisyllable_80ms_word_is_also_treated_as_collapsed():
    timeline = {'totalMs': 2000, 'entries': [entry([
        word('오케스트레이터가', 0, 80), word('있습니다', 80, 1800)], end=2000)]}
    fixed, _ = repair_timeline(timeline, [{'startMs': 1800, 'endMs': 2000}])
    words = fixed['entries'][0]['alignment']['words']
    assert words[0]['endMs'] - words[0]['startMs'] >= 8 * 60
    assert words[1]['endMs'] - words[1]['startMs'] >= 4 * 60


def test_rate_warning_does_not_split_normal_number_phrase_at_short_unvoiced_islands():
    words = [word(*item) for item in [
        ('경계와', 2600, 3240), ('예외를', 3480, 3640), ('다뤘는가', 3640, 4280),
        ('십구', 4440, 4920), ('점', 4920, 5160), ('위험과', 5400, 5880),
        ('승인', 5880, 6200), ('십팔', 6200, 6600), ('점', 6600, 6920),
    ]]
    timeline = {'totalMs': 7000, 'entries': [entry(words, start=2600, end=7000)]}
    fixed, _ = repair_timeline(timeline, [
        {'startMs': 0, 'endMs': 2609}, {'startMs': 4256, 'endMs': 4499},
        {'startMs': 4586, 'endMs': 4747}, {'startMs': 5237, 'endMs': 5450},
        {'startMs': 6284, 'endMs': 6412}, {'startMs': 6880, 'endMs': 7000},
    ])
    revised = fixed['entries'][0]['alignment']['words']
    assert revised[3]['startMs'] > 4200, '십구 점을 앞 구절로 밀면 안 된다'
    assert revised[4]['endMs'] - revised[4]['startMs'] >= 120, '87ms 무성 꼬리에 점을 강제 배정하지 않는다'
    assert revised[5]['startMs'] > 5000, '위험과가 원래 숫자 구절을 차지하지 않는다'
