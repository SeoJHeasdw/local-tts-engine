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
| 선택한 녹음의 전사·화자 일관성 분석 | `.venv-train/bin/python scripts/analyze_voice.py --dataset-dir <데이터 폴더>` (일반 로컬 터미널·Metal 필요) |
| 검수본의 학습 계획 준비 | `.venv-train/bin/python scripts/train_voice.py prepare --help` |
| 검수본 학습·참조 연결·비교 | `.venv-train/bin/python scripts/train_voice.py compare --help` (같은 제작 환경, 준비된 training-plan 사용) |

`analyze_voice.py`는 선택한 데이터의 클립 수를 읽고 기존 로컬 Qwen3-ASR·Whisper·Qwen3-TTS
Base로 전사·측정한다. 원본과 제작 기본값을 바꾸거나 모델을 내려받지 않는다.
결과는 데이터 폴더의 `direct-analysis.json`과 `direct-analysis-summary.json`이다.
화자 벡터는 기존 Base의 ECAPA encoder로 고정하고, 자기 자신을 제외한 다른 원본과의
코사인 중앙값을 기록한다. 이것은 음성 일관성 비교이며 닮은 정도의 확률·청취 승인이 아니다.
학습은 아직 실행하지 않고 불일치·녹음 경고·낮은 화자 일관성 후보를 청취 목록에 둔다.

`train_voice.py prepare`는 accepted 클립만으로 참조·전사·분할·해시를 묶은
`training-plan.json`을 만든다. 참조는 클립 ID로 고르며 `originalClipNumber`가 없어도 된다.
분할을 직접 정하려면 `--split-map`에 `{"train":["클립 ID"],"val":["클립 ID"],"test":["클립 ID"]}`
형식의 파일을 전달한다. 모든 승인 클립을 한 번씩 배정하고 같은 음성을 보류·학습에 중복시키지 않는다.
기존 계획 갱신은 `--replace-plan`을 명시해야 한다.

`train_voice.py compare`는 계획의 해시를 확인한 뒤 그 계획의 스텝 수로 후보 어댑터를 만든다.
같은 모델·참조·입력한 새 대본으로 어댑터 없는 복제와 학습 후보를 독립 판독·보류 원본의 화자
코사인으로 비교한다. 참조와 같은 음성은 보류 평가에서 제외한다. 기본 비교는 기존 10·20스텝,
강도 0.60, 제작의 4후보 검수 정책이며 `config/voice-training.json`과 CLI 옵션에서 읽는다.
참조 WAV·전사·학습 JSONL은 새 실행 폴더에 복사해 고정한다. 후보 어댑터 중 자동 검사·
코사인 순으로 고른 하나만 입력한 표시 이름의 프로필로 표시하며, 제작 기본값을 바꾸거나 청취 승인을
자동 기록하지 않는다. 기본 복제가 더 좋은지도 결과의 `baselineRanksBetter`에 남긴다.
요약 위치는 데이터 폴더의 `latest-training-result.json`이다. 실패한 실행을 덮어쓰지 않고
매번 새 결과 이름을 사용한다.

새 사람의 준비 예시다. 경로·클립 ID·평가 대본은 해당 사람의 입력으로 지정한다.

```bash
PYTHONPATH=src .venv-train/bin/python -m local_tts_engine.finetune_dataset segment \
  --source-dir <모노 WAV 원본 폴더> --reference <같은 사람의 참조.wav> \
  --output-dir artifacts/finetune-datasets/speaker-ko-v1 --display-name "목소리 이름"
.venv-train/bin/python scripts/analyze_voice.py \
  --dataset-dir artifacts/finetune-datasets/speaker-ko-v1
# 클립을 듣고 review.tsv의 실제 전사와 accepted/rejected를 작성한 뒤 반영
PYTHONPATH=src .venv-train/bin/python -m local_tts_engine.finetune_dataset apply-review \
  --dataset-dir artifacts/finetune-datasets/speaker-ko-v1
.venv-train/bin/python scripts/train_voice.py prepare \
  --dataset-dir artifacts/finetune-datasets/speaker-ko-v1 --reference-clip <승인된 클립 ID>
.venv-train/bin/python scripts/train_voice.py compare \
  --dataset-dir artifacts/finetune-datasets/speaker-ko-v1 \
  --voice-id speaker-ko --display-name "목소리 이름" --evaluation-text <새 평가 대본.txt> \
  --review-root output/reviews --run-root artifacts/finetune-runs
```

설정 파일 교체는 `--config <설정.json>`, 학습값 조정은 `compare --help`를 따른다.
기존 `analyze_kkh_voice.py`·`train_kkh_voice.py` 경로는 저장된 명령의 호환 진입점으로만 유지한다.
두 파일도 공용 모듈을 호출하며 새 명령과 동일한 인자를 요구한다. 사람별 경로·대본은 담지 않는다.
검사도 `test_finetune_analysis.py`·`test_finetune_comparison.py`에서 공용 모듈을 직접 검증한다.

일상 검사는 `npm run check`를 사용한다. `check:capture`는 실제 브라우저로 3초짜리
화면을 세 화질로 찍어 프레임 수·전환 시각·출력 규격을 확인하며, 촬영 코드나 브라우저
판본을 건드린 뒤에만 돌린다. 모델 합성·과거 영상 수정 도구는 자동 점검의 일부가 아니다. 필요 시 각 명령의 `--help`와 계획 파일을 확인하고
승인된 입력·최신 수정본·새 출력 경로를 사용한다. 일회성 계획·음성·로그는
`output/reviews/` 또는 `artifacts/`에 저장하며 새 도구로 복제해 쌓지 않는다.

`audit_speech_corpus.py --output <새 보고서.json> --replay-text --baseline-ref HEAD`는
현재 전체 대본과 중복을 제외한 저장 판독을 점검하고, 같은 사전·전사로 변경 전후
코드 판정을 비교한다.
`validate_prosody_live.py --samples-file <표본.json> --prepare-only`로 실제 챕터에서
고정한 1~16개 `{name, text}` 표본을 준비하고, Metal이 가능한 제작 환경에서
`--prepare-only`를 빼면 기존 제작 목소리·4후보 정책으로 새 음성을 검증한다.
두 도구의 `--source-project`는 덱 위치를 명시하며 기본 연결을 따른다.
`validate_prosody_live.py --review-existing <완료된 검증 폴더>`는 선택된 기존 WAV를
다시 합성하지 않고 실제 언어 구간별 새 받아쓰기·운율 검수로 확인한다. 원본 WAV와
manifest는 보존하고 새 `review-*.json`에 결과를 쓴다. 인위적 끊김 실험은 기본 2표본에만 있다.
검증 폴더의 `listening-review.json`에 정확한 녹음·발음문·경고를 대조할 청취 기록이 있으면,
그 단일 오탐 뒤의 운율을 별도로 검사한다. `passed`를 덮지 않고 `prosodyAfterListening`에
쓰므로 원래 자동 판정과 구분한다. 짧은 낱말의 실험적 단서는
`shortWordReviewCandidates`로만 보관하며 자동 재시도에 적용하지 않는다.

학습 데이터는 `artifacts/finetune-datasets/jaeho-ko-v1/`에 준비돼 있다. 다시 준비할 때는 새 출력 폴더에서
`segment → transcribe → reconcile-script → spot-check/apply-review → validate → export`
순으로 실행한다. 원본 `data/private/voice/training/pvc/master-wav/`는 읽기 전용이다.
각 하위 명령의 `--help`가 옵션의 기준이다. ASR 초안은 자동 승인하지 않으며
`review.tsv`에서 accepted인 클립만 공식 JSONL로 내보낸다. 승인·학습 근거는
[DECISIONS](../docs/DECISIONS.md)에 있다.
