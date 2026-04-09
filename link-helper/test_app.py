import os
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import LinkHelperConfig, LinkHelperService, infer_target_kind, normalize_name, score_candidate


class LinkHelperTests(unittest.TestCase):
    @staticmethod
    def _case_root(name: str) -> Path:
        temp_root = Path(__file__).resolve().parent / ".tmp"
        temp_root.mkdir(exist_ok=True)
        case_root = temp_root / name
        shutil.rmtree(case_root, ignore_errors=True)
        case_root.mkdir()
        return case_root

    def test_normalize_name(self) -> None:
        self.assertEqual(normalize_name("Movie.Name.2024.1080p.mkv"), "movie name 2024 1080p")

    def test_infer_target_kind(self) -> None:
        self.assertEqual(infer_target_kind("/downloads/movie/file.mkv", "auto"), "file")
        self.assertEqual(infer_target_kind("/downloads/movie/folder", "auto"), "dir")

    def test_score_candidate_prefers_exact_match(self) -> None:
        score, reason = score_candidate("Movie.Name.2024", "Movie Name 2024", "dir", "dir")
        self.assertGreaterEqual(score, 1.0)
        self.assertIn("exact", reason)

    def test_search_candidates_filters_by_allowed_roots(self) -> None:
        root = self._case_root("search")
        try:
            target_dir = root / "downloads"
            target_dir.mkdir()
            (target_dir / "Movie Name 2024").mkdir()
            (target_dir / "Unrelated").mkdir()

            service = LinkHelperService(
                LinkHelperConfig(
                    host="127.0.0.1",
                    port=8787,
                    api_token="",
                    allowed_roots=[root.resolve()],
                    search_roots=[],
                    candidate_limit=10,
                    min_score=0.35,
                    auto_create_target_parent=True,
                )
            )

            result = service.search_candidates({
                "torrentName": "Movie.Name.2024",
                "downloadDir": target_dir.as_posix(),
                "targetPath": (target_dir / "Movie.Name.2024").as_posix(),
                "targetKindHint": "dir",
            })

            self.assertEqual(len(result["candidates"]), 1)
            self.assertEqual(result["candidates"][0]["name"], "Movie Name 2024")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_search_candidates_walks_nested_directories_and_reports_size(self) -> None:
        root = self._case_root("search_nested")
        try:
            target_dir = root / "downloads"
            library_dir = root / "library"
            nested_dir = library_dir / "movies" / "Movie Name 2024"

            target_dir.mkdir()
            nested_dir.mkdir(parents=True)
            (nested_dir / "disc1.mkv").write_bytes(b"1234")
            (nested_dir / "disc2.srt").write_bytes(b"56")

            service = LinkHelperService(
                LinkHelperConfig(
                    host="127.0.0.1",
                    port=8787,
                    api_token="",
                    allowed_roots=[root.resolve()],
                    search_roots=[library_dir.resolve()],
                    candidate_limit=10,
                    min_score=0.35,
                    auto_create_target_parent=True,
                )
            )

            result = service.search_candidates({
                "torrentName": "Movie.Name.2024",
                "downloadDir": target_dir.as_posix(),
                "targetPath": (target_dir / "Movie.Name.2024").as_posix(),
                "targetKindHint": "dir",
            })

            matched = next((item for item in result["candidates"] if item["name"] == "Movie Name 2024"), None)

            self.assertIsNotNone(matched)
            self.assertEqual(matched["searchRoot"], library_dir.as_posix())
            self.assertEqual(matched["sizeBytes"], 6)
        finally:
            shutil.rmtree(root, ignore_errors=True)

    @unittest.skipIf(os.name == "nt", "symlink creation requires Linux-like permissions in this environment")
    def test_create_symlink(self) -> None:
        root = self._case_root("link").resolve()
        try:
            source = root / "source"
            target = root / "target"
            source.mkdir()

            service = LinkHelperService(
                LinkHelperConfig(
                    host="127.0.0.1",
                    port=8787,
                    api_token="",
                    allowed_roots=[root],
                    search_roots=[],
                    candidate_limit=10,
                    min_score=0.35,
                    auto_create_target_parent=True,
                )
            )

            result = service.create_symlink({
                "sourcePath": source.as_posix(),
                "targetPath": target.as_posix(),
            })

            self.assertEqual(result["status"], "created")
            self.assertTrue(target.is_symlink())
            self.assertEqual(target.resolve(), source.resolve())
        finally:
            shutil.rmtree(root, ignore_errors=True)

    @unittest.skipIf(os.name == "nt", "symlink creation requires Linux-like permissions in this environment")
    def test_list_symlinks_marks_broken_entries(self) -> None:
        root = self._case_root("list_links").resolve()
        try:
            source = root / "source"
            source.mkdir()
            valid_link = root / "valid_link"
            broken_link = root / "broken_link"
            os.symlink(source.as_posix(), valid_link.as_posix())
            os.symlink((root / "missing_source").as_posix(), broken_link.as_posix())

            service = LinkHelperService(
                LinkHelperConfig(
                    host="127.0.0.1",
                    port=8787,
                    api_token="",
                    allowed_roots=[root],
                    search_roots=[],
                    candidate_limit=10,
                    min_score=0.35,
                    auto_create_target_parent=True,
                )
            )

            result = service.list_symlinks()
            statuses = {item["path"]: item["status"] for item in result["symlinks"]}

            self.assertEqual(statuses[broken_link.as_posix()], "broken")
            self.assertEqual(statuses[valid_link.as_posix()], "ok")
        finally:
            shutil.rmtree(root, ignore_errors=True)

    @unittest.skipIf(os.name == "nt", "symlink creation requires Linux-like permissions in this environment")
    def test_delete_symlink(self) -> None:
        root = self._case_root("delete_link").resolve()
        try:
            source = root / "source"
            source.mkdir()
            target = root / "target"
            os.symlink(source.as_posix(), target.as_posix())

            service = LinkHelperService(
                LinkHelperConfig(
                    host="127.0.0.1",
                    port=8787,
                    api_token="",
                    allowed_roots=[root],
                    search_roots=[],
                    candidate_limit=10,
                    min_score=0.35,
                    auto_create_target_parent=True,
                )
            )

            result = service.delete_symlink({
                "path": target.as_posix(),
            })

            self.assertEqual(result["status"], "deleted")
            self.assertFalse(target.exists())
            self.assertFalse(target.is_symlink())
            self.assertTrue(source.exists())
        finally:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
