import numpy as np
import pytest

from local_tts_engine import finetune_analysis as module


def test_speaker_cosine_normalizes_vectors_and_omits_self_comparison() -> None:
    matrix, peers, threshold = module.speaker_consistency([[2, 0], [4, 0], [0, 3]])
    np.testing.assert_allclose(matrix, [[1, 1, 0], [1, 1, 0], [0, 0, 1]])
    np.testing.assert_allclose(peers, [0.5, 0.5, 0])
    assert threshold == pytest.approx(0.45)
    assert peers[2] < threshold


@pytest.mark.parametrize('vectors', [[[1, 0]], [[0, 0], [1, 0]], [[float('nan'), 0], [1, 0]]])
def test_invalid_embeddings_cannot_be_reported_as_similarity(vectors) -> None:
    with pytest.raises(ValueError):
        module.speaker_consistency(vectors)
