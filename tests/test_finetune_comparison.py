from pathlib import Path
import hashlib
import json
import sys
from types import ModuleType, SimpleNamespace
import pytest

from local_tts_engine import finetune_comparison as module


def test_candidate_prefers_clear_speech_over_higher_voice_cosine() -> None:
    clear = {'qualityStatus': 'passed', 'contentScore': 0.1, 'speakerCosine': 0.8, 'steps': 10}
    unclear = {'qualityStatus': 'warning', 'contentScore': 0.0, 'speakerCosine': 0.99, 'steps': 20}
    assert module.ranking(clear) < module.ranking(unclear)


def test_matching_content_uses_voice_cosine_and_ties_prefer_less_training() -> None:
    a = {'qualityStatus': 'passed', 'contentScore': 0.0, 'speakerCosine': 0.85, 'steps': 10}
    b = {**a, 'speakerCosine': 0.9, 'steps': 20}
    assert module.ranking(b) < module.ranking(a)
    assert module.ranking(a) < module.ranking({**a, 'steps': 20})


def test_training_plan_binds_splits_and_reference_and_rejects_holdout_leak(tmp_path: Path) -> None:
    def hash_file(file):
        return hashlib.sha256(file.read_bytes()).hexdigest()
    official = tmp_path / 'official'
    official.mkdir()
    rows = []
    for index in range(3):
        audio = tmp_path / f'{index}.wav'
        audio.write_text(f'audio {index}')
        rows.append({'audio': str(audio), 'audioSha256': hash_file(audio), 'text': f'text {index}', 'originalClipNumber': index})
    (tmp_path / 'metadata.jsonl').write_text('\n'.join(json.dumps(row) for row in rows))
    (tmp_path / 'manifest.json').write_text('{}')
    for name, row in zip(('train', 'val', 'test'), rows):
        (official / f'{name}_raw.jsonl').write_text(json.dumps(row))
    reference = tmp_path / 'reference.wav'
    reference.write_bytes((tmp_path / '0.wav').read_bytes())
    text = tmp_path / 'reference.txt'
    text.write_text('text 0\n')
    plan = {'trainJsonl': str(official / 'train_raw.jsonl'), 'datasetManifestSha256': hash_file(tmp_path / 'manifest.json'),
        'metadataSha256': hash_file(tmp_path / 'metadata.jsonl'), 'referenceAudio': str(reference),
        'referenceAudioSha256': hash_file(reference), 'referenceText': str(text), 'referenceTextSha256': hash_file(text),
        'referenceOriginalClipNumber': 0,
        'splitJsonlSha256': {name: hash_file(official / f'{name}_raw.jsonl') for name in ('train', 'val', 'test')}}
    assert len(module.verify_plan(plan, tmp_path)['train']) == 1
    (official / 'val_raw.jsonl').write_text(json.dumps(rows[0]))
    with pytest.raises(ValueError, match='검수 준비 당시'):
        module.verify_plan(plan, tmp_path)
    plan['splitJsonlSha256']['val'] = hash_file(official / 'val_raw.jsonl')
    with pytest.raises(ValueError, match='겹치거나'):
        module.verify_plan(plan, tmp_path)


@pytest.fixture
def reviewed_dataset(tmp_path: Path) -> tuple[Path, list[dict]]:
    dataset = tmp_path / 'speaker-dataset'
    dataset.mkdir()
    rows = []
    for index, status in enumerate(('accepted', 'accepted', 'accepted', 'pending', 'rejected')):
        audio = dataset / f'clip-{index}.wav'
        audio.write_bytes(f'fixture audio {index}'.encode())
        rows.append({'id': f'clip-{index}', 'audio': str(audio), 'audioSha256': module.sha256_file(audio),
            'text': f'승인 전사 {index}', 'durationMs': 7000, 'reviewStatus': status})
    module.write_jsonl(dataset / 'metadata.jsonl', rows)
    module.write_json(dataset / 'manifest.json', {'schemaVersion': 1, 'sources': []})
    return dataset, rows


def prepare_plan(dataset: Path, **overrides) -> dict:
    options = {'reference_clip_id': 'clip-1', 'steps': [10, 20], 'scale': 0.6,
        'split_map': {'train': ['clip-0'], 'val': ['clip-1'], 'test': ['clip-2']}}
    options.update(overrides)
    return module.prepare_training_plan(dataset, **options)


def test_plan_preparation_supports_generic_clip_ids_and_preserves_pending_rejected_audio(reviewed_dataset) -> None:
    dataset, rows = reviewed_dataset
    original_hashes = {row['audio']: row['audioSha256'] for row in rows}
    metadata_hash = module.sha256_file(dataset / 'metadata.jsonl')

    plan = prepare_plan(dataset)

    assert plan['referenceClipId'] == 'clip-1'
    assert 'referenceOriginalClipNumber' not in plan
    assert Path(plan['referenceText']).read_text().strip() == rows[1]['text']
    manifest = json.loads((dataset / 'manifest.json').read_text())
    assert manifest['referenceAudio'] == rows[1]['audio']
    assert manifest['referenceClipId'] == 'clip-1'
    assert module.sha256_file(dataset / 'manifest.json') == plan['datasetManifestSha256']
    assert plan['excludedClipIds'] == ['clip-3', 'clip-4']
    assert plan['referenceListeningApproval'] == 'not-performed'
    assert module.sha256_file(dataset / 'metadata.jsonl') == metadata_hash
    assert all(module.sha256_file(Path(audio)) == digest for audio, digest in original_hashes.items())
    splits = module.verify_plan(plan, dataset)
    assert [row['audio'] for row in module.heldout_rows(splits, plan['referenceAudioSha256'])] == [rows[2]['audio']]
    assert all(row['ref_audio'] == rows[1]['audio'] for split in splits.values() for row in split)
    with pytest.raises(FileExistsError, match='이미'):
        prepare_plan(dataset)


@pytest.mark.parametrize('mapping', [
    {'train': ['clip-0', 'clip-1'], 'val': ['clip-1'], 'test': ['clip-2']},
    {'train': ['clip-0'], 'val': [], 'test': ['clip-2']},
    {'train': ['clip-0'], 'val': ['clip-3'], 'test': ['clip-2']},
])
def test_plan_preparation_rejects_overlap_missing_approved_or_pending_clip(reviewed_dataset, mapping) -> None:
    dataset, _rows = reviewed_dataset
    with pytest.raises(ValueError, match='빠짐없이'):
        prepare_plan(dataset, split_map=mapping)
    assert not (dataset / 'training-plan.json').exists()
    assert not (dataset / 'official').exists()


def test_plan_refuses_pending_reference_and_reference_only_holdout(reviewed_dataset) -> None:
    dataset, _rows = reviewed_dataset
    with pytest.raises(ValueError, match='참조 클립'):
        prepare_plan(dataset, reference_clip_id='clip-3')
    with pytest.raises(ValueError, match='보류 원본'):
        prepare_plan(dataset, split_map={'train': ['clip-0', 'clip-2'], 'val': ['clip-1'], 'test': []})
    assert not (dataset / 'official').exists()


def test_plan_rejects_zero_adapter_scale_before_training_or_output(reviewed_dataset) -> None:
    dataset, _rows = reviewed_dataset
    with pytest.raises(ValueError, match='강도'):
        prepare_plan(dataset, scale=0)
    assert not (dataset / 'training-plan.json').exists()
    assert not (dataset / 'official').exists()


def test_verify_plan_rejects_duplicated_audio_in_distinct_split_paths(reviewed_dataset) -> None:
    dataset, rows = reviewed_dataset
    plan = prepare_plan(dataset)
    Path(rows[2]['audio']).write_bytes(Path(rows[0]['audio']).read_bytes())
    rows[2]['audioSha256'] = rows[0]['audioSha256']
    module.write_jsonl(dataset / 'metadata.jsonl', rows)
    plan['metadataSha256'] = module.sha256_file(dataset / 'metadata.jsonl')
    with pytest.raises(ValueError, match='겹치거나'):
        module.verify_plan(plan, dataset)


def test_shared_configuration_keeps_previous_comparison_defaults_and_accepts_cli_overrides(tmp_path: Path) -> None:
    config = module.load_config()
    argv = ['compare', '--dataset-dir', str(tmp_path), '--display-name', '새 목소리', '--voice-id', 'new-speaker',
        '--evaluation-text', str(tmp_path / 'text.txt'), '--review-root', str(tmp_path / 'reviews'),
        '--run-root', str(tmp_path / 'runs')]
    args = module.build_parser(config).parse_args(argv)
    assert args.model == 'mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16'
    assert (args.rank, args.alpha, args.warmup_steps, args.seed, args.quality_attempts) == (16, 16, 2, 20261001, 4)
    overridden = module.build_parser(config).parse_args(argv + ['--rank', '32', '--seed', '17', '--warmup-steps', '3'])
    assert (overridden.rank, overridden.seed, overridden.warmup_steps) == (32, 17, 3)
    train = module.training_arguments(overridden, model_path=tmp_path / 'model', output=tmp_path / 'run',
        train_jsonl=tmp_path / 'train.jsonl', steps=10)
    assert (train.rank, train.seed, train.warmup_steps, train.model) == (32, 17, 3, str(tmp_path / 'model'))


def test_comparison_uses_selected_name_reference_and_same_model_without_gpu(
    reviewed_dataset, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import numpy as np
    import local_tts_engine.finetune_mlx as training
    import local_tts_engine.text_candidate as candidate

    dataset, rows = reviewed_dataset
    plan = prepare_plan(dataset, steps=[3, 5])
    text = tmp_path / 'fresh-evaluation.txt'
    text.write_text('새 목소리의 비교 대본입니다.\n', encoding='utf-8')
    model_path = tmp_path / 'installed-base'
    model_path.mkdir()
    training_calls = []
    candidate_calls = []

    def train(args):
        training_calls.append(args)
        (args.output_dir / 'adapters').mkdir()
        return {'metrics': {'trainLoss': 0.5}}

    def generate(**kwargs):
        candidate_calls.append(kwargs)
        kwargs['output_path'].write_bytes(f"generated {len(candidate_calls)}".encode())
        metadata = {'audioSha256': module.sha256_file(kwargs['output_path']),
            'qualityReview': {'status': 'passed', 'findings': []}, 'chunks': [{'quality': {'score': 0}}]}
        module.write_json(kwargs['metadata_path'], metadata)
        return metadata

    core = ModuleType('mlx.core')
    core.array = np.asarray
    core.eval = lambda _value: None
    core.clear_cache = lambda: None
    mlx = ModuleType('mlx')
    mlx.core = core
    audio_utils = ModuleType('mlx_audio.utils')
    audio_utils.load_audio = lambda _path, **_kwargs: np.ones(4)
    tts_utils = ModuleType('mlx_audio.tts.utils')
    model_loads = []

    def load_model(path):
        model_loads.append(path)
        return SimpleNamespace(extract_speaker_embedding=lambda _audio, **_kwargs: np.array([1.0, 2.0]))

    tts_utils.load_model = load_model
    for name, value in {'mlx': mlx, 'mlx.core': core, 'mlx_audio.utils': audio_utils,
        'mlx_audio.tts.utils': tts_utils}.items():
        monkeypatch.setitem(sys.modules, name, value)
    monkeypatch.setattr(training, 'run_training', train)
    monkeypatch.setattr(candidate, 'generate_candidate', generate)
    monkeypatch.setattr(candidate, '_installed_model_path', lambda *_args, **_kwargs: model_path)
    monkeypatch.setattr(module, 'installed_model', lambda _model: model_path)
    args = module.build_parser().parse_args(['compare', '--dataset-dir', str(dataset), '--display-name', '다른 사람',
        '--voice-id', 'speaker-next', '--evaluation-text', str(text), '--review-root', str(tmp_path / 'reviews'),
        '--run-root', str(tmp_path / 'runs')])

    summary = module.run_comparison(args)

    assert summary['voiceId'] == 'speaker-next'
    assert summary['displayName'] == '다른 사람'
    assert summary['selectedAdapterVariant'] == 'lora-3'
    assert [call.max_steps for call in training_calls] == [3, 5]
    assert all(call.model == str(model_path) for call in training_calls)
    assert len(candidate_calls) == 3
    assert all(call['model_path'] == model_path for call in candidate_calls)
    assert all(call['seed'] == args.seed and call['quality_attempts'] == 4 for call in candidate_calls)
    assert model_loads == [str(model_path)]
    comparison = json.loads(Path(summary['comparisonPath']).read_text())
    assert comparison['referenceClipId'] == 'clip-1'
    assert 'referenceOriginalClipNumber' not in comparison
    assert comparison['heldoutAudioPaths'] == [rows[2]['audio']]
    selected_run = Path(summary['adapterPath']).parent
    profile = json.loads((selected_run / 'voice-profile.json').read_text())
    assert profile['displayName'] == '다른 사람'
    assert profile['trainingStatus'] == 'complete'
    assert profile['listeningStatus'] == 'pending'
    assert profile['datasetId'] == dataset.name
    assert profile['modelPath'] == str(model_path)
    assert profile['referenceAudioSha256'] == plan['referenceAudioSha256']
    assert profile['trainJsonlSha256'] == plan['trainJsonlSha256']
    assert profile['training']['rank'] == args.rank
    assert (selected_run / 'reference.wav').read_bytes() == Path(plan['referenceAudio']).read_bytes()
    assert (selected_run / 'preview.wav').is_file()
    assert Path(summary['comparisonPath']).parent.name.startswith('speaker-next-r16-')
