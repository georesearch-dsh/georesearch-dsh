import json
import csv
import hashlib
import importlib.metadata
import importlib.util
import os
import platform
import re
import sys
import threading
from pathlib import Path
from math import isclose
from datetime import datetime, timezone
from typing import Any

from . import PROTOCOL, WORKER_VERSION


_RFC3339_UTC = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$"
)

_LIBRARIES = ("rasterio", "pyproj", "numpy", "scipy", "scikit-learn")


class Worker:
    def __init__(self) -> None:
        self._pending: dict[str, threading.Event] = {}
        self._pending_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._threads: list[threading.Thread] = []
        self._stopping = False

    def run(self) -> None:
        self._emit(
            {
                "type": "hello",
                "protocol": PROTOCOL,
                "workerVersion": WORKER_VERSION,
                "pythonVersion": platform.python_version(),
                "capabilities": {
                    "methods": ["ping", "sleep", "inspect-dataset"],
                    "cancel": True,
                    "deadlines": True,
                    "libraries": {
                        name: _library_version(name) for name in _LIBRARIES
                    },
                },
                "pid": os.getpid(),
            }
        )
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
                self._dispatch(message)
            except Exception as error:  # Protocol boundary contains malformed input.
                self._emit({"type": "protocol-error", "error": type(error).__name__})
            if self._stopping:
                break
        self._cancel_all()
        for thread in self._threads:
            thread.join(timeout=5)

    def _dispatch(self, message: Any) -> None:
        if not isinstance(message, dict):
            raise TypeError("message must be an object")
        message_type = message.get("type")
        if message_type == "shutdown":
            self._stopping = True
            return
        if message_type == "cancel":
            request_id = self._request_id(message)
            with self._pending_lock:
                event = self._pending.get(request_id)
            if event is not None:
                event.set()
            return

        request_id, method, deadline, params = self._request(message)
        with self._pending_lock:
            if request_id in self._pending:
                self._emit({"id": request_id, "error": "DUPLICATE_REQUEST"})
                return
        if deadline <= datetime.now(timezone.utc):
            self._emit({"id": request_id, "error": "DEADLINE_EXCEEDED"})
            return
        if method == "ping":
            self._emit({"id": request_id, "result": {"pong": True}})
            return
        if method == "sleep":
            milliseconds = params.get("milliseconds")
            if not isinstance(milliseconds, int) or milliseconds < 0 or milliseconds > 60_000:
                self._emit({"id": request_id, "error": "INVALID_ARGUMENT"})
                return
            cancel = threading.Event()
            with self._pending_lock:
                if request_id in self._pending:
                    self._emit({"id": request_id, "error": "DUPLICATE_REQUEST"})
                    return
                self._pending[request_id] = cancel
            thread = threading.Thread(
                target=self._sleep,
                args=(request_id, milliseconds, deadline, cancel),
                daemon=True,
            )
            self._threads.append(thread)
            thread.start()
            return
        if method == "inspect-dataset":
            self._start_request(request_id, self._inspect_dataset, params, deadline)
            return
        self._emit({"id": request_id, "error": "METHOD_NOT_FOUND"})

    def _start_request(
        self,
        request_id: str,
        operation: Any,
        params: dict[str, Any],
        deadline: datetime,
    ) -> None:
        cancel = threading.Event()
        with self._pending_lock:
            if request_id in self._pending:
                self._emit({"id": request_id, "error": "DUPLICATE_REQUEST"})
                return
            self._pending[request_id] = cancel
        thread = threading.Thread(
            target=self._execute_request,
            args=(request_id, operation, params, deadline, cancel),
            daemon=True,
        )
        self._threads.append(thread)
        thread.start()

    def _execute_request(
        self,
        request_id: str,
        operation: Any,
        params: dict[str, Any],
        deadline: datetime,
        cancel: threading.Event,
    ) -> None:
        try:
            self._checkpoint(cancel, deadline)
            result = operation(params, cancel, deadline)
            self._checkpoint(cancel, deadline)
            self._emit({"id": request_id, "result": result})
        except _WorkerRequestError as error:
            self._emit({"id": request_id, "error": error.code})
        except Exception:
            self._emit({"id": request_id, "error": "GEODATA_INVALID"})
        finally:
            with self._pending_lock:
                self._pending.pop(request_id, None)

    def _inspect_dataset(
        self,
        params: dict[str, Any],
        cancel: threading.Event,
        deadline: datetime,
    ) -> dict[str, Any]:
        assets_value = params.get("assets")
        if not isinstance(assets_value, list) or not assets_value:
            raise _WorkerRequestError("INVALID_ARGUMENT")
        if len(assets_value) > 128:
            raise _WorkerRequestError("INVALID_ARGUMENT")
        assets: list[dict[str, Any]] = []
        for raw_asset in assets_value:
            self._checkpoint(cancel, deadline)
            assets.append(_inspect_asset(raw_asset))
        splits = _split_records(params.get("splits", []))
        options = params.get("options", {})
        if not isinstance(options, dict):
            raise _WorkerRequestError("INVALID_ARGUMENT")
        checks = _dataset_checks(assets, splits, options)
        return {"assets": assets, "checks": checks}

    @staticmethod
    def _checkpoint(cancel: threading.Event, deadline: datetime) -> None:
        if cancel.is_set():
            raise _WorkerRequestError("CANCELLED")
        if deadline <= datetime.now(timezone.utc):
            raise _WorkerRequestError("DEADLINE_EXCEEDED")

    def _sleep(
        self,
        request_id: str,
        milliseconds: int,
        deadline: datetime,
        cancel: threading.Event,
    ) -> None:
        requested_seconds = milliseconds / 1000
        deadline_seconds = max(
            0.0,
            (deadline - datetime.now(timezone.utc)).total_seconds(),
        )
        deadline_wins = deadline_seconds <= requested_seconds
        cancelled = cancel.wait(min(requested_seconds, deadline_seconds))
        with self._pending_lock:
            self._pending.pop(request_id, None)
        if cancelled:
            self._emit({"id": request_id, "error": "CANCELLED"})
        elif deadline_wins:
            self._emit({"id": request_id, "error": "DEADLINE_EXCEEDED"})
        else:
            self._emit({"id": request_id, "result": {"sleptMilliseconds": milliseconds}})

    def _cancel_all(self) -> None:
        with self._pending_lock:
            events = list(self._pending.values())
        for event in events:
            event.set()

    @staticmethod
    def _request_id(message: dict[str, Any]) -> str:
        request_id = message.get("id")
        if not isinstance(request_id, str) or not request_id:
            raise TypeError("id must be a non-empty string")
        return request_id

    @classmethod
    def _request(
        cls,
        message: dict[str, Any],
    ) -> tuple[str, str, datetime, dict[str, Any]]:
        request_id = cls._request_id(message)
        method = message.get("method")
        if not isinstance(method, str) or not method:
            raise TypeError("method must be a non-empty string")
        deadline = cls._deadline(message.get("deadline"))
        params = message.get("params")
        if not isinstance(params, dict):
            raise TypeError("params must be an object")
        return request_id, method, deadline, params

    @staticmethod
    def _deadline(value: Any) -> datetime:
        if not isinstance(value, str) or _RFC3339_UTC.fullmatch(value) is None:
            raise TypeError("deadline must be an RFC3339 UTC timestamp")
        try:
            deadline = datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError as error:
            raise TypeError("deadline must be an RFC3339 UTC timestamp") from error
        if deadline.utcoffset() != timezone.utc.utcoffset(deadline):
            raise TypeError("deadline must use UTC")
        return deadline

    def _emit(self, message: dict[str, Any]) -> None:
        encoded = json.dumps(message, ensure_ascii=True, separators=(",", ":"))
        with self._write_lock:
            sys.stdout.write(encoded + "\n")
            sys.stdout.flush()


class _WorkerRequestError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _library_version(name: str) -> str | None:
    package = "scikit-learn" if name == "scikit-learn" else name
    module = "sklearn" if name == "scikit-learn" else name
    if importlib.util.find_spec(module) is None:
        return None
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        return "available"


def _inspect_asset(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _WorkerRequestError("INVALID_ARGUMENT")
    artifact_id = value.get("artifactId")
    digest = value.get("digest")
    kind = value.get("kind")
    media_type = value.get("mediaType")
    path_value = value.get("path")
    if (
        not isinstance(artifact_id, str)
        or not artifact_id
        or not isinstance(digest, str)
        or re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None
        or not isinstance(kind, str)
        or not kind
        or (media_type is not None and (not isinstance(media_type, str) or not media_type))
        or not isinstance(path_value, str)
        or not path_value
    ):
        raise _WorkerRequestError("INVALID_ARGUMENT")
    path = Path(path_value)
    if not path.is_absolute() or not path.is_file():
        raise _WorkerRequestError("GEODATA_INVALID")
    suffix = path.suffix.lower()
    artifact_ref = {"artifactId": artifact_id, "digest": digest, "kind": kind}
    normalized_media_type = media_type.lower().split(";", 1)[0].strip() if media_type else ""
    detected = _detect_asset_format(path, suffix, normalized_media_type)
    if detected == "raster":
        return _inspect_raster(path, artifact_ref)
    if detected == "geojson":
        return _inspect_geojson(path, artifact_ref)
    if detected == "tsv":
        return _inspect_delimited(path, artifact_ref, "\t")
    if detected == "csv":
        return _inspect_delimited(path, artifact_ref, ",")
    raise _WorkerRequestError("GEODATA_INVALID")


def _detect_asset_format(path: Path, suffix: str, media_type: str) -> str | None:
    if media_type in {
        "image/tiff",
        "image/geotiff",
        "application/geotiff",
        "image/jp2",
        "image/jpx",
        "application/gml+xml",
    }:
        return "raster"
    if media_type in {"application/geo+json", "application/vnd.geo+json"}:
        return "geojson"
    if media_type == "text/csv":
        return "csv"
    if media_type == "text/tab-separated-values":
        return "tsv"
    if suffix in {".tif", ".tiff", ".vrt", ".img", ".jp2"}:
        return "raster"
    if suffix in {".geojson", ".json"}:
        return "geojson"
    if suffix == ".csv":
        return "csv"
    if suffix == ".tsv":
        return "tsv"

    with path.open("rb") as stream:
        prefix = stream.read(512)
    if prefix.startswith((b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+")):
        return "raster"
    if prefix.startswith(b"\x00\x00\x00\x0cjP  \r\n\x87\n") or b"<VRTDataset" in prefix:
        return "raster"
    if media_type == "application/json" or prefix.lstrip().startswith((b"{", b"[")):
        return "geojson"
    return None


def _inspect_raster(path: Path, artifact_ref: dict[str, str]) -> dict[str, Any]:
    if importlib.util.find_spec("rasterio") is None:
        raise _WorkerRequestError("GEOSPATIAL_PROVIDER_INCOMPATIBLE")
    import rasterio

    with rasterio.open(path) as dataset:
        crs = _crs_record(dataset.crs)
        descriptions = dataset.descriptions or ()
        units = dataset.units or ()
        scales = dataset.scales or ()
        offsets = dataset.offsets or ()
        nodata_values = dataset.nodatavals or ()
        color_interpretations = dataset.colorinterp or ()
        bands = []
        for index in range(dataset.count):
            color = color_interpretations[index] if index < len(color_interpretations) else None
            bands.append(
                {
                    "index": index + 1,
                    "name": descriptions[index] or f"band-{index + 1}",
                    "dataType": dataset.dtypes[index],
                    "unit": units[index] if index < len(units) and units[index] else None,
                    "scale": float(scales[index]) if index < len(scales) else 1.0,
                    "offset": float(offsets[index]) if index < len(offsets) else 0.0,
                    "noData": _finite_or_none(
                        nodata_values[index] if index < len(nodata_values) else dataset.nodata
                    ),
                    "colorInterpretation": getattr(color, "name", None),
                }
            )
        transform = tuple(float(value) for value in tuple(dataset.transform)[:6])
        return {
            "artifactRef": artifact_ref,
            "format": dataset.driver or path.suffix.lower().lstrip("."),
            "width": int(dataset.width),
            "height": int(dataset.height),
            "featureCount": None,
            "spatialExtent": [
                float(dataset.bounds.left),
                float(dataset.bounds.bottom),
                float(dataset.bounds.right),
                float(dataset.bounds.top),
            ],
            "crs": crs,
            "resolution": [abs(float(dataset.res[0])), abs(float(dataset.res[1]))],
            "transform": list(transform),
            "bands": bands,
            "fields": [],
        }


def _inspect_geojson(path: Path, artifact_ref: dict[str, str]) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        document = json.load(stream)
    if not isinstance(document, dict):
        raise _WorkerRequestError("GEODATA_INVALID")
    features = document.get("features")
    if document.get("type") == "Feature":
        features = [document]
    if not isinstance(features, list):
        raise _WorkerRequestError("GEODATA_INVALID")
    coordinates: list[tuple[float, float]] = []
    field_types: dict[str, set[str]] = {}
    for feature in features:
        if not isinstance(feature, dict):
            continue
        geometry = feature.get("geometry")
        if isinstance(geometry, dict):
            _collect_coordinates(geometry.get("coordinates"), coordinates)
        properties = feature.get("properties")
        if isinstance(properties, dict):
            for key, item in properties.items():
                field_types.setdefault(str(key), set()).add(_json_type(item))
    bbox = None
    if coordinates:
        xs = [point[0] for point in coordinates]
        ys = [point[1] for point in coordinates]
        bbox = [min(xs), min(ys), max(xs), max(ys)]
    crs_value = document.get("crs")
    # RFC 7946 GeoJSON coordinates use the WGS84 longitude/latitude CRS when
    # the legacy crs member is absent.
    authority = "OGC:CRS84"
    if isinstance(crs_value, dict):
        properties = crs_value.get("properties")
        if isinstance(properties, dict) and isinstance(properties.get("name"), str):
            authority = properties["name"]
    crs = _crs_record(authority)
    fields = [
        {
            "name": key,
            "dataType": "|".join(sorted(types)),
            "unit": None,
            "nullable": "null" in types,
        }
        for key, types in sorted(field_types.items())
    ]
    return {
        "artifactRef": artifact_ref,
        "format": "GeoJSON",
        "width": None,
        "height": None,
        "featureCount": len(features),
        "spatialExtent": bbox,
        "crs": crs,
        "resolution": None,
        "transform": None,
        "bands": [],
        "fields": fields,
    }


def _inspect_delimited(
    path: Path,
    artifact_ref: dict[str, str],
    delimiter: str,
) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream, delimiter=delimiter)
        names = reader.fieldnames or []
        rows = []
        for index, row in enumerate(reader):
            if index >= 10000:
                break
            rows.append(row)
    fields = []
    for name in names:
        values = [row.get(name) for row in rows]
        nullable = any(value is None or value == "" for value in values)
        non_empty = [value for value in values if value not in (None, "")]
        fields.append(
            {
                "name": name,
                "dataType": _infer_text_type(non_empty),
                "unit": None,
                "nullable": nullable,
            }
        )
    return {
        "artifactRef": artifact_ref,
        "format": "TSV" if delimiter == "\t" else "CSV",
        "width": None,
        "height": None,
        "featureCount": len(rows),
        "spatialExtent": None,
        "crs": _crs_record(None),
        "resolution": None,
        "transform": None,
        "bands": [],
        "fields": fields,
    }


def _crs_record(value: Any) -> dict[str, Any]:
    if value is None:
        return {"authority": None, "wktDigest": None, "axisOrder": [], "units": []}
    authority = None
    wkt = None
    axis_order: list[str] = []
    units: list[str] = []
    try:
        if isinstance(value, str):
            authority = value
        else:
            pair = value.to_authority()
            if pair:
                authority = f"{pair[0]}:{pair[1]}"
            wkt = value.to_wkt()
        if importlib.util.find_spec("pyproj") is not None:
            from pyproj import CRS

            projected = CRS.from_user_input(authority or value)
            authority_pair = projected.to_authority()
            if authority_pair:
                authority = f"{authority_pair[0]}:{authority_pair[1]}"
            if wkt is None:
                wkt = projected.to_wkt()
            axis_order = [axis.abbrev or axis.name for axis in projected.axis_info]
            units = sorted({axis.unit_name for axis in projected.axis_info if axis.unit_name})
    except Exception:
        axis_order = []
        units = []
    return {
        "authority": authority,
        "wktDigest": (
            f"sha256:{hashlib.sha256(wkt.encode('utf-8')).hexdigest()}" if wkt else None
        ),
        "axisOrder": axis_order,
        "units": units,
    }


def _dataset_checks(
    assets: list[dict[str, Any]],
    splits: list[dict[str, Any]],
    options: dict[str, Any],
) -> list[dict[str, Any]]:
    spatial_assets = [asset for asset in assets if asset["spatialExtent"] is not None]
    raster_assets = [asset for asset in assets if asset["width"] is not None]
    all_ids = [asset["artifactRef"]["artifactId"] for asset in assets]
    checks: list[dict[str, Any]] = []
    checks.append(
        _check(
            "crs-present",
            "common-gis",
            True,
            "passed" if spatial_assets and all(asset["crs"]["authority"] or asset["crs"]["wktDigest"] for asset in spatial_assets) else "failed",
            "CRS_PRESENT" if spatial_assets and all(asset["crs"]["authority"] or asset["crs"]["wktDigest"] for asset in spatial_assets) else "CRS_MISSING",
            "All spatial assets declare a CRS." if spatial_assets and all(asset["crs"]["authority"] or asset["crs"]["wktDigest"] for asset in spatial_assets) else "At least one spatial asset has no CRS.",
            all_ids,
        )
    )
    pyproj_available = _library_version("pyproj") is not None
    axis_ok = bool(spatial_assets) and all(asset["crs"]["axisOrder"] for asset in spatial_assets)
    checks.append(
        _check(
            "crs-axis-order",
            "common-gis",
            True,
            "passed" if axis_ok else ("blocked" if not pyproj_available else "failed"),
            "CRS_AXIS_VERIFIED" if axis_ok else ("CRS_AXIS_VALIDATOR_MISSING" if not pyproj_available else "CRS_AXIS_UNKNOWN"),
            "CRS axis order is explicit." if axis_ok else "CRS axis order could not be verified.",
            all_ids,
        )
    )
    units_ok = bool(spatial_assets) and all(asset["crs"]["units"] for asset in spatial_assets)
    checks.append(
        _check(
            "crs-units",
            "common-gis",
            True,
            "passed" if units_ok else ("blocked" if not pyproj_available else "failed"),
            "CRS_UNITS_VERIFIED" if units_ok else ("CRS_UNIT_VALIDATOR_MISSING" if not pyproj_available else "CRS_UNITS_UNKNOWN"),
            "Coordinate units are explicit." if units_ok else "Coordinate units could not be verified.",
            all_ids,
        )
    )
    extent_ok = bool(spatial_assets) and all(_valid_bbox(asset["spatialExtent"]) for asset in spatial_assets)
    checks.append(
        _check(
            "spatial-extent",
            "common-gis",
            True,
            "passed" if extent_ok else "failed",
            "EXTENT_VALID" if extent_ok else "EXTENT_INVALID",
            "Spatial extents are finite and ordered." if extent_ok else "A spatial extent is missing or invalid.",
            all_ids,
        )
    )
    if len(raster_assets) < 2:
        checks.append(_check("raster-alignment", "common-gis", True, "not-applicable", "ALIGNMENT_SINGLE_RASTER", "Alignment requires at least two raster assets.", all_ids))
    else:
        aligned = _rasters_aligned(raster_assets)
        checks.append(
            _check(
                "raster-alignment", "common-gis", True,
                "passed" if aligned else "failed",
                "ALIGNMENT_VALID" if aligned else "RASTER_MISALIGNED",
                "Raster grids are aligned." if aligned else "Raster CRS, resolution, or grid origin is misaligned.",
                all_ids,
            )
        )
    nodata_ok = bool(raster_assets) and all(asset["bands"] and all(band["noData"] is not None for band in asset["bands"]) for asset in raster_assets)
    checks.append(
        _check(
            "nodata", "common-gis", True,
            "passed" if nodata_ok else ("not-applicable" if not raster_assets else "failed"),
            "NODATA_VALID" if nodata_ok else ("NODATA_NOT_APPLICABLE" if not raster_assets else "NODATA_MISSING"),
            "Raster NoData values are explicit." if nodata_ok else ("No raster assets were supplied." if not raster_assets else "At least one raster band has no explicit NoData value."),
            all_ids,
        )
    )
    band_ok = bool(raster_assets) and all(asset["bands"] for asset in raster_assets)
    checks.append(_check("band-schema", "optical", True, "passed" if band_ok else ("not-applicable" if not raster_assets else "failed"), "BAND_SCHEMA_VALID" if band_ok else "BAND_SCHEMA_MISSING", "Raster band order, dtype, scale, offset, and units were read." if band_ok else "Raster band metadata is unavailable.", all_ids))
    classification = options.get("classification") is True
    resampling = options.get("categoricalResampling")
    if classification:
        resampling_ok = isinstance(resampling, str) and resampling.lower() in {"nearest", "mode"}
        checks.append(_check("categorical-resampling", "optical", True, "passed" if resampling_ok else "failed", "CATEGORICAL_RESAMPLING_VALID" if resampling_ok else "CATEGORICAL_RESAMPLING_INVALID", "Categorical data use nearest/mode resampling." if resampling_ok else "Categorical data require nearest or mode resampling.", all_ids))
    else:
        checks.append(_check("categorical-resampling", "optical", False, "not-applicable", "CATEGORICAL_RESAMPLING_NOT_APPLICABLE", "No categorical resampling policy was requested.", all_ids))
    labels = options.get("labelSchema")
    label_ok = isinstance(labels, list) and bool(labels)
    checks.append(_check("label-schema", "geospatial-ml", classification, "passed" if label_ok else ("failed" if classification else "not-applicable"), "LABEL_SCHEMA_VALID" if label_ok else "LABEL_SCHEMA_MISSING", "Label classes are explicit." if label_ok else "No label schema was supplied.", all_ids))
    machine_learning = options.get("machineLearning") is True
    if not machine_learning:
        checks.append(_check("spatial-leakage", "geospatial-ml", False, "not-applicable", "SPATIAL_LEAKAGE_NOT_APPLICABLE", "No geospatial machine-learning split validation was requested.", all_ids))
        checks.append(_check("temporal-leakage", "geospatial-ml", False, "not-applicable", "TEMPORAL_LEAKAGE_NOT_APPLICABLE", "No geospatial machine-learning split validation was requested.", all_ids))
    elif len(splits) < 2:
        checks.append(_check("spatial-leakage", "geospatial-ml", True, "blocked", "SPLIT_VALIDATOR_INPUT_MISSING", "At least two split membership records are required to verify leakage.", all_ids))
        checks.append(_check("temporal-leakage", "geospatial-ml", True, "blocked", "SPLIT_VALIDATOR_INPUT_MISSING", "At least two split membership records are required to verify temporal leakage.", all_ids))
    else:
        spatial_leakage = _split_overlap(splits, ("sampleIds", "spatialUnitIds", "sourceAssetDigests"))
        temporal_leakage = _split_overlap(splits, ("temporalKeys",))
        checks.append(_check("spatial-leakage", "geospatial-ml", True, "failed" if spatial_leakage else "passed", "SPATIAL_LEAKAGE_DETECTED" if spatial_leakage else "SPATIAL_LEAKAGE_CLEAR", "Split membership overlaps across sample, spatial unit, or source asset." if spatial_leakage else "No declared spatial split overlap was found.", all_ids))
        checks.append(_check("temporal-leakage", "geospatial-ml", True, "failed" if temporal_leakage else "passed", "TEMPORAL_LEAKAGE_DETECTED" if temporal_leakage else "TEMPORAL_LEAKAGE_CLEAR", "Temporal keys overlap across evaluation roles." if temporal_leakage else "No declared temporal split overlap was found.", all_ids))
    statistics = options.get("spatialStatistics")
    statistics_ok = isinstance(statistics, dict) and all(
        isinstance(statistics.get(key), str) and bool(statistics.get(key).strip())
        for key in ("blockingStrategy", "autocorrelation", "multipleComparison", "effectSize")
    )
    checks.append(_check("spatial-statistical-plan", "spatial-statistics", True, "passed" if statistics_ok else "blocked", "SPATIAL_STATISTICS_VALID" if statistics_ok else "SPATIAL_STATISTICS_PLAN_MISSING", "Spatial/statistical controls are explicit." if statistics_ok else "Mandatory spatial statistical controls are missing.", all_ids))
    return checks


def _check(
    check_id: str,
    domain: str,
    mandatory: bool,
    status: str,
    code: str,
    message: str,
    artifact_ids: list[str],
) -> dict[str, Any]:
    return {
        "checkId": check_id,
        "domain": domain,
        "mandatory": mandatory,
        "status": status,
        "code": code,
        "message": message,
        "relatedArtifactIds": artifact_ids,
    }


def _split_records(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise _WorkerRequestError("INVALID_ARGUMENT")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise _WorkerRequestError("INVALID_ARGUMENT")
        split_id = item.get("splitId")
        role = item.get("role")
        if not isinstance(split_id, str) or not split_id or role not in {"train", "validation", "test", "holdout"}:
            raise _WorkerRequestError("INVALID_ARGUMENT")
        record = {"splitId": split_id, "role": role}
        for key in ("sampleIds", "spatialUnitIds", "sourceAssetDigests", "temporalKeys"):
            entries = item.get(key)
            if not isinstance(entries, list) or any(not isinstance(entry, str) for entry in entries):
                raise _WorkerRequestError("INVALID_ARGUMENT")
            record[key] = entries
        result.append(record)
    return result


def _split_overlap(splits: list[dict[str, Any]], keys: tuple[str, ...]) -> bool:
    for left_index, left in enumerate(splits):
        for right in splits[left_index + 1 :]:
            if left["role"] == right["role"]:
                continue
            for key in keys:
                if set(left[key]).intersection(right[key]):
                    return True
    return False


def _rasters_aligned(assets: list[dict[str, Any]]) -> bool:
    first = assets[0]
    for other in assets[1:]:
        if first["crs"]["authority"] != other["crs"]["authority"]:
            if first["crs"]["wktDigest"] != other["crs"]["wktDigest"]:
                return False
        if not _numbers_close(first["resolution"], other["resolution"]):
            return False
        first_transform = first["transform"]
        other_transform = other["transform"]
        if first_transform is None or other_transform is None:
            return False
        pixel_x, pixel_y = first["resolution"]
        if not _integer_multiple(other_transform[2] - first_transform[2], pixel_x):
            return False
        if not _integer_multiple(other_transform[5] - first_transform[5], pixel_y):
            return False
    return True


def _numbers_close(left: Any, right: Any) -> bool:
    return (
        isinstance(left, list)
        and isinstance(right, list)
        and len(left) == len(right)
        and all(isclose(float(a), float(b), rel_tol=1e-9, abs_tol=1e-12) for a, b in zip(left, right))
    )


def _integer_multiple(value: float, unit: float) -> bool:
    if unit == 0:
        return False
    quotient = value / unit
    return isclose(quotient, round(quotient), rel_tol=1e-9, abs_tol=1e-9)


def _valid_bbox(value: Any) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 4
        and all(isinstance(item, (int, float)) for item in value)
        and value[0] < value[2]
        and value[1] < value[3]
    )


def _collect_coordinates(value: Any, output: list[tuple[float, float]]) -> None:
    if isinstance(value, list):
        if len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
            output.append((float(value[0]), float(value[1])))
            return
        for child in value:
            _collect_coordinates(child, output)


def _json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "string"


def _infer_text_type(values: list[Any]) -> str:
    if not values:
        return "string"
    try:
        for value in values:
            int(str(value))
        return "integer"
    except ValueError:
        pass
    try:
        for value in values:
            float(str(value))
        return "number"
    except ValueError:
        return "string"


def _finite_or_none(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def main() -> None:
    Worker().run()
