# 운영·검수 CLI

이 폴더는 앱에서 독립 실행할 수 있는 진단·검수·복구 도구다. 과거 검수 폴더의
`.command` 파일이 현재 파일명을 호출하므로 경로를 유지한다. 앱 필수 입력 준비
작업자는 `electron-app/main/workers/prepare-input.mjs`로 분리했다.

| 용도 | 파일 |
| --- | --- |
| 강의 소스·음성 정본 점검 | `check_context.py` |
| 앱 기능별 환경 진단 | `doctor.mjs` (`npm run doctor`) |
| 사전의 음절 누락 사각지대 | `check_dictionary_blind_spots.py` |
| 발음·강도 비교 | `probe_term_pronunciation.py`, `compare_unsplit_english_term.py` |
| 기존 음성 검수 | `review_existing_clips.py`, `review_restarts.py` |
| 실제 모델 운율 검증 | `validate_prosody_live.py` |
| 전체 대본·저장 검수 기록 진단 | `audit_speech_corpus.py` (GPU·새 합성 없이 실행) |
| 기존 영어 보정 준비 | `generate_english_repairs.py`, `retrofit_course_english.py` |
| 승인된 준비 기록으로 영상 보정 | `render_english_repairs.py` |
| Finder 이름 변경 후 결과 연결 복구 | `repair-output-links.mjs` |
| 앱 모듈 경로·계층·순환 검사 | `check_architecture.mjs` |
| 세 화질 실제 촬영·인코딩 검증 | `check_capture.mjs` (`npm run check:capture -- --output <새 폴더>`) |
| 요청받은 학습 데이터 재준비 | `python -m local_tts_engine.finetune_dataset --help` |

일상 검사는 `npm run check`를 사용한다. `check:capture`는 실제 브라우저로 3초짜리
화면을 세 화질로 찍어 프레임 수·전환 시각·출력 규격을 확인하며, 촬영 코드나 브라우저
판본을 건드린 뒤에만 돌린다. 모델 합성·과거 영상 수정 도구는 자동 점검의 일부가 아니다. 필요 시 각 명령의 `--help`와 계획 파일을 확인하고
승인된 입력·최신 수정본·새 출력 경로를 사용한다. 일회성 계획·음성·로그는
`output/reviews/` 또는 `artifacts/`에 저장하며 새 도구로 복제해 쌓지 않는다.

`audit_speech_corpus.py --output <새 보고서.json> --replay-text --baseline-ref HEAD`는
현재 전체 대본과 중복을 제외한 저장 판독을 점검하고, 같은 사전·전사로 변경 전후
코드 판정을 비교한다. 자동 통과율을 발음 품질 퍼센트로 해석하지 않는다.
`validate_prosody_live.py --samples-file <표본.json> --prepare-only`로 실제 챕터에서
고정한 1~16개 `{name, text}` 표본을 준비하고, Metal이 가능한 제작 환경에서
`--prepare-only`를 빼면 기존 제작 목소리·4후보 정책으로 새 음성을 검증한다.
두 도구의 `--source-project`는 덱 위치를 명시하며 기본 연결을 따른다.
`validate_prosody_live.py --review-existing <완료된 검증 폴더>`는 선택된 기존 WAV를
다시 합성하지 않고 실제 언어 구간별 새 받아쓰기·운율 검수로 확인한다. 원본 WAV와
manifest는 보존하고 새 `review-*.json`에 결과를 쓴다. 기본 2표본의 인위적 끊김
실험은 해당 대본에만 적용하며, 실제 챕터 표본에는 그 실험을 통과 조건으로 요구하지 않는다.
검증 폴더의 `listening-review.json`에 정확한 녹음·발음문·경고를 대조할 청취 기록이 있으면,
그 단일 오탐 뒤의 운율을 별도로 검사한다. `passed`를 덮지 않고 `prosodyAfterListening`에
쓰므로 원래 자동 판정과 구분한다. 짧은 낱말의 실험적 단서는
`shortWordReviewCandidates`로만 보관하며 자동 재시도에 적용하지 않는다.

학습 데이터 준비는 이미 완료됐다. 재준비를 요청받은 경우에만 새 출력 폴더에서
`segment → transcribe → reconcile-script → spot-check/apply-review → validate → export`
순으로 실행한다. 원본 `data/private/voice/training/pvc/master-wav/`는 읽기 전용이다.
각 하위 명령의 `--help`가 옵션의 기준이다. ASR 초안은 자동 승인하지 않으며
`review.tsv`에서 accepted인 클립만 공식 JSONL로 내보낸다. 기존 준비 데이터는
`artifacts/finetune-datasets/jaeho-ko-v1/`, 승인·학습 근거는 [DECISIONS](../docs/DECISIONS.md)에 있다.
