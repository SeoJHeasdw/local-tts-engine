from pathlib import Path
import ast
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_durable_handoff_files_exist() -> None:
    required = [
        PROJECT_ROOT / "AGENTS.md",
        PROJECT_ROOT / "docs/HANDOFF.md",
        PROJECT_ROOT / "docs/ARCHITECTURE.md",
        PROJECT_ROOT / "docs/QUALITY.md",
        PROJECT_ROOT / "config/project.toml",
    ]
    assert all(path.is_file() for path in required)


def test_course_components_do_not_import_the_cli_orchestrator() -> None:
    for source in (PROJECT_ROOT / "src/local_tts_engine/course").glob("*.py"):
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
            if isinstance(node, ast.ImportFrom):
                assert not (node.module or "").endswith("course_pilot"), source.name
            elif isinstance(node, ast.Import):
                assert all(not alias.name.endswith("course_pilot") for alias in node.names), source.name


def test_catalog_import_does_not_load_generation_or_mlx() -> None:
    subprocess.run(
        [sys.executable, "-c", (
            "import sys; from local_tts_engine import course_catalog; "
            "assert 'local_tts_engine.course_pilot' not in sys.modules; "
            "assert 'mlx.core' not in sys.modules"
        )],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
