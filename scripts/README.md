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
| 기존 영어 보정 준비 | `generate_english_repairs.py`, `retrofit_course_english.py` |
| 승인된 준비 기록으로 영상 보정 | `render_english_repairs.py` |
| Finder 이름 변경 후 결과 연결 복구 | `repair-output-links.mjs` |
| 앱 모듈 경로·계층·순환 검사 | `check_architecture.mjs` |

일상 검사는 `npm run check`를 사용한다. 모델 합성·과거 영상 수정 도구는
자동 점검의 일부가 아니다. 필요 시 각 명령의 `--help`와 계획 파일을 확인하고
승인된 입력·최신 수정본·새 출력 경로를 사용한다. 일회성 계획·음성·로그는
`output/reviews/` 또는 `artifacts/`에 저장하며 새 도구로 복제해 쌓지 않는다.
