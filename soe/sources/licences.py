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
            "negative fill values and values above 6553.4 mm/month masked; stored at 0.1 mm; "
            "block-mean aggregation when stated in the layer resolution"
        ),
    },
    "era5land": {
        "name": "ERA5-Land monthly averaged data from 1950 to present",
        "version": "ERA5-Land (2019)",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": (
            "Temperature: contains modified Copernicus Climate Change Service information "
            "2026 (ERA5-Land)"
        ),
        "disclaimer": (
            "Neither the European Commission nor ECMWF is responsible for any use that may "
            "be made of the Copernicus information or data it contains."
        ),
        "disclaimer_required": True,
        "citation": (
            "Muñoz Sabater, J. (2019): ERA5-Land monthly averaged data from 1950 to present. "
            "Copernicus Climate Change Service (C3S) Climate Data Store (CDS). "
            "doi:10.24381/cds.68d2bb30; Muñoz-Sabater, J. et al. (2021) Earth Syst. Sci. Data "
            "13, 4349-4383, doi:10.5194/essd-13-4349-2021"
        ),
        "modified": (
            "converted from K to °C; cropped to 60°S-60°N; block-mean aggregation when stated "
            "in the layer resolution; preliminary (ERA5-Land-T) months flagged"
        ),
    },
    "era5": {
        "name": "ERA5 monthly averaged data on single levels from 1940 to present",
        "version": "ERA5 (2023)",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": (
            "Temperature and rainfall gaps: contains modified Copernicus Climate Change Service "
            "information 2026 (ERA5)"
        ),
        "disclaimer": (
            "Neither the European Commission nor ECMWF is responsible for any use that may "
            "be made of the Copernicus information or data it contains."
        ),
        "disclaimer_required": True,
        "citation": (
            "Hersbach, H. et al. (2023): ERA5 monthly averaged data on single levels from 1940 "
            "to present. Copernicus Climate Change Service (C3S) Climate Data Store (CDS). "
            "doi:10.24381/cds.f17050d7; Hersbach, H. et al. (2020) Q. J. R. Meteorol. Soc. 146, "
            "1999-2049, doi:10.1002/qj.3803"
        ),
        "modified": (
            "converted from K to °C or from m per day to mm per month; cropped to 60°S-60°N; "
            "sampled at the centres of native layer cells where the main source has no value; "
            "block-mean aggregation when stated in the layer resolution; preliminary (ERA5T) "
            "months flagged"
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
            "area-averaged elevation percentiles and slope statistics at the stated cell size"
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
            "area-averaged elevation percentiles and slope statistics at the stated cell size; "
            "also fills source-tile gaps in GLO-30"
        ),
    },
    "mapterhorn": {
        "name": "Mapterhorn terrain tiles",
        "licence": (
            "open data, per-source licences (CC BY 4.0, public domain, Etalab 2.0, "
            "DL-DE BY 2.0 and others)"
        ),
        "licence_url": "https://mapterhorn.com/attribution",
        "attribution": (
            "Terrain shading and contours: © Mapterhorn (https://mapterhorn.com/attribution)"
        ),
        "modified": "shading and contours drawn in the viewer from the elevation tiles",
    },
    "worldcover": {
        "name": "ESA WorldCover 10 m 2021 v200",
        "version": "2021 v200",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": (
            "Land cover: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel "
            "data (2021) processed by ESA WorldCover consortium"
        ),
        "citation": (
            "Zanaga, D. et al. (2022) ESA WorldCover 10 m 2021 v200. doi:10.5281/zenodo.7254221"
        ),
        "modified": (
            "most common class per output cell from the COG overview with ≥16 source pixels "
            "per cell"
        ),
    },
    "lithology": {
        "name": "OpenLandMap lithology 250 m (USGS Global Ecosystem Map)",
        "version": "1.2",
        "licence": "CC BY-SA 4.0",
        "licence_url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "attribution": (
            "Rock type: OpenLandMap lithology, derived from the USGS Global Ecological Land Units "
            "and the GLiM lithology classes (CC BY-SA 4.0, ShareAlike)"
        ),
        "citation": (
            "Hengl, T. (2018) Global landform and lithology class at 250 m based on the USGS "
            "global ecosystem map. doi:10.5281/zenodo.1464846; Sayre, R. et al. (2014) A new "
            "map of global ecological land units. Global Ecology and Conservation 2; "
            "Hartmann, J. and Moosdorf, N. (2012) The new global lithological map database "
            "GLiM. Geochem. Geophys. Geosyst. 13, Q12004, doi:10.1029/2012GC004370"
        ),
        "modified": (
            "cropped to 60°S-60°N; water and undefined set to no data; faulty columns at "
            "±180° replaced by their inner neighbours; most common class per output cell"
        ),
    },
    "glim": {
        "name": "GLiM Global Lithological Map v1.0 (level 1 and 2)",
        "version": "glim-1.4",
        "licence": (
            "not stated by the authors; the data is for local evaluation only and must not "
            "be published until they confirm terms"
        ),
        "attribution": (
            "Rock type: GLiM, Hartmann and Moosdorf (2012); licence not stated by the authors, "
            "for local evaluation only"
        ),
        "citation": (
            "Hartmann, J. and Moosdorf, N. (2012) The new global lithological map database "
            "GLiM. Geochem. Geophys. Geosyst. 13, Q12004, doi:10.1029/2012GC004370"
        ),
        "modified": (
            "level 1 and level 2 codes rasterised to 1/480° from World Eckert IV; water bodies "
            "and no data set to no data; cropped to 60°S-60°N; most common class per output cell"
        ),
    },
    "gsc_world": {
        "name": "Generalized geology of the world (GSC Open File 5529)",
        "version": "of5529-2",
        "licence": "Open Government Licence - Canada 2.0",
        "licence_url": "https://open.canada.ca/en/open-government-licence-canada",
        "attribution": (
            "Geological age: Contains information licensed under the Open Government Licence – "
            "Canada (Chorlton 2007, GSC Open File 5529); colours: ICS chart via Macrostrat "
            "(CC BY 4.0)"
        ),
        "citation": (
            "Chorlton, L.B. (2007) Generalized geology of the world: bedrock domains and major "
            "faults in GIS format. Geological Survey of Canada Open File 5529. "
            "doi:10.4095/223767; ICS chart colours from Macrostrat, https://macrostrat.org "
            "(CC BY 4.0)"
        ),
        "modified": (
            "age names of each unit classed as the smallest ICS period or era that holds its "
            "whole age range; rasterised to 1/120° and cropped to 60°S-60°N; most common class "
            "per output cell"
        ),
    },
    "canada_5m": {
        "name": "Geological map of Canada 1:5M (GSC Map 1860A)",
        "version": "canada-5m-1",
        "licence": "Open Government Licence - Canada 2.0",
        "licence_url": "https://open.canada.ca/en/open-government-licence-canada",
        "attribution": (
            "Rock type and age (Canada): Contains information licensed under the Open "
            "Government Licence – Canada (Wheeler et al. 1996, GSC Map 1860A)"
        ),
        "citation": (
            "Wheeler, J.O. et al. (1996) Geological map of Canada, Map 1860A. Geological "
            "Survey of Canada. doi:10.4095/208175; geodatabase updated 2024-12"
        ),
        "modified": (
            "offshore polygons omitted; ages classed as the smallest ICS period or era that "
            "holds the whole range; rock types mapped to GLiM families; rasterised to the "
            "geology grids and cropped to 60°S-60°N; most common class per output cell"
        ),
    },
    "us_sgmc": {
        "name": "USGS State Geologic Map Compilation (SGMC) DS 1052 v1.1",
        "version": "sgmc-1.1-1",
        "licence": "Public domain (US Government work)",
        "attribution": "Rock type and age (conterminous US): USGS SGMC (public domain)",
        "citation": (
            "Horton, J.D. et al. (2017) The State Geologic Map Compilation (SGMC) "
            "geodatabase of the conterminous United States, U.S. Geological Survey Data "
            "Series 1052 v1.1"
        ),
        "modified": (
            "polygons read from the geodatabase joined to the CSV age and lithology tables "
            "on UNIT_LINK; first Major rank row per unit, then Indeterminate-major; ages "
            "classed as the smallest ICS period or era that holds the whole range; rock "
            "types mapped to GLiM families; rasterised to the geology grids"
        ),
    },
    "europe_igme5000": {
        "name": "IGME5000 1:5M (BGR/CGMW, pre-Quaternary bedrock)",
        "version": "igme5000-2024-1",
        "licence": "GeoNutzV (Datenlizenz Deutschland – Namensnennung)",
        "licence_url": "https://www.gesetze-im-internet.de/geonutzv/",
        "attribution": (
            "Rock type and age (Europe): BGR IGME5000 1:5,000,000 "
            "(GeoNutzV, source: BGR, Hannover)"
        ),
        "citation": (
            "Asch, K. (2003) The 1:5 Million International Geological Map of Europe and "
            "Adjacent Areas; 2024 BGR release under the Commission for the Geological Map "
            "of the World (CGMW)"
        ),
        "modified": (
            "pre-Quaternary bedrock kept as mapped; AgeName classed as the smallest ICS "
            "period or era that holds the whole range; rock types mapped to GLiM families "
            "where mappable, else left to the base map; rasterised to the geology grids"
        ),
    },
    "europe_egdi": {
        "name": "EGDI surface lithology 250 m (OpenGeoHub/GeoZS)",
        "version": "egdi-2024-1",
        "licence": "CC BY 4.0",
        "licence_url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": (
            "Rock type (Europe): EGDI/OneGeology surface lithology raster by "
            "OpenGeoHub/GeoZS (CC BY 4.0)"
        ),
        "citation": (
            "Isik, S., Minarik, R. and Hengl, T. (2024) Continental Europe surface "
            "lithology based on EGDI/OneGeology map at 1:1M scale. "
            "doi:10.5281/zenodo.12607973"
        ),
        "modified": (
            "original (non-gap-filled) raster reprojected from EPSG:3035 with mode "
            "resampling; INSPIRE lithology classes mapped to GLiM families"
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
