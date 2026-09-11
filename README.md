# Local TTS Engine

Apple Silicon Mac에서 개인 음성으로 한국어 강의·자막·영상을 만드는 로컬 제작 도구다.
현재 환경은 M4 Max 36GB, Python 3.13.12다. 강의 소스는 형제 프로젝트
`udemy-agent`가 제공하고 음성·타임라인·완성 영상은 이 저장소가 관리한다.

## 실행과 검사

```bash
./app.sh
npm run doctor
npm test
npm run check
```

`doctor`는 텍스트 목소리, 영상 편집, 강의 제작의 준비 상태를 따로 확인한다.
`check`는 환경 진단·모듈 의존관계 검사·앱과 Python 테스트를 모두 실행한다.
상세 경로가 필요할 때만 `npm run doctor -- --verbose`를 사용한다.

## 앱에서 하는 일

- **새 영상**: 레슨, 페이지 범위, 챕터를 선택해 음성·자막·화면 촬영을 실행한다.
  영상 화질은 초고화질 4K / 고화질 1440p(기본) / 기존 해상도 1080p 중 선택하며 기기에 기억한다.
  [화질·촬영·편집 계약과 검증 범위](docs/VIDEO-QUALITY.md)를 참고한다.
  챕터는 한 편으로 만들거나 레슨별로 나눌 수 있다.
- **목소리 만들기**: 텍스트로 여러 후보를 만들고 직접 들어 하나를 선택한다.
- **다듬기**: 영상·대본·자동 확인 항목을 보며 페이지 음성을 재생성하거나
  선택 구간을 무음 처리하고 준비된 음성으로 교체한다. 원본은 보존한다.
- **영상 편집**: 클립의 순서와 시작·끝을 정해 자르거나 합친다.
- **최근 결과**: 결과 검색, 이름 변경, 청취 확인, Finder 표시와 휴지통 이동을 제공한다.

한국어 제작 음성은 Qwen3-TTS 1.7B Base + `jaeho-ko-r16-v1` LoRA **0.60**이다.
영어 인용문은 사용자 승인한 `english-speaker-only-v1`으로 따로 생성한다.
승인된 문장 안 영어 용어는 한국어 문장과 함께 읽는다. 자동 검사와 최종 청취
승인은 구분하며, 제작값은 사용자 청취 승인 없이 바꾸지 않는다.

## 폴더 안내

| 폴더 | 책임 |
| --- | --- |
| `electron-app/main/` | 앱 초기화, 작업 실행, 제작·편집·결과 관리 서비스 |
| `electron-app/renderer/` | 화면과 화면별 컨트롤러, 디자인·모션 |
| `electron-app/shared/` | 옵션, 타임라인, 검수·시간 계산 등의 공통 규칙 |
| `src/local_tts_engine/` | Python 음성 생성 CLI와 발음·음성 검수 |
| `src/local_tts_engine/course/` | 강의 입력·청킹, 오디오 처리, 정렬·메타데이터 |
| `tests/electron/` | 앱·화면·실제 FFmpeg 연동 검사 |
| `tests/test_*.py`, `tests/fixtures/` | 엔진 검사와 재현용 텍스트 자료 |
| `scripts/` | 환경 점검과 수동 검수·복구 CLI |
| `config/` | 제작 발음 사전과 데이터 연결 설정 |
| `docs/` | 현재 구조, 검수 계약, 승인·라이선스 근거 |

`electron-app/main.mjs`와 기존 Python CLI 이름은 실행 진입점으로 유지한다.
저장된 로컬 검수 명령이 사용하는 `scripts/`의 파일명도 유지한다.

## 로컬 데이터

설정은 `artifacts/app-settings.json`에 저장한다. 앱에서 강의 소스·음성 원본·
결과물 폴더와 고급 참조 입력을 고를 수 있다.

| 경로 | 내용 |
| --- | --- |
| `data/private/voice/` | 불변 음성 정본 |
| `artifacts/` | 모델, 승인 어댑터, 참조 음성, 학습·측정 기록, 앱 설정 |
| `output/videos/` | 완성 강의 영상 |
| `output/projects/` | 자막·타임라인·검수 기록 |
| `output/tts/` | 강의 음성·후보·정렬 |
| `output/voices/` | 텍스트 목소리 후보와 선택 결과 |
| `output/edits/`, `output/reviews/` | 수정본과 청취·복구 기록 |

이 경로들은 Git에서 제외한다. 원본 녹음, 모델과 완성 영상을 소스 정리 때문에
지우거나 이동하지 않는다. 이전 `artifacts/` 산출물은 계속 읽을 수 있다.

## 이어 읽기

- [현재 상태와 이어받기](docs/HANDOFF.md)
- [아키텍처와 변경 경계](docs/ARCHITECTURE.md)
- [음성 검수 계약과 측정 근거](docs/QUALITY.md)
- [승인·라이선스 결정 기록](docs/DECISIONS.md)
- [점검·검수 스크립트 안내](scripts/README.md)

모델 비교와 LoRA 선택은 완료됐다. 새 설치·학습·전체 강의 재생성은 사용자가
요청한 작업 범위에서만 진행한다.
