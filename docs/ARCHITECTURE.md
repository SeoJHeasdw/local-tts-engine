# 아키텍처와 데이터 계약

## 책임과 코드 위치

`udemy-agent`는 강의 대본·화면·자료·캡처 도구, 이 저장소는 개인 음성·TTS 작업·
자막·타임라인·완성 영상을 소유한다. 실행법은 [README](../README.md)에 있다.

| 위치 | 책임 |
| --- | --- |
| `electron-app/main.mjs` | Electron 실행 진입점 |
| `electron-app/main/application.mjs` | 서비스 조립과 앱 수명 |
| `electron-app/main/runtime.mjs`, `job-process.mjs` | 프로세스 실행·진행 이벤트·중지·일시정지 |
| `electron-app/main/production.mjs` | 입력 고정 → 합성 → 자막 → 촬영 → 검증·발행 |
| `electron-app/main/voices.mjs` | 텍스트·페이지 음성 후보와 학습 작업 |
| `electron-app/main/editing/` | 합치기·페이지 교체·구간 편집·미리듣기 |
| `electron-app/main/`의 나머지 서비스 | 경로·설정·목록·파일·미디어·결과·IPC·창 관리 |
| `electron-app/renderer/app.js` | 초기화·화면 전환·제작 진행 |
| `electron-app/renderer/controllers/` | 검수·클립 편집·최근 결과 화면 |
| `electron-app/shared/` | 옵션·이름·타임라인·검수·시간 계산 |
| `src/local_tts_engine/course_pilot.py` | 강의 생성 CLI 조립 |
| `src/local_tts_engine/course/` | 대본 입력·청킹·오디오·정렬·직렬화 |
| `src/local_tts_engine/course_catalog.py` | 생성 모델을 로드하지 않는 목록 CLI |
| `src/local_tts_engine/`의 나머지 모듈 | 발음·독립 검수·텍스트 후보·내보내기·학습 |
| `scripts/`, `tests/` | 수동 운영 도구와 회귀 검사 |

## 의존성 규칙

- Electron은 진입점에서 서비스에 주입한다. 서비스는 Electron을 직접 import하지 않는다.
- `main`과 `renderer`는 서로의 구현을 import하지 않는다. 공통 계산은 `shared`에 두고
  `shared`에서 상위 계층을 참조하지 않는다.
- renderer의 의존성 전체에는 Node·Electron이 없어야 한다. Node용 공유 모음은
  `shared/index.mjs`, 브라우저는 필요한 개별 모듈을 사용한다.
- Python `course/`는 `course_pilot` 조립 모듈을 역참조하지 않는다. 기존 CLI·helper
  import와 저장된 검수 명령의 `scripts/` 경로는 호환 계약이다.
- `npm run check:architecture`가 경로 단절·계층 역참조·순환·브라우저 의존성을 검사한다.
  동작 검사는 실제 서비스·컨트롤러를 import하며 소스 조각 평가로 구현을 복제하지 않는다.

## 제작 흐름과 복구

```text
preload IPC → 제작 서비스 → 독립 입력 준비 → Python 합성·검수·정렬
            → export → 덱 자막·촬영 → 파일 검증 → 발행
```

`main/workers/prepare-input.mjs`가 덱의 `tools/production.mjs`를 별도 프로세스로
실행한다. 화면·대본·자료·순서를 `.production-input`에 고정하고 전후 해시, 선택 ID·
스텝, 챕터 린터를 검사한다. 영상이면 타입 검사·정적 빌드도 수행한다. 한 챕터의 모든
레슨은 이 입력을 사용하며 원본 `narration.config.json`을 제작 중 수정하지 않는다.

발음 처리는 각 레슨의 `course_entries`에서 한 번 수행한다. 미등록 용어는 합성을
막지 않고 실제 청크 시각과 함께 완료 후 검수 대상으로 남긴다. 상세는 [QUALITY](QUALITY.md).
`sourceContract`는 manifest → export timeline → 검수·촬영 기록으로 전달한다.
촬영 전 타임라인의 ID·구도·videoBeats가 고정한 사이트와 일치하는지 확인한다.

중지는 프로세스 그룹에 SIGTERM, 남으면 3초 뒤 SIGKILL을 보낸다. 촬영 중 일시정지는
현재 편 뒤에 처리한다. 다른 단계의 실제 정지 시간은 남은 시간 추정에서 제외한다.
레슨 분할 제작은 개별 실패를 기록하고 나머지를 계속하되 사용자 중지는 즉시 전파한다.

| 기록 | 의미 |
| --- | --- |
| `.production-input/production-input.json` | 고정 입력·선택 범위의 판본 |
| 음성 `manifest.json` | 발음문·실제 음성 길이·정렬·검수 근거 |
| 레슨 `validation-report.json` | 파일 검사·음성 확인 항목·결과 위치 |
| 챕터 `chapter-report.json` | 완료·실패 레슨과 원인 |
| `artifacts/active-job.json` | 명시적 이어하기의 옵션·완료·실패 기록 |

실패 시 입력을 보존하고 성공·중지·이어하기 기록 삭제 때 정리한다. 이어하기는 완료
레슨의 실제 파일·화질·판본·해시를 검사한다. 실패 레슨의 음성·정렬·촬영은 새로 실행한다.
새 작업은 과거 완성본을 자동으로 건너뛰지 않으며 앱의 생성 캐시는 항상 꺼져 있다.

## 타임라인과 편집

`sourceText`/`source_text`는 자막 원문, `ttsText`/`tts_text`는 발음문이다. 생성 후
실제 오디오와 ForcedAligner 단어 시각으로 화면·자막을 배치한다. `[Ns]` 단독 줄은
0.1~10초 무음이며 자막에 노출하지 않는다. 읽을 문장 없는 마커는 입력 오류다.

페이지 교체는 선택 음성과 그 길이 차이만 반영한다. 여러 교체는 뒤에서부터 적용하고
다른 페이지의 검수·확인 키·자막을 보존한다. 교체된 판독은 다시 청취할 대상으로 표시한다.
최신 수정본의 PCM·타임라인을 사용하며 원본 manifest로 되돌리지 않는다.

영상 스트림 복사·재인코딩·해상도·프레임률 보존 기준은 [VIDEO-QUALITY](VIDEO-QUALITY.md)에
모아 둔다. 구간 편집은 `match-audio`에서 화면 길이를 음성에 맞추고, `keep-video`에서
짧은 음성은 무음으로 채우되 긴 음성은 거절한다. 무음은 0.05~2초, 준비 음성 교체는
0.05~120초다. 미리듣기는 실제 WAV를 자르며 오래된 응답을 버리고 임시 파일은 최근 8개만 둔다.

미디어 정보 조회는 요청당 최대 4개씩 실행하고 같은 요청의 중복 파일 조회만 공유한다.
이 내부 병렬 조회는 실패 뒤 새 배정을 멈추고 이미 실행 중인 작업을 기다린다.
이는 레슨별 제작 실패 후 다음 레슨으로 진행하는 정책과 별개다.

완성 영상은 같은 이름의 `.timeline.json`을 갖고 이름 변경 시 연결 파일도 이동한다.
삭제는 UI 확인 후 휴지통으로 보낸다. 원본·완성본·개인 음성·가중치는 자동 정리하지 않는다.
`review.status=approved`와 사용자 확인 키는 자동 파일 검사와 독립적으로 저장한다.
