#!/usr/bin/env python3
"""Unit tests for lg_check.py; run by `make lg-check` (stdlib unittest, so before npm ci)."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lg_check  # noqa: E402


class CountLg(unittest.TestCase):
    def test_counts_variants_at_or_above_lg_and_anything_unrecognised(self) -> None:
        for cls in ("lg:flex", "xl:flex", "2xl:flex", "min-lg:flex", "min-xl:flex", "min-2xl:flex",
                    "hover:lg:flex", "md:hover:min-[1024px]:flex", "min-[64rem]:flex", "min-[1024px]:flex",
                    "min-[80rem]:flex", "min-[64em]:flex", "min-[calc(100vw)]:flex", "min-[64vw]:flex",
                    "min-[1200px]:flex", "min-[64.5rem]:flex", "not-max-lg:flex", "not-max-[1100px]:flex",
                    "[@media(min-width:64rem)]:flex", "[&>*]:flex", "xxl:flex", "flex-lg:x", "hover:focus:lg:flex"):
            with self.subTest(cls):
                self.assertEqual(lg_check.count_lg(f'<div class="{cls}">'), 1)

    def test_ignores_chains_made_only_of_known_non_desktop_variants(self) -> None:
        for cls in ("flex", "md:flex", "sm:flex", "min-sm:flex", "min-md:flex", "hover:focus:flex",
                    "group-hover:flex", "peer-checked:flex", "data-[open]:flex", "dark:md:flex",
                    "motion-reduce:flex", "max-lg:flex", "max-xl:flex", "max-[1100px]:flex", "md:max-lg:flex",
                    "min-[48rem]:flex", "min-[40rem]:flex", "min-[40em]:flex", "min-[1023px]:flex",
                    "min-[63.9rem]:flex", "@lg:flex", "@xl:flex", "@min-lg:flex", "@lg/card:flex",
                    "@max-lg:flex", "key: value", "https://x.y"):
            with self.subTest(cls):
                self.assertEqual(lg_check.count_lg(f'<div class="{cls}">'), 0)

    def test_counts_each_occurrence(self) -> None:
        self.assertEqual(lg_check.count_lg("lg:a xl:b max-lg:c hover:lg:d"), 3)


class ReadIndex(unittest.TestCase):
    def test_reads_staged_blobs_in_one_batch_not_the_disk(self) -> None:
        # git exports GIT_INDEX_FILE in pre-commit: the scratch repo must never see the real index.
        clean_env = {k: v for k, v in os.environ.items() if k not in ("GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE")}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, clean_env, clear=True):
            root = Path(tmp)

            def git(*args: str) -> None:
                subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)

            git("init", "-q")
            (root / "a.tsx").write_text("lg:a\n")
            (root / "b.tsx").write_text("xl:b \u00e9\n")
            git("add", "a.tsx", "b.tsx")
            (root / "a.tsx").write_text("changed on disk")
            with mock.patch.object(lg_check, "ROOT", root):
                self.assertEqual(lg_check.read_index(["a.tsx", "b.tsx"]), {"a.tsx": "lg:a\n", "b.tsx": "xl:b \u00e9\n"})
                with self.assertRaises(SystemExit):
                    lg_check.read_index(["nope.tsx"])


class ReadConf(unittest.TestCase):
    def test_parses_lines_and_comments(self) -> None:
        text = "# c\nsrc src/web\nexempt a/\nexempt b.tsx # why\n\nknown x.tsx 3\n"
        self.assertEqual(lg_check.read_conf(text), ("src/web", ["a/", "b.tsx"], {"x.tsx": 3}))

    def test_rejects_a_malformed_line(self) -> None:
        with self.assertRaises(SystemExit):
            lg_check.read_conf("known x.tsx many\n")


class Counted(unittest.TestCase):
    def test_exempt_prefix_and_exact_path(self) -> None:
        exempt = ["src/web/layout/", "src/web/strip/snap-strip.tsx"]
        self.assertFalse(lg_check.counted("src/web/layout/shell.tsx", exempt))
        self.assertFalse(lg_check.counted("src/web/strip/snap-strip.tsx", exempt))
        self.assertTrue(lg_check.counted("src/web/layout-extra/page.tsx", exempt))

    def test_skips_spec_and_non_ts_files(self) -> None:
        self.assertFalse(lg_check.counted("src/web/a/page.spec.tsx", []))
        self.assertFalse(lg_check.counted("src/web/a/notes.md", []))
        self.assertTrue(lg_check.counted("src/web/a/page.ts", []))


class Main(unittest.TestCase):
    def run_main(self, conf: str, files: dict[str, str], staged: bool = False) -> tuple[int, str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts/ci").mkdir(parents=True)
            (root / "scripts/ci/lg_count.conf").write_text(conf)
            for rel, text in files.items():
                (root / rel).parent.mkdir(parents=True, exist_ok=True)
                (root / rel).write_text(text)
            argv = ["lg_check.py", *(["--staged"] if staged else [])]
            with mock.patch.object(lg_check, "ROOT", root), \
                 mock.patch.object(lg_check, "CONF", root / "scripts/ci/lg_count.conf"), \
                 mock.patch.object(sys, "argv", argv), mock.patch.object(sys, "stderr") as err, \
                 mock.patch("builtins.print") as out:
                code = lg_check.main()
            messages = " ".join(str(c) for c in [*out.call_args_list, *err.method_calls])
            return code, messages

    def test_equal_count_passes(self) -> None:
        code, _ = self.run_main("known src/web/a.tsx 2\n", {"src/web/a.tsx": "lg:a min-[64rem]:b"})
        self.assertEqual(code, 0)

    def test_growth_fails(self) -> None:
        code, msg = self.run_main("known src/web/a.tsx 1\n", {"src/web/a.tsx": "lg:a xl:b"})
        self.assertEqual(code, 1)
        self.assertIn("only shrinks", msg)

    def test_shrink_fails_until_lowered(self) -> None:
        code, msg = self.run_main("known src/web/a.tsx 3\n", {"src/web/a.tsx": "lg:a"})
        self.assertEqual(code, 1)
        self.assertIn("lower it to 1", msg)

    def test_a_file_without_a_known_line_fails(self) -> None:
        code, _ = self.run_main("", {"src/web/a.tsx": "lg:a"})
        self.assertEqual(code, 1)

    def test_a_cleared_file_must_lose_its_line(self) -> None:
        code, msg = self.run_main("known src/web/a.tsx 1\n", {"src/web/a.tsx": "md:a"})
        self.assertEqual(code, 1)
        self.assertIn("delete its known line", msg)

    def test_staged_reads_the_index_not_the_disk(self) -> None:
        index = {"scripts/ci/lg_count.conf": "known src/web/a.tsx 1\n", "src/web/a.tsx": "lg:a xl:b"}

        def fake_git(*args: str) -> str:
            return "src/web/a.tsx\0"

        with mock.patch.object(lg_check, "git_out", fake_git), \
             mock.patch.object(lg_check, "read_index", lambda paths: {p: index[p] for p in paths}):
            code, _ = self.run_main("known src/web/a.tsx 2\n", {"src/web/a.tsx": "lg:a xl:b"}, staged=True)
        self.assertEqual(code, 1, "the staged conf says 1, the disk conf says 2")


if __name__ == "__main__":
    unittest.main()
