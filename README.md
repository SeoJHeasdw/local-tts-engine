# Local TTS Engine

Apple Silicon에서 한국어 강의용 개인 음성을 로컬로 생성하는 독립 프로젝트입니다.
첫 사용처는 `udemy-agent` 강의지만, 이후 다른 강의와 영상에서도 재사용할 수
있는 엔진으로 유지합니다.

## 현재 상태

- 프로젝트 뼈대와 영구 작업 지침 구성 완료
- 기존 강의 대본·발음 사전·53분 20초 정제 음성 세트 경로 연결 완료
- 모델 설치와 가중치 다운로드는 아직 하지 않음
- 첫 후보는 Qwen3-TTS 1.7B Base, 비교 후보는 Chatterbox Multilingual V3
- ElevenLabs 결제는 보류하고 로컬 A/B 파일럿부터 진행

## 새 작업에서 시작하기

1. 이 폴더를 Codex의 로컬 프로젝트로 엽니다.
2. 저장소를 신뢰하고 프로젝트 권한 설정을 허용합니다.
3. `AGENTS.md`와 `docs/HANDOFF.md`를 읽습니다.
4. `python3.13 scripts/check_context.py`로 기존 자료 연결을 확인합니다.
5. `docs/BENCHMARK-PLAN.md` 순서로 CH01 30~60초 A/B 샘플을 만듭니다.

## 경계

- 이 저장소: 모델 실행, 개인 음성 프로필, 벤치마크, 로컬 TTS API/CLI
- `udemy-agent`: 강의 대본, 자막, 슬라이드, 영상 렌더와 최종 결과물
- 모델 가중치, 원본 녹음, 생성 음성, 비밀값은 Git에 넣지 않습니다.

자세한 현재 상황은 `docs/HANDOFF.md`, 연결 방식은
`docs/ARCHITECTURE.md`를 기준으로 합니다.
