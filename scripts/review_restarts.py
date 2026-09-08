#!/usr/bin/env python3.13
"""Replay the restart gate on stored audio and independent timing evidence.

No models are loaded, no audio is changed. Missing independent alignment is
reported as unavailable, never counted as a clean verification.
"""
import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from local_tts_engine.restarts import RESTART_POLICY, acoustic_restarts, confirm_restarts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tts-root', type=Path, default=Path('output/tts'))
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    seen, rows = set(), []
    for path in sorted(args.tts_root.rglob('manifest.json')):
        manifest = json.loads(path.read_text())
        timings = {c['key']:c for c in manifest.get('chunks', [])}
        for chunk in manifest.get('quality', {}).get('chunks', []):
            selected = chunk.get('selected', {})
            audio = selected.get('audioPath')
            if not audio or audio in seen or not Path(audio).is_file():
                continue
            seen.add(audio)
            candidates = acoustic_restarts(Path(audio))
            words = selected.get('prosody', {}).get('confirmationWords', [])
            offset = timings.get(chunk['chunkKey'], {}).get('startMs', 0)
            evidence = 'review-alignment' if words else None
            if candidates and not words:
                # Final subtitle words use track time. Single-chunk entries can
                # be shifted back to the exact native clip's time coordinates.
                entries = [e for e in manifest.get('entries', []) if e.get('chunkKey') == chunk['chunkKey']]
                if entries and all(len(e.get('chunkKeys', [chunk['chunkKey']])) == 1 for e in entries):
                    words = [{**w, 'startMs':w['startMs']-offset, 'endMs':w['endMs']-offset}
                             for e in entries for w in e.get('alignment', {}).get('words', [])]
                    evidence = 'final-alignment' if words else None
            checks = confirm_restarts(candidates, words, selected.get('expectedText', ''))
            rows.append({'manifest':str(path), 'chunk':chunk['chunkKey'], 'candidates':candidates,
                         'alignmentEvidence':evidence, 'status':'alignment-unavailable' if candidates and not words else 'checked',
                         'contentPassed':not selected.get('failures') and not selected.get('warnings'),
                         'checks':[{**c,'videoStartMs':offset+c['startMs'],'videoEndMs':offset+c['endMs']} for c in checks]})
    report = {'policy':RESTART_POLICY,'clips':len(rows),'seconds':round(time.monotonic()-started,3),
              'flaggedClips':sum(bool(r['checks']) for r in rows),
              'alignmentUnavailable':sum(r['status']=='alignment-unavailable' for r in rows),'results':rows}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k!='results'},ensure_ascii=False))


if __name__ == '__main__':
    main()
