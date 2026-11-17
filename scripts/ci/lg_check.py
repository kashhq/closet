#!/usr/bin/env python3
"""`make lg-check`: a shrink-only count of page-level `lg:` classes (#1066).

Counts every `lg:` variant in the .ts/.tsx files under `src` (spec files aside) that
scripts/ci/lg_count.conf does not exempt, per file. A file fails when its count is above its
`known` line, or has none; a count below its line passes but says to lower the number in the same
PR. Stdlib only, so it runs before npm ci, like layer-check.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONF = ROOT / "scripts/ci/lg_count.conf"
# `lg:` as a variant, also stacked (`hover:lg:`, `max-lg:` is a different variant and not matched).
LG = re.compile(r"(?<![A-Za-z0-9_-])lg:")


def read_conf() -> tuple[str, list[str], dict[str, int]]:
    src, exempt, known = "src/web", [], {}
    for number, raw in enumerate(CONF.read_text().splitlines(), 1):
        line = raw.split("#", 1)[0].split()
        if not line:
            continue
        if line[0] == "src" and len(line) == 2:
            src = line[1]
        elif line[0] == "exempt" and len(line) == 2:
            exempt.append(line[1])
        elif line[0] == "known" and len(line) == 3 and line[2].isdigit():
            known[line[1]] = int(line[2])
        else:
            sys.exit(f"lg-check: {CONF.name}:{number}: expected src|exempt <path> or known <path> <count>")
    return src, exempt, known


def counts(src: str, exempt: list[str]) -> dict[str, int]:
    found: dict[str, int] = {}
    for path in sorted((ROOT / src).rglob("*.ts*")):
        rel = path.relative_to(ROOT).as_posix()
        if path.suffix not in (".ts", ".tsx") or ".spec." in path.name:
            continue
        if any(rel == e or (e.endswith("/") and rel.startswith(e)) for e in exempt):
            continue
        n = len(LG.findall(path.read_text()))
        if n:
            found[rel] = n
    return found


def main() -> int:
    src, exempt, known = read_conf()
    found = counts(src, exempt)
    failures, lowered = [], []
    for rel, n in found.items():
        allowed = known.get(rel)
        if allowed is None:
            failures.append(f"{rel}: {n} `lg:` and no known line: a page does not add its own; use the layout's pieces (src/web/layout/AGENTS.md)")
        elif n > allowed:
            failures.append(f"{rel}: {n} `lg:`, known {allowed}: the count only shrinks")
        elif n < allowed:
            lowered.append(f"{rel}: {n} `lg:`, known {allowed}: lower it to {n} in {CONF.relative_to(ROOT)} in this PR")
    for rel in known:
        if rel not in found:
            lowered.append(f"{rel}: no `lg:` left, known {known[rel]}: delete its known line in {CONF.relative_to(ROOT)} in this PR")
    print(f"lg-check files={len(found)} total={sum(found.values())} known={sum(known.values())}")
    for line in failures + lowered:
        print(f"lg-check: {line}", file=sys.stderr)
    return 1 if failures or lowered else 0


if __name__ == "__main__":
    sys.exit(main())
