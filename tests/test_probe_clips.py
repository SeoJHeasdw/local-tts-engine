"""The probe's clip names must survive a case-insensitive file system.

Two spellings that differ only in case are the normal question this probe
answers (RICE vs Rice). On macOS they name the same file, so without distinct
names the clips left behind belong to whichever trial ran last and anyone
listening to them afterwards draws the wrong conclusion.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path


def _probe():
    path = Path(__file__).resolve().parents[1] / "scripts" / "probe_term_pronunciation.py"
    spec = importlib.util.spec_from_file_location("probe_term_pronunciation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_case_only_spellings_get_separate_clips():
    probe = _probe()
    first = probe.clip_name(1, "rice", 1, "RICE", 0)
    second = probe.clip_name(1, "rice", 2, "Rice", 0)
    assert first != second
    assert first.lower() != second.lower()


def test_cases_differing_only_in_case_stay_apart():
    probe = _probe()
    first = probe.clip_name(1, "RICE", 1, "표기", 0)
    second = probe.clip_name(2, "rice", 1, "표기", 0)
    assert first.lower() != second.lower()


def test_name_keeps_the_spelling_readable():
    probe = _probe()
    assert probe.clip_name(3, "런타임", 2, "런 타임", 1) == "03-런타임--02-런_타임--1.wav"
