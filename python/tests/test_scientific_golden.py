from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from georesearch_worker.worker import _crs_record, _dataset_checks  # noqa: E402


class ScientificGeospatialGoldenTests(unittest.TestCase):
    def test_rasterio_crs_reports_axis_order_and_units(self) -> None:
        from rasterio.crs import CRS

        crs = _crs_record(CRS.from_epsg(32618))
        self.assertEqual(crs["authority"], "EPSG:32618")
        self.assertTrue(crs["axisOrder"])
        self.assertIn("metre", crs["units"])

    def test_missing_crs_is_rejected(self) -> None:
        asset = vector_asset()
        asset["crs"] = {"authority": None, "wktDigest": None, "axisOrder": [], "units": []}
        self.assert_check([asset], [], base_options(), "crs-present", "failed", "CRS_MISSING")

    def test_misaligned_rasters_are_rejected(self) -> None:
        first = raster_asset("raster-a", transform=[10, 0, 100, 0, -10, 200])
        second = raster_asset("raster-b", transform=[10, 0, 105, 0, -10, 200])
        self.assert_check([first, second], [], base_options(), "raster-alignment", "failed", "RASTER_MISALIGNED")

    def test_missing_nodata_is_rejected(self) -> None:
        asset = raster_asset("raster-a")
        asset["bands"][0]["noData"] = None
        self.assert_check([asset], [], base_options(), "nodata", "failed", "NODATA_MISSING")

    def test_categorical_bilinear_resampling_is_rejected(self) -> None:
        options = base_options()
        options.update({
            "classification": True,
            "categoricalResampling": "bilinear",
            "labelSchema": [{"value": "1", "label": "forest"}],
        })
        self.assert_check(
            [raster_asset("classes")],
            [],
            options,
            "categorical-resampling",
            "failed",
            "CATEGORICAL_RESAMPLING_INVALID",
        )

    def test_spatial_split_overlap_is_rejected(self) -> None:
        options = base_options()
        options["machineLearning"] = True
        splits = [
            split("train", "train", spatial="tile-shared", temporal="2024-01"),
            split("test", "test", spatial="tile-shared", temporal="2025-01"),
        ]
        self.assert_check([vector_asset()], splits, options, "spatial-leakage", "failed", "SPATIAL_LEAKAGE_DETECTED")

    def test_temporal_split_overlap_is_rejected(self) -> None:
        options = base_options()
        options["machineLearning"] = True
        splits = [
            split("train", "train", spatial="tile-a", temporal="2025-01"),
            split("test", "test", spatial="tile-b", temporal="2025-01"),
        ]
        self.assert_check([vector_asset()], splits, options, "temporal-leakage", "failed", "TEMPORAL_LEAKAGE_DETECTED")

    def assert_check(
        self,
        assets: list[dict[str, Any]],
        splits: list[dict[str, Any]],
        options: dict[str, Any],
        check_id: str,
        status: str,
        code: str,
    ) -> None:
        checks = {check["checkId"]: check for check in _dataset_checks(assets, splits, options)}
        self.assertEqual(checks[check_id]["mandatory"], True)
        self.assertEqual(checks[check_id]["status"], status)
        self.assertEqual(checks[check_id]["code"], code)


def artifact_ref(artifact_id: str) -> dict[str, str]:
    return {"artifactId": artifact_id, "digest": f"sha256:{'1' * 64}", "kind": "geotiff"}


def vector_asset() -> dict[str, Any]:
    return {
        "artifactRef": artifact_ref("vector-a"),
        "format": "GeoJSON",
        "width": None,
        "height": None,
        "featureCount": 2,
        "spatialExtent": [100, 20, 101, 21],
        "crs": {"authority": "EPSG:4326", "wktDigest": None, "axisOrder": ["Lat", "Lon"], "units": ["degree"]},
        "resolution": None,
        "transform": None,
        "bands": [],
        "fields": [],
    }


def raster_asset(artifact_id: str, transform: list[int] | None = None) -> dict[str, Any]:
    return {
        "artifactRef": artifact_ref(artifact_id),
        "format": "GTiff",
        "width": 10,
        "height": 10,
        "featureCount": None,
        "spatialExtent": [100, 100, 200, 200],
        "crs": {"authority": "EPSG:32650", "wktDigest": None, "axisOrder": ["E", "N"], "units": ["metre"]},
        "resolution": [10, 10],
        "transform": transform or [10, 0, 100, 0, -10, 200],
        "bands": [{
            "index": 1,
            "name": "class",
            "dataType": "uint8",
            "unit": None,
            "scale": 1,
            "offset": 0,
            "noData": 255,
            "colorInterpretation": "gray",
        }],
        "fields": [],
    }


def split(split_id: str, role: str, spatial: str, temporal: str) -> dict[str, Any]:
    return {
        "splitId": split_id,
        "role": role,
        "sampleIds": [f"sample-{split_id}"],
        "spatialUnitIds": [spatial],
        "sourceAssetDigests": [f"sha256:{split_id[0] * 64}"],
        "temporalKeys": [temporal],
    }


def base_options() -> dict[str, Any]:
    return {
        "machineLearning": False,
        "classification": False,
        "categoricalResampling": None,
        "labelSchema": [],
        "spatialStatistics": {
            "blockingStrategy": "spatial blocks",
            "autocorrelation": "Moran I",
            "multipleComparison": "Holm",
            "effectSize": "mean difference",
        },
    }


if __name__ == "__main__":
    unittest.main()
