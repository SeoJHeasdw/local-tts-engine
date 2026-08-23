from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_durable_handoff_files_exist() -> None:
    required = [
        PROJECT_ROOT / "AGENTS.md",
        PROJECT_ROOT / "docs/HANDOFF.md",
        PROJECT_ROOT / "docs/ARCHITECTURE.md",
        PROJECT_ROOT / "docs/BENCHMARK-PLAN.md",
        PROJECT_ROOT / "config/project.toml",
    ]
    assert all(path.is_file() for path in required)
