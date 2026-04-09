#!/usr/bin/env python3
"""Small NAS sidecar API for symlink search and creation."""

from __future__ import annotations

import json
import os
import posixpath
from dataclasses import dataclass
from difflib import SequenceMatcher
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def normalize_name(value: str) -> str:
    """Normalize names to improve fuzzy comparisons."""
    basename = posixpath.basename(value.replace("\\", "/")).strip().lower()
    stem, ext = posixpath.splitext(basename)
    if ext.lower() in {".mkv", ".mp4", ".avi", ".ts", ".m2ts", ".iso", ".flac", ".mp3"}:
        basename = stem
    for char in "._-[]()":
        basename = basename.replace(char, " ")
    return " ".join(part for part in basename.split() if part)


def infer_target_kind(target_path: str, hint: str) -> str:
    if hint in {"file", "dir"}:
        return hint

    basename = posixpath.basename(target_path)
    if basename in {"", ".", ".."}:
        return "dir"

    stem, ext = posixpath.splitext(basename)
    if stem and ext:
        return "file"
    return "dir"


def candidate_kind(path: Path) -> str:
    if path.is_dir():
        return "dir"
    if path.is_file():
        return "file"
    return "other"


def score_candidate(reference_name: str, candidate_name: str, target_kind: str, item_kind: str) -> tuple[float, str]:
    ref = normalize_name(reference_name)
    cand = normalize_name(candidate_name)
    if not ref or not cand:
        return 0.0, "empty normalized name"

    if ref == cand:
        score = 1.0
        reason = "exact normalized name"
    elif ref in cand or cand in ref:
        score = 0.88
        reason = "substring match"
    else:
        ratio = SequenceMatcher(None, ref, cand).ratio()
        ref_tokens = set(ref.split())
        cand_tokens = set(cand.split())
        overlap = len(ref_tokens & cand_tokens) / max(len(ref_tokens), len(cand_tokens))
        score = max(ratio, overlap * 0.95)
        reason = f"sequence similarity {score:.2f}"

    if target_kind == item_kind:
        score = min(score + 0.05, 1.0)
        if reason != "exact normalized name":
            reason = f"{reason}, matching kind"

    return score, reason


@dataclass(slots=True)
class LinkHelperConfig:
    host: str
    port: int
    api_token: str
    allowed_roots: list[Path]
    search_roots: list[Path]
    candidate_limit: int
    min_score: float
    auto_create_target_parent: bool

    @classmethod
    def from_env(cls) -> "LinkHelperConfig":
        allowed_roots = parse_roots(os.environ.get("ALLOWED_ROOTS", "/downloads"))
        search_roots = parse_roots(os.environ.get("SEARCH_ROOTS", ""))
        if not search_roots:
            search_roots = []

        return cls(
            host=os.environ.get("HOST", "0.0.0.0"),
            port=int(os.environ.get("PORT", "8787")),
            api_token=os.environ.get("API_TOKEN", "").strip(),
            allowed_roots=allowed_roots,
            search_roots=search_roots,
            candidate_limit=int(os.environ.get("CANDIDATE_LIMIT", "20")),
            min_score=float(os.environ.get("MIN_SCORE", "0.35")),
            auto_create_target_parent=os.environ.get("AUTO_CREATE_TARGET_PARENT", "true").lower() == "true",
        )


def parse_roots(raw: str) -> list[Path]:
    roots: list[Path] = []
    for part in raw.split(","):
        clean = part.strip()
        if not clean:
            continue
        root = Path(clean).resolve(strict=False)
        roots.append(root)
    return roots


class LinkHelperError(Exception):
    status = HTTPStatus.BAD_REQUEST

    def __init__(self, message: str, status: HTTPStatus | None = None) -> None:
        super().__init__(message)
        if status is not None:
            self.status = status


class LinkHelperService:
    def __init__(self, config: LinkHelperConfig) -> None:
        self.config = config

    def _resolve(self, value: str) -> Path:
        return Path(value).resolve(strict=False)

    def _absolute(self, value: str) -> Path:
        return Path(os.path.abspath(value))

    def _ensure_within_allowed_roots(self, path: Path, field_name: str) -> None:
        for root in self.config.allowed_roots:
            try:
                path.relative_to(root)
                return
            except ValueError:
                continue
        raise LinkHelperError(
            f"{field_name} is outside configured allowed roots: {path}",
            HTTPStatus.FORBIDDEN,
        )

    def _ensure_authorized(self, headers: dict[str, str]) -> None:
        if not self.config.api_token:
            return

        bearer = headers.get("authorization", "")
        token = headers.get("x-api-token", "")
        if bearer.startswith("Bearer "):
            token = bearer[7:].strip()

        if token != self.config.api_token:
            raise LinkHelperError("Unauthorized", HTTPStatus.UNAUTHORIZED)

    def health(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "allowedRoots": [root.as_posix() for root in self.config.allowed_roots],
            "searchRoots": [root.as_posix() for root in self.config.search_roots],
        }

    def _iter_tree(self, directory: Path):
        try:
            with os.scandir(directory) as entries:
                subdirs: list[Path] = []
                for entry in entries:
                    try:
                        entry_path = Path(entry.path)
                        yield entry_path
                        if entry.is_dir(follow_symlinks=False):
                            subdirs.append(entry_path)
                    except OSError:
                        continue
        except OSError:
            return

        for subdir in subdirs:
            yield from self._iter_tree(subdir)

    def _iter_symlinks(self, directory: Path):
        for entry_path in self._iter_tree(directory):
            try:
                if entry_path.is_symlink():
                    yield entry_path
            except OSError:
                continue

    def _measure_path_size(self, path: Path) -> int | None:
        try:
            if path.is_symlink():
                return None
            if path.is_file():
                return path.stat().st_size
            if path.is_dir():
                total_size = 0
                for child_path in self._iter_tree(path):
                    try:
                        if child_path.is_symlink() or not child_path.is_file():
                            continue
                        total_size += child_path.stat().st_size
                    except OSError:
                        continue
                return total_size
        except OSError:
            return None
        return None

    def _describe_symlink(self, symlink_path: Path, root: Path) -> dict[str, Any]:
        raw_target = os.readlink(symlink_path)
        if Path(raw_target).is_absolute():
            resolved_target = Path(raw_target).resolve(strict=False)
        else:
            resolved_target = (symlink_path.parent / raw_target).resolve(strict=False)

        target_exists = resolved_target.exists()
        return {
            "path": symlink_path.as_posix(),
            "name": symlink_path.name,
            "rawTarget": raw_target,
            "targetPath": resolved_target.as_posix(),
            "targetExists": target_exists,
            "targetKind": candidate_kind(resolved_target) if target_exists else "other",
            "status": "ok" if target_exists else "broken",
            "root": root.as_posix(),
        }

    def list_symlinks(self) -> dict[str, Any]:
        symlinks: list[dict[str, Any]] = []
        seen_paths: set[Path] = set()

        for root in self.config.allowed_roots:
            if not root.exists() or not root.is_dir():
                continue

            for symlink_path in self._iter_symlinks(root):
                absolute_symlink_path = self._absolute(symlink_path.as_posix())
                if absolute_symlink_path in seen_paths:
                    continue
                seen_paths.add(absolute_symlink_path)
                symlinks.append(self._describe_symlink(absolute_symlink_path, root))

        symlinks.sort(key=lambda item: (item["status"] != "broken", item["path"]))
        return {"symlinks": symlinks}

    def search_candidates(self, payload: dict[str, Any]) -> dict[str, Any]:
        torrent_name = str(payload.get("torrentName", "")).strip()
        download_dir = str(payload.get("downloadDir", "")).strip()
        target_path = str(payload.get("targetPath", "")).strip()
        target_kind = infer_target_kind(target_path, str(payload.get("targetKindHint", "auto")).strip())

        if not torrent_name:
            raise LinkHelperError("torrentName is required")
        if not download_dir:
            raise LinkHelperError("downloadDir is required")
        if not target_path:
            raise LinkHelperError("targetPath is required")

        resolved_download_dir = self._resolve(download_dir)
        resolved_target = self._resolve(target_path)

        self._ensure_within_allowed_roots(resolved_download_dir, "downloadDir")
        self._ensure_within_allowed_roots(resolved_target, "targetPath")

        search_dirs: list[Path] = []
        for path in [resolved_target.parent, resolved_download_dir, *self.config.search_roots]:
            if path.exists() and path.is_dir() and path not in search_dirs:
                self._ensure_within_allowed_roots(path, "searchRoot")
                search_dirs.append(path)

        candidates: list[dict[str, Any]] = []
        seen_paths: set[Path] = set()

        for directory in search_dirs:
            for candidate_path in self._iter_tree(directory):
                item_path = candidate_path.resolve(strict=False)
                if item_path in seen_paths:
                    continue
                seen_paths.add(item_path)

                item_kind = candidate_kind(item_path)
                if item_kind == "other":
                    continue

                score, reason = score_candidate(torrent_name, candidate_path.name, target_kind, item_kind)
                if score < self.config.min_score:
                    continue

                candidates.append({
                    "path": item_path.as_posix(),
                    "name": candidate_path.name,
                    "kind": item_kind,
                    "score": round(score, 4),
                    "reason": reason,
                    "searchRoot": directory.as_posix(),
                    "sizeBytes": self._measure_path_size(candidate_path),
                })

        candidates.sort(key=lambda item: (-item["score"], item["name"]))
        candidates = candidates[:self.config.candidate_limit]

        return {
            "targetPath": resolved_target.as_posix(),
            "targetKind": target_kind,
            "candidates": candidates,
        }

    def create_symlink(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_path = str(payload.get("sourcePath", "")).strip()
        target_path = str(payload.get("targetPath", "")).strip()

        if not source_path:
            raise LinkHelperError("sourcePath is required")
        if not target_path:
            raise LinkHelperError("targetPath is required")

        source = self._resolve(source_path)
        target = self._resolve(target_path)

        self._ensure_within_allowed_roots(source, "sourcePath")
        self._ensure_within_allowed_roots(target, "targetPath")

        if not source.exists():
            raise LinkHelperError(f"sourcePath does not exist: {source}", HTTPStatus.NOT_FOUND)
        if source == target:
            raise LinkHelperError("sourcePath and targetPath must differ")
        if target.exists() or target.is_symlink():
            return {
                "status": "skipped_exists",
                "sourcePath": source.as_posix(),
                "targetPath": target.as_posix(),
            }

        if self.config.auto_create_target_parent:
            target.parent.mkdir(parents=True, exist_ok=True)
        elif not target.parent.exists():
            raise LinkHelperError(f"target parent does not exist: {target.parent}", HTTPStatus.NOT_FOUND)

        os.symlink(source.as_posix(), target.as_posix())

        return {
            "status": "created",
            "sourcePath": source.as_posix(),
            "targetPath": target.as_posix(),
        }

    def delete_symlink(self, payload: dict[str, Any]) -> dict[str, Any]:
        symlink_path = str(payload.get("path", "")).strip()

        if not symlink_path:
            raise LinkHelperError("path is required")

        link_path = self._absolute(symlink_path)
        self._ensure_within_allowed_roots(link_path, "path")

        if not link_path.exists() and not link_path.is_symlink():
            raise LinkHelperError(f"path does not exist: {link_path}", HTTPStatus.NOT_FOUND)
        if not link_path.is_symlink():
            raise LinkHelperError(f"path is not a symlink: {link_path}")

        link_path.unlink()

        return {
            "status": "deleted",
            "path": link_path.as_posix(),
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "TrguiLinkHelper/0.1"

    @property
    def service(self) -> LinkHelperService:
        return self.server.service  # type: ignore[attr-defined]

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        try:
            self.service._ensure_authorized(self._headers())
            if parsed.path == "/health":
                self._write_json(HTTPStatus.OK, self.service.health())
                return
            if parsed.path == "/symlinks":
                self._write_json(HTTPStatus.OK, self.service.list_symlinks())
                return
            self._write_error(LinkHelperError("Not Found", HTTPStatus.NOT_FOUND))
        except LinkHelperError as exc:
            self._write_error(exc)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            self.service._ensure_authorized(self._headers())
            payload = self._read_json()
            if parsed.path == "/search-candidates":
                self._write_json(HTTPStatus.OK, self.service.search_candidates(payload))
                return
            if parsed.path == "/create-symlink":
                self._write_json(HTTPStatus.OK, self.service.create_symlink(payload))
                return
            if parsed.path == "/delete-symlink":
                self._write_json(HTTPStatus.OK, self.service.delete_symlink(payload))
                return
            self._write_error(LinkHelperError("Not Found", HTTPStatus.NOT_FOUND))
        except LinkHelperError as exc:
            self._write_error(exc)
        except json.JSONDecodeError as exc:
            self._write_error(LinkHelperError(f"Invalid JSON payload: {exc}", HTTPStatus.BAD_REQUEST))

    def _headers(self) -> dict[str, str]:
        return {key.lower(): value for key, value in self.headers.items()}

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8"))

    def _write_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def _write_error(self, error: LinkHelperError) -> None:
        self._write_json(error.status, {"error": str(error)})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"{self.address_string()} - {fmt % args}")


class LinkHelperHttpServer(ThreadingHTTPServer):
    def __init__(self, server_address: tuple[str, int], service: LinkHelperService) -> None:
        super().__init__(server_address, Handler)
        self.service = service


def main() -> None:
    config = LinkHelperConfig.from_env()
    service = LinkHelperService(config)
    server = LinkHelperHttpServer((config.host, config.port), service)
    print(
        "Starting link helper on "
        f"{config.host}:{config.port} with allowed roots "
        f"{', '.join(root.as_posix() for root in config.allowed_roots)}"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
