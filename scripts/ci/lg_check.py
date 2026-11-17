#!/usr/bin/env python3
"""`make lg-check`: a shrink-only count of page-level `lg:` classes (#1066).

Counts every variant that applies at or above lg (`lg:`, `xl:`, `2xl:`, their `min-` forms and
`min-[<n>rem|px]:` from 64rem / 1024px; the `max-*` forms never) in the .ts/.tsx files under `src`
(spec files aside) that scripts/ci/lg_count.conf does not exempt, per file. A file fails when its count is above its
`known` line, or has none; a count below its line passes but says to lower the number in the same
PR. Stdlib only, so it runs before npm ci, like layer-check.

`--staged` (the pre-commit hook, `make lg-check-staged`) reads the conf, the file list and every
file from the index, so it judges exactly what is about to be committed.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONF = ROOT / "scripts/ci/lg_count.conf"
# The one place that says what counts. A variant at or above Tailwind v4's lg breakpoint (64rem,
# 1024px at the default 16px root), also stacked (`hover:lg:`). The lookbehind refuses `max-lg:`
# and any longer name; `min-[<n>rem|px]:` is checked against the breakpoint in `at_or_above_lg`.
LG_VARIANT = re.compile(
    r"(?<![A-Za-z0-9_-])(?:(?:min-)?(?:lg|xl|2xl):|min-\[(?P<n>\d+(?:\.\d+)?)(?P<unit>rem|px)\]:)"
)
LG_REM = 64


def at_or_above_lg(match: re.Match[str]) -> bool:
    n = match["n"]
    if n is None:
        return True
    return float(n) >= (LG_REM if match["unit"] == "rem" else LG_REM * 16)


def count_lg(text: str) -> int:
    return sum(1 for m in LG_VARIANT.finditer(text) if at_or_above_lg(m))


def git_out(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def read_conf(text: str) -> tuple[str, list[str], dict[str, int]]:
    src, exempt, known = "src/web", [], {}
    for number, raw in enumerate(text.splitlines(), 1):
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


def is_exempt(rel: str, exempt: list[str]) -> bool:
    return any(rel == e or (e.endswith("/") and rel.startswith(e)) for e in exempt)


def counted(rel: str, exempt: list[str]) -> bool:
    name = rel.rsplit("/", 1)[-1]
    return rel.endswith((".ts", ".tsx")) and ".spec." not in name and not is_exempt(rel, exempt)


def counts(src: str, exempt: list[str], staged: bool) -> dict[str, int]:
    if staged:
        paths = git_out("ls-files", "-z", "--", src).split("\0")
    else:
        paths = [p.relative_to(ROOT).as_posix() for p in sorted((ROOT / src).rglob("*.ts*"))]
    found: dict[str, int] = {}
    for rel in sorted(p for p in paths if p and counted(p, exempt)):
        text = git_out("show", f":{rel}") if staged else (ROOT / rel).read_text()
        n = count_lg(text)
        if n:
            found[rel] = n
    return found


def main() -> int:
    staged = "--staged" in sys.argv[1:]
    conf = git_out("show", f":{CONF.relative_to(ROOT)}") if staged else CONF.read_text()
    src, exempt, known = read_conf(conf)
    found = counts(src, exempt, staged)
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
