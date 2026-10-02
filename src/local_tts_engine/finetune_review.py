"""Read-only waveform checks and independent transcript agreement for training.

Agreement measures two automatic readings, never speaker identity or a known
correct transcript. Analysis writes only a hash-bound report beside the dataset.
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from .finetune_dataset import comparison_text, dbfs, read_jsonl, sha256_file, write_json


def transcript_hash(text: str) -> str:
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def transcript_agreement(first: str, second: str) -> float | None:
    a, b = comparison_text(first), comparison_text(second)
    if not a or not b:
        return None
    return round(difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), 4)


def audio_measurements(audio: np.ndarray, rate: int) -> dict:
    values = np.asarray(audio, dtype=np.float64)
    if values.ndim == 2:
        values = np.mean(values, axis=1)
    if values.size == 0 or not np.all(np.isfinite(values)):
        raise ValueError('음성 신호가 비어 있거나 올바르지 않습니다.')
    frame_samples = max(1, round(rate * 0.02))
    starts = np.arange(0, len(values), frame_samples)
    lengths = np.minimum(frame_samples, len(values) - starts)
    rms = np.sqrt(np.add.reduceat(np.square(values), starts) / lengths)
    quiet = rms <= 10 ** (-45 / 20)
    voiced = np.flatnonzero(~quiet)
    leading = int(starts[voiced[0]]) if voiced.size else len(values)
    trailing = len(values) - min(len(values), int(starts[voiced[-1]] + lengths[voiced[-1]])) if voiced.size else len(values)
    clipped = float(np.mean(np.abs(values) >= 0.999))
    warnings = []
    if clipped >= 0.001:
        warnings.append({'code': 'clipping', 'message': '음량 한계에 닿은 신호가 있습니다. 찌그러짐을 들어 보세요.'})
    rms_db = dbfs(values)
    if rms_db < -40:
        warnings.append({'code': 'quiet-recording', 'message': '전체 음량이 작습니다. 목소리가 또렷하게 들리는지 확인하세요.'})
    quiet_ratio = float(np.sum(lengths[quiet]) / len(values))
    if quiet_ratio > 0.35 or max(leading, trailing) / rate > 1.2:
        warnings.append({'code': 'long-silence', 'message': '조용한 구간이 깁니다. 말 없는 구간이 많은지 확인하세요.'})
    return {'rmsDbfs': round(rms_db, 2), 'peakDbfs': round(dbfs(np.array([np.max(np.abs(values))])), 2),
        'clippingRatio': round(clipped, 5), 'quietRatio': round(quiet_ratio, 4),
        'leadingQuietMs': round(leading * 1000 / rate), 'trailingQuietMs': round(trailing * 1000 / rate),
        'quietThresholdDbfs': -45, 'warnings': warnings}


def review_dataset(dataset_dir: Path, *, comparison_model: Path | None = None,
                   reader: Callable[[str], str] | None = None) -> dict:
    rows = read_jsonl(dataset_dir / 'metadata.jsonl')
    manifest = json.loads((dataset_dir / 'manifest.json').read_text(encoding='utf-8'))
    report_path = dataset_dir / 'quality-review.json'
    try:
        previous = json.loads(report_path.read_text(encoding='utf-8'))
    except (FileNotFoundError, ValueError):
        previous = {}
    previous_clips = {item['id']: item for item in previous.get('clips', [])}
    report = {'schemaVersion': 1, 'kind': 'training-waveform-and-asr-agreement-v1',
        'speakerSimilarity': 'not-measured', 'clips': []}
    last_by_source = {}
    for row in rows:
        source = row.get('sourceAudio', '')
        last_by_source[source] = max(last_by_source.get(source, 0), row.get('endMs', 0))
    for row in rows:
        audio_path = Path(row['audio'])
        digest = sha256_file(audio_path)
        audio, rate = sf.read(audio_path, dtype='float32', always_2d=False)
        metrics = audio_measurements(audio, rate)
        warnings = metrics['warnings']
        if 'hard-cut' in row.get('splitMethod', ''):
            warnings.append({'code': 'cut-boundary', 'message': '말 중간에 잘렸을 수 있습니다. 시작과 말끝을 확인하세요.'})
        if manifest.get('originalSource', {}).get('decodeNote') and row.get('endMs') == last_by_source.get(row.get('sourceAudio', '')):
            warnings.append({'code': 'source-decode-tail', 'message': '원본 마지막 패킷에 읽기 경고가 있었습니다. 말끝이 잘렸는지 확인하세요.'})
        source_text = row.get('asrText') or row.get('text') or ''
        prior = previous_clips.get(row['id'], {})
        independent = prior.get('independentText') if prior.get('audioSha256') == digest else None
        independent_model = prior.get('independentModel') if independent is not None else None
        if comparison_model is not None and source_text:
            if reader is None:
                from mlx_audio.stt.utils import load_model
                model = load_model(str(comparison_model))
                reader = lambda file: model.generate(file, language='ko', task='transcribe', temperature=0.0,
                    return_timestamps=False, condition_on_previous_text=False, max_tokens=768).text
            independent = reader(str(audio_path)).strip()
            independent_model = str(comparison_model)
            print(f"[independent ASR] {row['id']}: {independent}", flush=True)
        item = {'id': row['id'], 'audioSha256': digest, 'sourceTranscriptSha256': transcript_hash(source_text),
            'audio': metrics, 'sourceText': source_text, 'independentText': independent,
            'independentModel': independent_model, 'transcriptAgreement': transcript_agreement(source_text, independent or '')}
        report['clips'].append(item)
        write_json(report_path, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset-dir', type=Path, required=True)
    parser.add_argument('--comparison-model', type=Path)
    args = parser.parse_args()
    if args.comparison_model is not None and not args.comparison_model.is_dir():
        raise FileNotFoundError('독립 받아쓰기 모델의 로컬 경로가 없습니다.')
    report = review_dataset(args.dataset_dir, comparison_model=args.comparison_model)
    print(json.dumps({'clips': len(report['clips']), 'independentlyRead': sum(item['independentText'] is not None for item in report['clips'])}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
