from local_tts_engine.export_udemy import timeline_from_course_manifest


def test_timeline_from_course_manifest_preserves_actual_timing() -> None:
    manifest = {
        "schemaVersion": 1,
        "durationMs": 5000,
        "timing": {"startPadMs": 900},
        "entries": [
            {
                "chapter": "ch00",
                "slide_id": "slide-a",
                "slide_number": 1,
                "step": 0,
                "source_text": "원문",
                "tts_text": "원문",
                "hash": "abc",
                "durationMs": 2000,
                "startMs": 900,
                "endMs": 2900,
                "transitionAtMs": 2800,
                "speechStartMs": 960,
                "speechEndMs": 2750,
                "alignment": {
                    "words": [{"text": "원문", "startMs": 960, "endMs": 2750}]
                },
            },
            {
                "chapter": "ch00",
                "slide_id": "slide-b",
                "slide_number": 2,
                "step": 0,
                "source_text": "다음",
                "tts_text": "다음",
                "hash": "def",
                "durationMs": 1500,
                "startMs": 3500,
                "endMs": 5000,
            },
        ],
    }

    timeline = timeline_from_course_manifest(
        manifest,
        {"name": "pilot"},
        {"provider": "qwen3-local"},
    )

    assert timeline["entries"][0]["gapAfterMs"] == 600
    assert timeline["entries"][1]["gapAfterMs"] == 0
    assert timeline["entries"][1]["slideNumber"] == 2
    assert timeline["entries"][0]["transitionAtMs"] == 2800
    assert timeline["entries"][0]["speechStartMs"] == 960
    assert timeline["entries"][0]["alignment"]["words"][0]["text"] == "원문"
    assert timeline["totalMs"] == 5000
