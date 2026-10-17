"""Licence and attribution text, copied into every bundle (see bundle.py)."""

SOURCES = {
    "chirps": {
        "name": "CHIRPS v3.0 monthly",
        "version": "3.0",
        "licence": "CC BY 4.0",
        "licence_url": "http://creativecommons.org/licenses/by/4.0/",
        "attribution": "Rainfall: CHIRPS v3 (Climate Hazards Center, UC Santa Barbara)",
        "citation": (
            "Funk, C. et al. (2026) The Climate Hazards Center Infrared Precipitation with "
            "Stations, Version 3. Scientific Data 13, 718. doi:10.1038/s41597-026-07096-4; "
            "dataset doi:10.15780/G2JQ0P"
        ),
        "modified": (
            "negative fill values masked; block-mean aggregation when stated in the layer "
            "resolution"
        ),
    },
    "glo30": {
        "name": "Copernicus DEM GLO-30 Public",
        "version": "2021",
        "licence": "Copernicus WorldDEM™-30 licence (COP-DEM-GLO-30, Free & Open, Public)",
        "licence_url": (
            "https://dataspace.copernicus.eu/explore-data/data-collections/"
            "copernicus-contributing-missions/collections-description/COP-DEM"
        ),
        "attribution": (
            "produced using Copernicus WorldDEM™-30 © DLR e.V. 2010-2014 and "
            "© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS "
            "by the European Union and ESA; all rights reserved"
        ),
        "disclaimer": (
            "The organisations in charge of the Copernicus programme by law or by "
            "delegation do not incur any liability for any use of the Copernicus "
            "WorldDEM™-30"
        ),
        "disclaimer_required": True,
        "citation": "doi:10.5270/ESA-c5d3d65",
        "modified": (
            "elevation area-averaged onto the scene grid; hillshade (Horn, az 315°, alt 45°)"
        ),
    },
    "glo90": {
        "name": "Copernicus DEM GLO-90",
        "version": "2021",
        "licence": "Copernicus WorldDEM™-90 licence (COP-DEM-GLO-90-F, Full, Free & Open)",
        "licence_url": (
            "https://dataspace.copernicus.eu/explore-data/data-collections/"
            "copernicus-contributing-missions/collections-description/COP-DEM"
        ),
        "attribution": (
            "produced using Copernicus WorldDEM™-90 © DLR e.V. 2010-2014 and "
            "© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS "
            "by the European Union and ESA; all rights reserved"
        ),
        "disclaimer": (
            "The organisations in charge of the Copernicus programme by law or by "
            "delegation do not incur any liability for any use of the Copernicus "
            "WorldDEM™-90"
        ),
        "disclaimer_required": True,
        "citation": "doi:10.5270/ESA-c5d3d65",
        "modified": (
            "elevation area-averaged onto the scene grid; hillshade (Horn, az 315°, alt 45°)"
        ),
    },
    "geoBoundaries CGAZ": {
        "name": "geoBoundaries CGAZ",
        "licence": "CC BY 4.0",
        "licence_url": "https://www.geoboundaries.org/",
        "attribution": "Boundaries: geoBoundaries (https://www.geoboundaries.org)",
        "citation": (
            "Runfola, D. et al. (2020) geoBoundaries: A global database of political "
            "administrative boundaries. PLoS ONE 15(4): e0231866. "
            "https://doi.org/10.1371/journal.pone.0231866"
        ),
        "modified": "simplified 0.01°, clipped to 60°S-60°N",
    },
    "synthetic": {
        "name": "Sample areas",
        "licence": "per feature: Public Domain, ODbL 1.0 or CC BY 4.0 (geoBoundaries gbOpen)",
        "attribution": (
            "Sample outlines: geoBoundaries (https://www.geoboundaries.org), simplified"
        ),
    },
    "GHSL UCDB R2024A": {
        "name": "GHSL Urban Centre Database R2024A",
        "licence": "CC BY 4.0",
        "licence_url": "https://human-settlement.emergency.copernicus.eu/ghs_ucdb_2024.php",
        "attribution": "© European Union, 1995-2026, GHS-UCDB R2024A",
        "modified": "reprojected from Mollweide, simplified 0.01°, clipped to 60°S-60°N",
    },
}
