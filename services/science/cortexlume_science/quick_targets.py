from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from .template_gate import template_directory

PACK_FORMAT = "cortexlume-quick-target-pack"
PACK_FORMAT_VERSION = 1
VERTEX_COUNT = 25_000
_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Compatibility only for v1 fixtures and older packs. Current release packs
# carry curated aliases in catalog.json so vocabulary ships with the data.
_LEGACY_SEARCH_SYNONYMS: dict[str, tuple[str, ...]] = {
    "working memory": ("short term memory", "short-term memory", "wm"),
    "memory": ("recall", "recognition", "memory retrieval", "episodic memory"),
    "attention": ("attentional control", "selective attention", "sustained attention", "vigilance"),
    "inhibition": ("inhibitory control", "suppression"),
    "executive": ("executive function", "executive functions"),
    "cognitive control": ("executive control", "top down control", "top-down control"),
    "response inhibition": ("response suppression", "stop signal", "go no go", "go/no-go"),
    "decision making": ("decision", "choice", "choice behavior"),
    "motor": ("movement", "motor execution", "sensorimotor"),
    "motor imagery": ("movement imagery", "imagined movement"),
    "language": ("linguistic", "language processing"),
    "speech": ("speech production", "speaking"),
    "verbal fluency": ("word generation", "semantic fluency", "phonemic fluency"),
    "auditory": ("hearing", "sound", "acoustic"),
    "visual": ("vision", "visual processing"),
    "emotion": ("emotional processing", "affect", "affective"),
    "fear": ("threat", "anxiety"),
    "facial expressions": ("face processing", "facial emotion", "emotion recognition"),
    "reward": ("reinforcement", "incentive", "valuation"),
    "pain": ("nociception", "nociceptive"),
    "social": ("social cognition", "social processing"),
    "mentalizing": ("theory of mind", "tom", "mind reading"),
    "music": ("musical", "music perception", "music listening"),
}


class QuickTargetError(RuntimeError):
    """Raised when a Quick Target pack fails its integrity gate."""


@dataclass(frozen=True)
class QuickTargetStatus:
    available: bool
    issue: str | None
    pack_id: str | None = None
    term_count: int = 0
    distribution_role: str | None = None


def quick_target_directory() -> Path:
    configured = os.environ.get("CORTEXLUME_QUICK_TARGET_DIR")
    if configured:
        return Path(configured).resolve()
    return template_directory() / "generated" / "quick_targets"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _tokens(value: str) -> tuple[str, ...]:
    return tuple(_TOKEN_RE.findall(value.casefold()))


def _normalized(value: str) -> str:
    return " ".join(_tokens(value))


def _token_similarity(query: str, candidate: str) -> float:
    if query == candidate:
        return 1.0
    if len(query) >= 2 and candidate.startswith(query):
        return 0.94
    if len(candidate) >= 3 and query.startswith(candidate):
        return 0.88
    if len(query) >= 3 and query in candidate:
        return 0.82
    if min(len(query), len(candidate)) >= 4:
        ratio = SequenceMatcher(None, query, candidate, autojunk=False).ratio()
        if ratio >= 0.74:
            return ratio * 0.9
    return 0.0


def _match_rank(query: str, label: str, aliases: list[str]) -> tuple[int, float] | None:
    normalized_query = _normalized(query)
    if not normalized_query:
        return None
    phrases = [normalized for value in [label, *aliases] if (normalized := _normalized(value))]
    for phrase_index, phrase in enumerate(phrases):
        if normalized_query == phrase:
            return (0 if phrase_index == 0 else 1), 1.0

    best: tuple[int, float] | None = None
    query_tokens = _tokens(normalized_query)
    for phrase in phrases:
        if phrase.startswith(normalized_query) or (
            len(phrase) >= 3 and normalized_query.startswith(phrase)
        ):
            candidate = (2, min(len(normalized_query), len(phrase)) / max(len(normalized_query), len(phrase)))
        else:
            phrase_tokens = _tokens(phrase)
            token_scores = [
                max((_token_similarity(token, candidate) for candidate in phrase_tokens), default=0.0)
                for token in query_tokens
            ]
            if token_scores and min(token_scores) > 0:
                candidate = (3, sum(token_scores) / len(token_scores))
            elif len(query_tokens) == 1 and len(normalized_query) >= 4:
                ratio = SequenceMatcher(None, normalized_query, phrase, autojunk=False).ratio()
                candidate = (4, ratio) if ratio >= 0.72 else None
            else:
                candidate = None
        if candidate is not None and (best is None or (candidate[0], -candidate[1]) < (best[0], -best[1])):
            best = candidate
    return best


class QuickTargetPack:
    """Validated, numpy-only reader for an offline cortical target pack."""

    def __init__(self, root: Path):
        self.root = root
        manifest_path = root / "manifest.json"
        catalog_path = root / "catalog.json"
        maps_path = root / "maps.npz"
        if not all(path.is_file() for path in (manifest_path, catalog_path, maps_path)):
            raise QuickTargetError("quick_target_pack_incomplete")

        self.manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        if self.manifest.get("format") != PACK_FORMAT:
            raise QuickTargetError("quick_target_format_mismatch")
        if self.manifest.get("formatVersion") != PACK_FORMAT_VERSION:
            raise QuickTargetError("quick_target_version_unsupported")
        if self.manifest.get("space") != "MNI152NLin6Asym":
            raise QuickTargetError("quick_target_space_mismatch")
        if self.manifest.get("surface", {}).get("vertexCount") != VERTEX_COUNT:
            raise QuickTargetError("quick_target_vertex_count_mismatch")
        if not isinstance(self.catalog, list) or not self.catalog:
            raise QuickTargetError("quick_target_catalog_empty")

        expected_files = self.manifest.get("files", {})
        for name, path in (("catalog.json", catalog_path), ("maps.npz", maps_path)):
            expected = expected_files.get(name, {}).get("sha256")
            if not expected or _sha256(path) != expected:
                raise QuickTargetError(f"quick_target_hash_mismatch:{name}")

        with np.load(maps_path, allow_pickle=False) as archive:
            self.indices = np.asarray(archive["vertex_indices"], dtype=np.uint16)
            self.values = np.asarray(archive["z_values"], dtype=np.float16)
            self.offsets = np.asarray(archive["offsets"], dtype=np.uint32)
        if self.indices.shape != self.values.shape:
            raise QuickTargetError("quick_target_sparse_shape_mismatch")
        if self.offsets.shape != (len(self.catalog) + 1,):
            raise QuickTargetError("quick_target_offsets_shape_mismatch")
        if int(self.offsets[0]) != 0 or int(self.offsets[-1]) != len(self.indices):
            raise QuickTargetError("quick_target_offsets_invalid")
        if len(self.indices) and int(np.max(self.indices)) >= VERTEX_COUNT:
            raise QuickTargetError("quick_target_vertex_index_invalid")
        if not np.all(np.isfinite(self.values)) or np.any(self.values <= 0):
            raise QuickTargetError("quick_target_values_not_finite_positive")

        ids = [record.get("id") for record in self.catalog]
        if len(ids) != len(set(ids)) or any(not isinstance(value, str) for value in ids):
            raise QuickTargetError("quick_target_ids_invalid")
        for record in self.catalog:
            if not isinstance(record.get("label"), str) or not record["label"].strip():
                raise QuickTargetError("quick_target_label_invalid")
            aliases = record.get("aliases", [])
            if not isinstance(aliases, list) or any(not isinstance(value, str) or not value.strip() for value in aliases):
                raise QuickTargetError("quick_target_aliases_invalid")
            for field in ("domain", "subdomain"):
                if field in record and (not isinstance(record[field], str) or not record[field].strip()):
                    raise QuickTargetError(f"quick_target_{field}_invalid")
        for term_index, record in enumerate(self.catalog):
            start, stop = int(self.offsets[term_index]), int(self.offsets[term_index + 1])
            term_indices = self.indices[start:stop]
            term_values = self.values[start:stop]
            if len(term_indices) == 0 or np.any(np.diff(term_indices.astype(np.int32)) <= 0):
                raise QuickTargetError("quick_target_vertex_indices_not_unique_sorted")
            digest = hashlib.sha256()
            digest.update(term_indices.astype("<u2", copy=False).tobytes(order="C"))
            digest.update(term_values.astype("<f2", copy=False).tobytes(order="C"))
            if digest.hexdigest() != record.get("mapSha256"):
                raise QuickTargetError(f"quick_target_map_hash_mismatch:{record['id']}")
        self._by_id = {record["id"]: (index, record) for index, record in enumerate(self.catalog)}

    def provenance(self, record: dict[str, Any] | None = None) -> dict[str, Any]:
        if record is not None:
            return {
                "sourceKind": "neurosynth-quick",
                "sourceSpace": self.manifest["generation"]["sourceSpace"],
                "targetSpace": "MNI152NLin6Asym",
                "targetSurface": "Cedalion-ICBM152-25k",
                "statistic": self.manifest["statistic"]["name"],
                "mapSha256": record["mapSha256"],
                "interpolation": self.manifest["generation"]["vertexSampling"],
                "validation": self.manifest["qc"],
                "packId": self.manifest["packId"],
                "distributionRole": self.manifest["distributionRole"],
            }
        return {
            "packId": self.manifest["packId"],
            "distributionRole": self.manifest["distributionRole"],
            "space": self.manifest["space"],
            "statistic": self.manifest["statistic"],
            "source": self.manifest["source"],
            "generation": self.manifest["generation"],
            "surface": self.manifest["surface"],
            "qc": self.manifest["qc"],
        }

    def search(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        query_tokens = _tokens(query)
        if not query_tokens:
            recommended = sorted(
                self.catalog,
                key=lambda record: (-int(record.get("studyCount", 0)), str(record["label"]).casefold()),
            )
            return [dict(record) for record in recommended[:limit]]
        ranked: list[tuple[tuple[int, float, int, str], dict[str, Any]]] = []
        for record in self.catalog:
            label = str(record["label"])
            aliases = [str(value) for value in record.get("aliases", [])]
            if not aliases:
                aliases.extend(_LEGACY_SEARCH_SYNONYMS.get(label.casefold(), ()))
            match = _match_rank(query, label, aliases)
            if match is None:
                continue
            tier, score = match
            study_count = int(record.get("studyCount", 0))
            ranked.append(((tier, -score, -study_count, label.casefold()), record))
        ranked.sort(key=lambda item: item[0])
        if ranked and ranked[0][0][0] <= 1:
            exact_tier = ranked[0][0][0]
            ranked = [item for item in ranked if item[0][0] == exact_tier]
        return [dict(record) for _, record in ranked[:limit]]

    def catalog_overview(self) -> dict[str, Any]:
        """Return the complete compact catalog for Agent-side discovery."""
        fields = ("id", "label", "aliases", "domain", "subdomain", "studyCount", "laterality")
        targets = [{key: record[key] for key in fields if key in record} for record in self.catalog]
        targets.sort(key=lambda record: (
            str(record.get("domain", "")).casefold(),
            str(record.get("subdomain", "")).casefold(),
            str(record["label"]).casefold(),
        ))
        domains: dict[str, dict[str, int]] = {}
        for record in targets:
            domain = str(record.get("domain", "Uncategorized"))
            subdomain = str(record.get("subdomain", "Uncategorized"))
            domains.setdefault(domain, {})[subdomain] = domains.setdefault(domain, {}).get(subdomain, 0) + 1
        return {
            "count": len(targets),
            "targets": targets,
            "domains": [{
                "name": domain,
                "count": sum(subdomains.values()),
                "subdomains": [{"name": name, "count": count} for name, count in sorted(subdomains.items())],
            } for domain, subdomains in sorted(domains.items())],
            "provenance": {
                "packId": self.manifest["packId"],
                "distributionRole": self.manifest["distributionRole"],
                "space": self.manifest["space"],
            },
        }

    def get(self, target_id: str) -> dict[str, Any] | None:
        found = self._by_id.get(target_id)
        if found is None:
            return None
        term_index, record = found
        start = int(self.offsets[term_index])
        stop = int(self.offsets[term_index + 1])
        return {
            "target": dict(record),
            "vertexCount": VERTEX_COUNT,
            "vertexIndices": self.indices[start:stop].astype(np.int32).tolist(),
            "values": self.values[start:stop].astype(np.float32).tolist(),
            "provenance": self.provenance(record),
        }


@lru_cache(maxsize=4)
def load_quick_target_pack(path: str | None = None) -> QuickTargetPack:
    pack = QuickTargetPack(Path(path).resolve() if path else quick_target_directory())
    if (
        pack.manifest.get("distributionRole") != "release"
        and os.environ.get("CORTEXLUME_ALLOW_QUICK_TARGET_FIXTURE") != "1"
    ):
        raise QuickTargetError("quick_target_nonrelease_pack_blocked")
    return pack


def quick_target_status() -> QuickTargetStatus:
    try:
        pack = load_quick_target_pack()
    except (OSError, ValueError, KeyError, json.JSONDecodeError, QuickTargetError) as error:
        return QuickTargetStatus(False, str(error))
    return QuickTargetStatus(
        True, None, pack_id=pack.manifest["packId"], term_count=len(pack.catalog),
        distribution_role=pack.manifest["distributionRole"],
    )
