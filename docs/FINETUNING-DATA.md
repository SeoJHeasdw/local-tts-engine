# Qwen3-TTS 파인튜닝 데이터 준비

이 문서는 **학습 전 데이터 준비까지만** 다룬다. 원본 53분 WAV는 읽기 전용이며,
클립·전사·검수표·JSONL은 모두 Git에서 제외되는 `artifacts/` 아래에 만든다.

## 안전 계약

- 정본: `data/private/voice/training/pvc/master-wav/`
- 정본은 수정·이동·재인코딩하지 않는다.
- ASR 전사는 초안이다. 자동으로 학습 승인하지 않는다.
- `review.tsv`에서 사람이 `accepted`로 표시한 클립만 내보낸다.
- 실제 학습과 체크포인트 생성은 별도 결정 전까지 실행하지 않는다.

## 1. 문장 클립 준비

먼저 일부만 확인한다.

```bash
.venv/bin/python -m local_tts_engine.finetune_dataset segment \
  --source-pattern '01-ch00.wav' \
  --max-source-seconds 60 \
  --output-dir artifacts/finetune-datasets/smoke-v1
```

전체 53분 데이터셋은 새 출력 디렉터리에서 실행한다.

```bash
.venv/bin/python -m local_tts_engine.finetune_dataset segment \
  --output-dir artifacts/finetune-datasets/jaeho-ko-v1
```

기본 분할은 3~14초, 목표 8초다. 240ms 이상 무음의 가운데를 경계로 쓴다.
적절한 무음이 없어 강제로 자른 클립은 `hard-cut-review`로 표시된다.

## 2. ASR 초벌 전사

캐시된 Qwen3-ASR 0.6B 8-bit를 사용한다. 첫 5개만 시험하려면:

```bash
.venv/bin/python -m local_tts_engine.finetune_dataset transcribe \
  --dataset-dir artifacts/finetune-datasets/smoke-v1 \
  --limit 5
```

`review.tsv`의 `text`는 초벌 전사이며 `status`는 항상 `pending`이다.

녹음 당시 Git 대본을 클립별로 자동 배치한다.

```bash
.venv/bin/python -m local_tts_engine.finetune_dataset reconcile-script \
  --dataset-dir artifacts/finetune-datasets/jaeho-ko-v1
```

`recommendation=spot-check`은 ASR과 당시 대본이 높은 비율로 일치한 항목이고,
`listen`은 반복 발화·추가 설명·경계 불일치 가능성이 있어 들어봐야 하는 항목이다.
어느 쪽도 자동으로 `accepted` 처리하지 않는다.

대표 음성 10개만 확인하는 로컬 페이지를 만든다.

```bash
.venv/bin/python -m local_tts_engine.finetune_dataset spot-check \
  --dataset-dir artifacts/finetune-datasets/jaeho-ko-v1
```

`spot-check/index.html`에서 음성과 표시 문장이 같은지만 확인한다.

대표 청취 결과는 결정 JSON으로 반영할 수 있다. `--auto-accept-exact`는 ASR과
녹음 당시 대본이 글자 단위로 완전히 같은 항목만 추가 승인한다.

```bash
.venv/bin/python -m local_tts_engine.finetune_dataset apply-decisions \
  --dataset-dir artifacts/finetune-datasets/jaeho-ko-v1 \
  --decisions artifacts/finetune-datasets/jaeho-ko-v1/spot-check/decisions.json \
  --auto-accept-exact
```

## 3. 사람 검수

`review.tsv`를 스프레드시트에서 UTF-8 TSV로 연다.

- `text`: 실제 음성과 글자 단위로 맞게 교정
- `status`: `accepted`, `rejected`, `pending` 중 하나
- `notes`: 잡음, 잘린 단어, 잘못된 호흡 등 메모

편집 후 반영한다.

```bash
.venv/bin/python -m local_tts_engine.finetune_dataset apply-review \
  --dataset-dir artifacts/finetune-datasets/jaeho-ko-v1
```

## 4. 검증과 공식 JSONL 내보내기

```bash
.venv/bin/python -m local_tts_engine.finetune_dataset validate \
  --dataset-dir artifacts/finetune-datasets/jaeho-ko-v1

.venv/bin/python -m local_tts_engine.finetune_dataset export \
  --dataset-dir artifacts/finetune-datasets/jaeho-ko-v1
```

`official/` 아래에 Qwen 공식 형식의 `train_raw.jsonl`, `val_raw.jsonl`,
`test_raw.jsonl`이 생긴다. 각 행은 `audio`, `text`, `ref_audio`만 포함한다.
검수 승인 항목이 하나도 없으면 내보내기는 실패한다.
