#!/usr/bin/env python3
"""`make lg-check`: a shrink-only count of page-level `lg:` classes (#1066).

Counts every class token whose variant chain is not entirely on the SAFE_VARIANTS allowlist (so
anything unrecognised, `lg:` and `not-max-lg:` alike, counts) in the .ts/.tsx files under `src`
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
# The one place that says what counts, and it is an allowlist so it fails closed: a class token with
# at least one variant counts unless EVERY variant in its chain is known not to depend on a desktop
# width. Anything unrecognised counts (`lg`, `xl`, `not-max-lg`, `[@media(min-width:64rem)]`, ...).
SAFE_VARIANTS = frozenset({
    "hover", "focus", "focus-visible", "focus-within", "active", "disabled", "open", "dark", "print",
    "placeholder", "first", "last", "odd", "even", "empty", "sm", "md", "min-sm", "min-md",
    "before", "after", "checked", "file", "marker", "selection", "required", "invalid", "enabled",
    "visited", "target", "backdrop", "indeterminate", "read-only", "only", "*", "**",
})
# Colon-joined words that are not classes (a chain starting with one is skipped whole): module
# specifiers, URIs, meta properties, event and job names, htmx modifiers. Uppercase or all-digit elements (`4:5`, `trip:ID`, `HH:MM`) are never variants.
NOT_VARIANTS = frozenset({
    "node", "about", "data", "urn", "og", "twitter", "product", "header", "closet", "htmx", "form", "day",
    "trip", "user", "push", "maintenance", "styling", "snap-strip", "this", "from", "show", "delay",
    "generate",
})
SAFE_PREFIXES = ("group-", "peer-", "has-", "data-", "aria-", "motion-", "max-", "@")  # @ = container query
ELEMENT = r"(?:@?[\w.-]+(?:-?\[[^\]\s]*\])?(?:/[\w-]+)?|\[[^\]\s]*\])"
# A chain of variants ending in a utility (not `key: value`, `https://`, `a ? b : c`).
CHAIN = re.compile(rf"(?<![\w@/\[\]:.-])(?P<chain>(?:{ELEMENT}:)+)(?=[\w!\[@-])")
MIN_ARBITRARY = re.compile(r"min-\[(?P<value>[^\]]*)\]")
LENGTH = re.compile(r"(?P<n>\d*\.?\d+)(?P<unit>rem|em|px)")
LG_PX = 64 * 16


def provably_below_lg(value: str) -> bool:
    m = LENGTH.fullmatch(value)
    if m is None:
        return False
    return float(m["n"]) * (1 if m["unit"] == "px" else 16) < LG_PX


def is_safe(variant: str) -> bool:
    m = MIN_ARBITRARY.fullmatch(variant)
    if m is not None:
        return provably_below_lg(m["value"])
    if variant.isdigit() or "[" not in variant and not variant.islower():
        return True
    return variant in SAFE_VARIANTS or variant.startswith(SAFE_PREFIXES)


def count_lg(text: str) -> int:
    n = 0
    for m in CHAIN.finditer(text):
        variants = re.findall(rf"({ELEMENT}):", m["chain"])
        n += variants[0] not in NOT_VARIANTS and not all(is_safe(v) for v in variants)
    return n


def git_out(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def read_index(paths: list[str]) -> dict[str, str]:
    """Every path's staged blob through one `git cat-file --batch`, not a process per file."""
    request = "".join(f":{p}\n" for p in paths).encode()
    out = subprocess.run(["git", "cat-file", "--batch"], cwd=ROOT, input=request, check=True, capture_output=True).stdout
    blobs: dict[str, str] = {}
    pos = 0
    for path in paths:
        end = out.index(b"\n", pos)
        header = out[pos:end].split()
        if len(header) != 3 or header[1] != b"blob":
            sys.exit(f"lg-check: {path} is not in the index")
        size = int(header[2])
        blobs[path] = out[end + 1 : end + 1 + size].decode()
        pos = end + 1 + size + 1
    return blobs


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


def counts(src: str, exempt: list[str], blobs: dict[str, str] | None) -> dict[str, int]:
    if blobs is None:
        paths = [p.relative_to(ROOT).as_posix() for p in sorted((ROOT / src).rglob("*.ts*"))]
    else:
        paths = list(blobs)
    found: dict[str, int] = {}
    for rel in sorted(p for p in paths if counted(p, exempt)):
        n = count_lg(blobs[rel] if blobs is not None else (ROOT / rel).read_text())
        if n:
            found[rel] = n
    return found


def staged_files(src: str, exempt: list[str]) -> dict[str, str]:
    paths = [p for p in git_out("ls-files", "-z", "--", src).split("\0") if p and counted(p, exempt)]
    return read_index(paths)


def main() -> int:
    staged = "--staged" in sys.argv[1:]
    conf_path = str(CONF.relative_to(ROOT))
    conf = read_index([conf_path])[conf_path] if staged else CONF.read_text()
    src, exempt, known = read_conf(conf)
    found = counts(src, exempt, staged_files(src, exempt) if staged else None)
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
