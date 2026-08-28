"""Print the deck's canonical page, step, and lesson catalog as JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .course_pilot import (
    DEFAULT_SOURCE_PROJECT,
    course_lesson_catalog,
    course_page_catalog,
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-project", type=Path, default=DEFAULT_SOURCE_PROJECT)
    args = parser.parse_args(argv)
    pages = course_page_catalog(args.source_project)
    lessons = course_lesson_catalog(args.source_project / "deck", pages)
    print(json.dumps(
        {"totalPages": len(pages), "pages": pages, "lessons": lessons},
        ensure_ascii=False,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
