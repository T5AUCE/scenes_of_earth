"""Keep verified country and EGDI geology names and their derived vocabulary sets."""

NO_DATA_NAMES = {"", " ", "unknown", "undifferentiated"}  # blank-ish names mean no data


CANADA_ERA_NAMES: dict[str, tuple[str, str] | None] = {
    "Cenozoic": ("Paleogene", "Quaternary"),
    "Mesozoic": ("Triassic", "Cretaceous"),
    "Mesozoic-Cenozoic": ("Triassic", "Quaternary"),
    "Paleozoic": ("Cambrian", "Permian"),
    "Paleozoic-Mesozoic": ("Cambrian", "Cretaceous"),
    "Precambrian": ("Archean", "Neoproterozoic"),
    "Precambrian-Mesozoic": ("Archean", "Cretaceous"),
    "Precambrian-Paleozoic": ("Archean", "Permian"),
}

CANADA_PERIOD_NAMES: dict[str, tuple[str, str] | None] = {
    "Archean": ("Archean", "Archean"),
    "Archean-Proterozoic": ("Archean", "Neoproterozoic"),
    "Cambrian": ("Cambrian", "Cambrian"),
    "Cambrian-Devonian": ("Cambrian", "Devonian"),
    "Cambrian-Ordovician": ("Cambrian", "Ordovician"),
    "Cambrian-Silurian": ("Cambrian", "Silurian"),
    "Carboniferous": ("Carboniferous", "Carboniferous"),
    "Carboniferous-Jurassic": ("Carboniferous", "Jurassic"),
    "Carboniferous-Permian": ("Carboniferous", "Permian"),
    "Cretaceous": ("Cretaceous", "Cretaceous"),
    "Cretaceous-Tertiary": ("Cretaceous", "Neogene"),
    "Devonian": ("Devonian", "Devonian"),
    "Devonian-Carboniferous": ("Devonian", "Carboniferous"),
    "Devonian-Cretaceous": ("Devonian", "Cretaceous"),
    "Devonian-Mississippian": ("Devonian", "Carboniferous"),
    "Devonian-Permian": ("Devonian", "Permian"),
    "Devonian-Triassic": ("Devonian", "Triassic"),
    "Jurassic": ("Jurassic", "Jurassic"),
    "Jurassic-Cretaceous": ("Jurassic", "Cretaceous"),
    "Mesoarchean": ("Archean", "Archean"),
    "Mesoarchean-Neoarchean": ("Archean", "Archean"),
    "Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "Mesoproterozoic-Neoproterozoic": ("Mesoproterozoic", "Neoproterozoic"),
    "Mississippian": ("Carboniferous", "Carboniferous"),
    "Mississippian-Jurassic": ("Carboniferous", "Jurassic"),
    "Mississippian-Permian": ("Carboniferous", "Permian"),
    "Mississippian-Triassic": ("Carboniferous", "Triassic"),
    "Neoarchean": ("Archean", "Archean"),
    "Neoarchean-Paleoproterozoic": ("Archean", "Paleoproterozoic"),
    "Neogene-Quaternary": ("Neogene", "Quaternary"),
    "Neoproterozoic": ("Neoproterozoic", "Neoproterozoic"),
    "Neoproterozoic-Cambrian": ("Neoproterozoic", "Cambrian"),
    "Neoproterozoic-Ordovician": ("Neoproterozoic", "Ordovician"),
    "Neoproterozoic-Paleozoic": ("Neoproterozoic", "Permian"),
    "Neoproterozoic-Silurian": ("Neoproterozoic", "Silurian"),
    "Neoproterozoic-Triassic": ("Neoproterozoic", "Triassic"),
    "Ordovician": ("Ordovician", "Ordovician"),
    "Ordovician-Devonian": ("Ordovician", "Devonian"),
    "Ordovician-Silurian": ("Ordovician", "Silurian"),
    "Ordovician-Triassic": ("Ordovician", "Triassic"),
    "Paleoarchean": ("Archean", "Archean"),
    "Paleoarchean-Neoarchean": ("Archean", "Archean"),
    "Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "Paleoproterozoic-Cambrian": ("Paleoproterozoic", "Cambrian"),
    "Paleoproterozoic-Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "Pennsylvanian": ("Carboniferous", "Carboniferous"),
    "Pennsylvanian-Permian": ("Carboniferous", "Permian"),
    "Permian": ("Permian", "Permian"),
    "Permian-Cretaceous": ("Permian", "Cretaceous"),
    "Permian-Jurassic": ("Permian", "Jurassic"),
    "Permian-Triassic": ("Permian", "Triassic"),
    "Quaternary": ("Quaternary", "Quaternary"),
    "Silurian": ("Silurian", "Silurian"),
    "Silurian-Devonian": ("Silurian", "Devonian"),
    "Tertiary": ("Paleogene", "Neogene"),
    "Triassic": ("Triassic", "Triassic"),
    "Triassic-Cretaceous": ("Triassic", "Cretaceous"),
    "Triassic-Jurassic": ("Triassic", "Jurassic"),
    "undivided Cenozoic": ("Paleogene", "Quaternary"),
    "undivided Paleozoic": ("Cambrian", "Permian"),
    "undivided Paleozoic-Mesozoic": ("Cambrian", "Cretaceous"),
    "undivided Precambrian": ("Archean", "Neoproterozoic"),
}

CANADA_EPOCH_NAMES: dict[str, tuple[str, str] | None] = {
    "Cenomanian-Santonian": ("Cretaceous", "Cretaceous"),
    "Maastrichtian-Campanian": ("Cretaceous", "Cretaceous"),
    "Miocene": ("Neogene", "Neogene"),
    "Neogene": ("Neogene", "Neogene"),
    "Oligocene": ("Paleogene", "Paleogene"),
    "Paleocene": ("Paleogene", "Paleogene"),
    "Paleogene": ("Paleogene", "Paleogene"),
    "Paleoproterozoic-early Cambrian": ("Paleoproterozoic", "Cambrian"),
    "Pleistocene": ("Quaternary", "Quaternary"),
    "Pliocene": ("Neogene", "Neogene"),
    "early Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "early Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "early-middle Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "early-middle Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "late Cretaceous": ("Cretaceous", "Cretaceous"),
    "late Jurassic": ("Jurassic", "Jurassic"),
    "late Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "late Mesoproterozoic-Neoproterozoic": ("Mesoproterozoic", "Neoproterozoic"),
    "late Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "late Paleoproterozoic-Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "late Paleoproterozoic-early Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "late Paleoproterozoic-middle Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "lower Cretaceous": ("Cretaceous", "Cretaceous"),
    "lower Devonian": ("Devonian", "Devonian"),
    "lower Jurassic": ("Jurassic", "Jurassic"),
    "lower Mississippian": ("Carboniferous", "Carboniferous"),
    "lower Ordovician": ("Ordovician", "Ordovician"),
    "lower Silurian": ("Silurian", "Silurian"),
    "lower-middle Devonian": ("Devonian", "Devonian"),
    "lower-middle Jurassic": ("Jurassic", "Jurassic"),
    "middle Cretaceous": ("Cretaceous", "Cretaceous"),
    "middle Devonian": ("Devonian", "Devonian"),
    "middle Jurassic": ("Jurassic", "Jurassic"),
    "middle Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "middle Ordovician": ("Ordovician", "Ordovician"),
    "middle Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "middle-late Jurassic": ("Jurassic", "Jurassic"),
    "middle-late Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "middle-late Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "middle-upper Devonian": ("Devonian", "Devonian"),
    "middle-upper Jurassic": ("Jurassic", "Jurassic"),
    "pre-Campanian": ("Cretaceous", "Cretaceous"),
    "undivided Archean": ("Archean", "Archean"),
    "undivided Archean-Proterozoic": ("Archean", "Neoproterozoic"),
    "undivided Cambrian": ("Cambrian", "Cambrian"),
    "undivided Cambrian-Devonian": ("Cambrian", "Devonian"),
    "undivided Cambrian-Ordovician": ("Cambrian", "Ordovician"),
    "undivided Cambrian-Silurian": ("Cambrian", "Silurian"),
    "undivided Carboniferous": ("Carboniferous", "Carboniferous"),
    "undivided Carboniferous-Permian": ("Carboniferous", "Permian"),
    "undivided Cenozoic": ("Paleogene", "Quaternary"),
    "undivided Cretaceous": ("Cretaceous", "Cretaceous"),
    "undivided Cretaceous-Tertiary": ("Cretaceous", "Neogene"),
    "undivided Devonian": ("Devonian", "Devonian"),
    "undivided Devonian-Carboniferous": ("Devonian", "Carboniferous"),
    "undivided Devonian-Cretaceous": ("Devonian", "Cretaceous"),
    "undivided Devonian-Mississippian": ("Devonian", "Carboniferous"),
    "undivided Devonian-Permian": ("Devonian", "Permian"),
    "undivided Devonian-Triassic": ("Devonian", "Triassic"),
    "undivided Jurassic": ("Jurassic", "Jurassic"),
    "undivided Jurassic-Cretaceous": ("Jurassic", "Cretaceous"),
    "undivided Mesoarchean": ("Archean", "Archean"),
    "undivided Mesoarchean-Neoarchean": ("Archean", "Archean"),
    "undivided Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "undivided Mesoproterozoic-Neoproterozoic": ("Mesoproterozoic", "Neoproterozoic"),
    "undivided Mesozoic": ("Triassic", "Cretaceous"),
    "undivided Mississippian": ("Carboniferous", "Carboniferous"),
    "undivided Mississippian-Jurassic": ("Carboniferous", "Jurassic"),
    "undivided Mississippian-Permian": ("Carboniferous", "Permian"),
    "undivided Mississippian-Triassic": ("Carboniferous", "Triassic"),
    "undivided Neoarchean": ("Archean", "Archean"),
    "undivided Neoarchean-Paleoproterozoic": ("Archean", "Paleoproterozoic"),
    "undivided Neogene-Quaternary": ("Neogene", "Quaternary"),
    "undivided Neoproterozoic": ("Neoproterozoic", "Neoproterozoic"),
    "undivided Neoproterozoic-Cambrian": ("Neoproterozoic", "Cambrian"),
    "undivided Neoproterozoic-Ordovician": ("Neoproterozoic", "Ordovician"),
    "undivided Neoproterozoic-Paleozoic": ("Neoproterozoic", "Permian"),
    "undivided Neoproterozoic-Silurian": ("Neoproterozoic", "Silurian"),
    "undivided Neoproterozoic-Triassic": ("Neoproterozoic", "Triassic"),
    "undivided Ordovician": ("Ordovician", "Ordovician"),
    "undivided Ordovician-Devonian": ("Ordovician", "Devonian"),
    "undivided Ordovician-Silurian": ("Ordovician", "Silurian"),
    "undivided Ordovician-Triassic": ("Ordovician", "Triassic"),
    "undivided Paleoarchean": ("Archean", "Archean"),
    "undivided Paleoarchean-Neoarchean": ("Archean", "Archean"),
    "undivided Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "undivided Paleoproterozoic-Mesoproterozoic": ("Paleoproterozoic", "Mesoproterozoic"),
    "undivided Paleoproterozoic-early Mesoproterozoic": (
        "Paleoproterozoic",
        "Mesoproterozoic",
    ),
    "undivided Paleozoic": ("Cambrian", "Permian"),
    "undivided Paleozoic-Mesozoic": ("Cambrian", "Cretaceous"),
    "undivided Pennsylvanian": ("Carboniferous", "Carboniferous"),
    "undivided Pennsylvanian-Permian": ("Carboniferous", "Permian"),
    "undivided Permian": ("Permian", "Permian"),
    "undivided Permian-Cretaceous": ("Permian", "Cretaceous"),
    "undivided Permian-Jurassic": ("Permian", "Jurassic"),
    "undivided Permian-Triassic": ("Permian", "Triassic"),
    "undivided Precambrian": ("Archean", "Neoproterozoic"),
    "undivided Quaternary": ("Quaternary", "Quaternary"),
    "undivided Silurian": ("Silurian", "Silurian"),
    "undivided Silurian-Devonian": ("Silurian", "Devonian"),
    "undivided Tertiary": ("Paleogene", "Neogene"),
    "undivided Triassic": ("Triassic", "Triassic"),
    "undivided Triassic-Jurassic": ("Triassic", "Jurassic"),
    "upper Cambrian": ("Cambrian", "Cambrian"),
    "upper Carboniferous-Jurassic": ("Carboniferous", "Jurassic"),
    "upper Cretaceous": ("Cretaceous", "Cretaceous"),
    "upper Devonian": ("Devonian", "Devonian"),
    "upper Jurassic": ("Jurassic", "Jurassic"),
    "upper Mississippian": ("Carboniferous", "Carboniferous"),
    "upper Ordovician": ("Ordovician", "Ordovician"),
    "upper Silurian": ("Silurian", "Silurian"),
}


CANADA_TYPE_NAMES: dict[str, str | None] = {
    "alkaline gabbro and syenite": "pb__",
    "alkaline intrusive rocks": "pi__",
    "alkaline volcanic rocks": "vb__",
    "anorthosite": "pb__",
    "bimodal alkaline volcanic rocks": "vi__",
    "bimodal volcanic rocks": "vi__",
    "carbonate": "scmx",
    "charnockite": "pa__",
    "coarse clastic sediments and alkaline volcanic rocks": "smss",
    "conglomerate and sandstone": "ssss",
    "evaporite": "ev__",
    "felsic and mafic intrusive rocks": "pa__",
    "felsic volcanic rocks": "va__",
    "felsic-intermediate volcanic rocks": "vi__",
    "felsite": "pa__",
    "gabbro-anorthosite": "pb__",
    "granodiorite, quartz diorite": "pi__",
    "intermediate volcanic rocks": "vi__",
    "mafic and ultramafic intrusive rocks": "pb__",
    "mafic gneiss": "mt__",
    "mafic intrusive rocks-diorite, gabbro": "pb__",
    "mafic volcanic rocks": "vb__",
    "marble": "mtpu",
    "medium-grade gneiss": "mt__",
    "melange": "mt__",
    "nonmarine sedimentary rocks": "ssmx",
    "oceanic mafic volcanic rocks": "vb__",
    "offshelf miogeoclinal rocks": "smmx",
    "orthogneiss": "mt__",
    "paragneiss": "mt__",
    "paragneiss-orthogneiss": "mt__",
    "quartz monzonite, granite": "pa__",
    "rapakivi granite": "pa__",
    "sedimentary and mafic volcanic rocks": "smmx",
    "sedimentary and volcanic gneiss": "mt__",
    "syenite, monzodiorite": "pi__",
    "syenitic gneiss": "mt__",
    "tonalite": "pa__",
    "two mica granite, diatexite": "pa__",
    "ultramafic intrusive rocks": "pb__",
    "ultramafic melange": "mt__",
    "undivided gneiss": "mt__",
    "undivided granitoid rocks": "pa__",
    "undivided sedimentary and volcanic rocks": "smmx",
    "undivided sedimentary rocks": "smmx",
    "undivided volcanic rocks": "py__",
    "volcanic gneiss": "mt__",
}

CANADA_RXTP_FALLBACK: dict[str, str | None] = {
    "intrusive rocks": None,
    "metamorphic rocks": "mt__",
    "sedimentary and volcanic rocks": "smmx",
    "sedimentary rocks": "smmx",
    "volcanic rocks": "py__",
}


# Orogeny names are judged from their mapped Ma ranges; Proterozoic I-III is the Harland-era split.
IGME_AGE_SIDES: dict[str, tuple[str, str] | None] = {
    "Alpine": ("Cretaceous", "Quaternary"),
    "Archean": ("Archean", "Archean"),
    "Cadomian": ("Neoproterozoic", "Cambrian"),
    "Caledonian": ("Ordovician", "Devonian"),
    "Cambrian": ("Cambrian", "Cambrian"),
    "Carboniferous": ("Carboniferous", "Carboniferous"),
    "Cenozoic": ("Paleogene", "Quaternary"),
    "Cretaceous": ("Cretaceous", "Cretaceous"),
    "Devonian": ("Devonian", "Devonian"),
    "Early Cambrian": ("Cambrian", "Cambrian"),
    "Early Carboniferous": ("Carboniferous", "Carboniferous"),
    "Early Cretaceous": ("Cretaceous", "Cretaceous"),
    "Early Devonian": ("Devonian", "Devonian"),
    "Early Jurassic": ("Jurassic", "Jurassic"),
    "Early Ordovician": ("Ordovician", "Ordovician"),
    "Early Silurian": ("Silurian", "Silurian"),
    "Early Triassic": ("Triassic", "Triassic"),
    "Eocene": ("Paleogene", "Paleogene"),
    "Holocene": ("Quaternary", "Quaternary"),
    "Jurassic": ("Jurassic", "Jurassic"),
    "Late Cambrian": ("Cambrian", "Cambrian"),
    "Late Carboniferous": ("Carboniferous", "Carboniferous"),
    "Late Cretaceous": ("Cretaceous", "Cretaceous"),
    "Late Devonian": ("Devonian", "Devonian"),
    "Late Jurassic": ("Jurassic", "Jurassic"),
    "Late Ordovician": ("Ordovician", "Ordovician"),
    "Late Permian": ("Permian", "Permian"),
    "Late Silurian": ("Silurian", "Silurian"),
    "Late Triassic": ("Triassic", "Triassic"),
    "Llandovery": ("Silurian", "Silurian"),
    "Mesozoic": ("Triassic", "Cretaceous"),
    "Middle Cambrian": ("Cambrian", "Cambrian"),
    "Middle Devonian": ("Devonian", "Devonian"),
    "Middle Jurassic": ("Jurassic", "Jurassic"),
    "Middle Ordovician": ("Ordovician", "Ordovician"),
    "Middle Permian": ("Permian", "Permian"),
    "Middle Triassic": ("Triassic", "Triassic"),
    "Miocene": ("Neogene", "Neogene"),
    "Neogene": ("Neogene", "Neogene"),
    "Oligocene": ("Paleogene", "Paleogene"),
    "Ordovician": ("Ordovician", "Ordovician"),
    "Palaeocene": ("Paleogene", "Paleogene"),
    "Palaeogene": ("Paleogene", "Paleogene"),
    "Palaeozoic": ("Cambrian", "Permian"),
    "Paleocene": ("Paleogene", "Paleogene"),
    "Permian": ("Permian", "Permian"),
    "Phanerozoic": ("Cambrian", "Quaternary"),
    "Pleistocene": ("Quaternary", "Quaternary"),
    "Pliocene": ("Neogene", "Neogene"),
    "Precambrian": ("Archean", "Neoproterozoic"),
    "Proterozoic": ("Paleoproterozoic", "Neoproterozoic"),
    "Proterozoic I": ("Paleoproterozoic", "Paleoproterozoic"),
    "Proterozoic II": ("Mesoproterozoic", "Mesoproterozoic"),
    "Proterozoic III": ("Neoproterozoic", "Neoproterozoic"),
    "Quaternary": ("Quaternary", "Quaternary"),
    "Silurian": ("Silurian", "Silurian"),
    "Triassic": ("Triassic", "Triassic"),
    "Variscan": ("Devonian", "Permian"),
    "Wenlock": ("Silurian", "Silurian"),
}


# Volcanites without a petrography count as basic like Precambrian greenstones, plutonites as acid.
IGME_TYPE_NAMES: dict[str, str | None] = {
    "Ice": "ig__",
    "Qtz andesite": "vi__",
    "agglomerate/breccia group": "pyss",
    "alkali basalt": "vb__",
    "ophiolite complex": "vb__",
    "alkali granite": "pa__",
    "alkali rhyolite": "va__",
    "alkali syenite": "pi__",
    "amphibolite": "mtam",
    "andesite": "vi__",
    "andesite agglomerate": "pyss",
    "andesite group": "vi__",
    "andesite tuff": "pysh",
    "andesite tuffite": "pysh",
    "anhydrite": "evpu",
    "basalt": "vb__",
    "basalt agglomerate": "pyss",
    "basalt group": "vb__",
    "basalt tuffite": "pysh",
    "blueschist": "mt__",
    "carbonates": "scmx",
    "carbonates, consolidated": "scmx",
    "chalk": "scpu",
    "chert": "sssh",
    "clay": "sush",
    "claystone": "sssh",
    "coal": "smor",
    "conglomerate": "ssss",
    "dacite": "va__",
    "diorite": "pi__",
    "dolerite": "vb__",
    "dolomite/dolostone": "scpu",
    "dunite, harzburgite, lherzolite": "pb__",
    "eclogite": "mt__",
    "essexite-theralite group": "pi__",
    "evaporites": "ev__",
    "gabbro": "pb__",
    "gabbro group": "pb__",
    "gneiss": "mt__",
    "granite": "pa__",
    "granite group": "pa__",
    "granodiorite": "pa__",
    "granodiorite-diorite group": "pi__",
    "granulite": "mt__",
    "gravel": "suss",
    "greenschist": "mtgr",
    "gypsum": "evpu",
    "gypsum, anhydrite": "evpu",
    "hawaiite": "vb__",
    "lamprophyre": "vb__",
    "latite": "vi__",
    "latite andesite": "vi__",
    "limestone": "scpu",
    "marble": "mtpu",
    "marl": "smsh",
    "marlstone": "smsh",
    "meta-andesite": "mt__",
    "meta-basalt": "mt__",
    "meta-basalt group": "mt__",
    "meta-basalt tuff": "mt__",
    "meta-carbonate": "mt__",
    "meta-claystone": "mt__",
    "meta-conglomerate": "mt__",
    "meta-dacite": "mt__",
    "meta-dolerite": "mt__",
    "meta-gabbro": "mt__",
    "meta-gabbro group": "mt__",
    "meta-granite": "mt__",
    "meta-granite group": "mt__",
    "meta-granodiorite": "mt__",
    "meta-limestone": "mt__",
    "meta-peridotite": "mt__",
    "meta-plutonic rock group": "mt__",
    "meta-rhyodacite": "mt__",
    "meta-rhyolite": "mt__",
    "meta-rhyolite group": "mt__",
    "meta-rhyolite tuffite": "mt__",
    "meta-sandstone": "mt__",
    "meta-sediment group": "mt__",
    "meta-tonalite": "mt__",
    "meta-tuffite group": "mt__",
    "meta-volcanic rock group": "mt__",
    "mica schist": "mt__",
    "migmatite/anatexite": "mt__",
    "miscellaneous metamorphic rock group": "mt__",
    "monzodiorite": "pi__",
    "monzonite": "pi__",
    "mud": "sush",
    "mudstone": "sssh",
    "mylonite": "mt__",
    "nephelinic, leucitic and analcitic rocks": "va__",
    "olivine basalt": "vb__",
    "peridotite": "pb__",
    "phonolite": "va__",
    "phonolitic tephrite, tephritic phonolite": "vb__",
    "phyllite": "mt__",
    "plutonic alkaline group": "pi__",
    "plutonic ultramafic group": "pb__",
    "pyroxenite": "pb__",
    "quartzite": "mtpu",
    "rhyodacite": "va__",
    "rhyolite": "va__",
    "rhyolite group": "va__",
    "rhyolite tuff": "pysh",
    "rhyolite tuffite": "pysh",
    "rock salt": "evpu",
    "sand": "suss",
    "sandstone": "ssss",
    "schist group": "mt__",
    "serpentinite": "mt__",
    "shale/slate": "sssh",
    "siliclastics, consolidated": "ssmx",
    "silt": "sush",
    "siltstone": "sssh",
    "siliceous ooze": "sush",
    "syenite": "pi__",
    "syenite-monzonite group": "pi__",
    "tephrite, basanite": "vb__",
    "theralite": "pi__",
    "tholeiitic basalt": "vb__",
    "tillite": "smmx",
    "tonalite": "pa__",
    "trachyte": "va__",
    "tuff group": "pysh",
    "tuffite group": "pysh",
    "volcanic alkaline group": "vb__",
    "volcanic ultramafic group": "vb__",
    "volcano-sediments": "smpy",
}

IGME_IGNE_FALLBACK: dict[str, str | None] = {
    "ophiolite complex": "vb__",
    "plutonite Cenozoic": "pa__",
    "plutonite Mesozoic": "pa__",
    "plutonite Palaeozoic": "pa__",
    "plutonite Precambrian": "pa__",
    "plutonite undifferentiated": "pa__",
    "volcanite Cenozoic": "vb__",
    "volcanite Mesozoic": "vb__",
    "volcanite Palaeozoic": "vb__",
    "volcanite Precambrian": "vb__",
    "volcanite Quaternary": "vb__",
    "volcanite undifferentiated": "vb__",
}

IGME_MARI_FALLBACK: dict[str, str | None] = {
    "break-up related basalt flows": "vb__",
    "ocean-continent transition of various ages": "smmx",
    "oceanic crust, older": "vb__",
    "oceanic crust, younger": "vb__",
    "rifted thinned continental crust of various ages": "smmx",
}


# Ages come from names and never from Ma, because the state maps use older time scales.
SGMC_BASE_NAMES: dict[str, tuple[str, str] | None] = {
    "Archean": ("Archean", "Archean"),
    "Cambrian": ("Cambrian", "Cambrian"),
    "Carboniferous": ("Carboniferous", "Carboniferous"),
    "Cenozoic": ("Paleogene", "Quaternary"),
    "Cretaceous": ("Cretaceous", "Cretaceous"),
    "Devonian": ("Devonian", "Devonian"),
    "Eocene": ("Paleogene", "Paleogene"),
    "Holocene": ("Quaternary", "Quaternary"),
    "Jurassic": ("Jurassic", "Jurassic"),
    "Mesoarchean": ("Archean", "Archean"),
    "Mesoproterozoic": ("Mesoproterozoic", "Mesoproterozoic"),
    "Mesozoic": ("Triassic", "Cretaceous"),
    "Miocene": ("Neogene", "Neogene"),
    "Mississippian": ("Carboniferous", "Carboniferous"),
    "Neoarchean": ("Archean", "Archean"),
    "Neogene": ("Neogene", "Neogene"),
    "Neoproterozoic": ("Neoproterozoic", "Neoproterozoic"),
    "Oligocene": ("Paleogene", "Paleogene"),
    "Ordovician": ("Ordovician", "Ordovician"),
    "Paleoarchean": ("Archean", "Archean"),
    "Paleocene": ("Paleogene", "Paleogene"),
    "Paleogene": ("Paleogene", "Paleogene"),
    "Paleoproterozoic": ("Paleoproterozoic", "Paleoproterozoic"),
    "Paleozoic": ("Cambrian", "Permian"),
    "Pennsylvanian": ("Carboniferous", "Carboniferous"),
    "Permian": ("Permian", "Permian"),
    "Phanerozoic": ("Cambrian", "Quaternary"),
    "Pleistocene": ("Quaternary", "Quaternary"),
    "Pliocene": ("Neogene", "Neogene"),
    "Proterozoic": ("Paleoproterozoic", "Neoproterozoic"),
    "Quaternary": ("Quaternary", "Quaternary"),
    "Silurian": ("Silurian", "Silurian"),
    "Tertiary": ("Paleogene", "Neogene"),
    "Tertiary-Neogene": ("Neogene", "Neogene"),
    "Tertiary-Paleogene": ("Paleogene", "Paleogene"),
    "Triassic": ("Triassic", "Triassic"),
    "preCambrian": ("Archean", "Neoproterozoic"),
    "preCambrian-Archean": ("Archean", "Archean"),
    "preCambrian-Proterozoic": ("Archean", "Neoproterozoic"),
}

# An Early, Middle or Late prefix narrows nothing because the class is the whole period anyway.
SGMC_STAGE_PERIODS: dict[str, str] = {
    "Aeronian": "Silurian",
    "Albian": "Cretaceous",
    "Anisian": "Triassic",
    "Aptian": "Cretaceous",
    "Aquitanian": "Neogene",
    "Artinskian": "Permian",
    "Asselian": "Permian",
    "Bajocian": "Jurassic",
    "Barremian": "Cretaceous",
    "Bartonian": "Paleogene",
    "Bashkirian": "Carboniferous",
    "Bathonian": "Jurassic",
    "Berriasian": "Cretaceous",
    "Burdigalian": "Neogene",
    "Calabrian": "Quaternary",
    "Callovian": "Jurassic",
    "Calymmian": "Mesoproterozoic",
    "Campanian": "Cretaceous",
    "Capitanian": "Permian",
    "Carnian": "Triassic",
    "Cenomanian": "Cretaceous",
    "Changhsingian": "Permian",
    "Chattian": "Paleogene",
    "Cisuralian": "Permian",
    "Coniacian": "Cretaceous",
    "Cryogenian": "Neoproterozoic",
    "Danian": "Paleogene",
    "Dapingian": "Ordovician",
    "Darriwillian": "Ordovician",
    "Ectasian": "Mesoproterozoic",
    "Ediacaran": "Neoproterozoic",
    "Eifelian": "Devonian",
    "Emsian": "Devonian",
    "Famennian": "Devonian",
    "Floian": "Ordovician",
    "Frasnian": "Devonian",
    "Furongian": "Cambrian",
    "Gelasian": "Quaternary",
    "Givetian": "Devonian",
    "Guadalupian": "Permian",
    "Gzhelian": "Carboniferous",
    "Hauterivian": "Cretaceous",
    "Hettangian": "Jurassic",
    "Hirnantian": "Ordovician",
    "Homerian": "Silurian",
    "Kasimovian": "Carboniferous",
    "Katian": "Ordovician",
    "Kimmeridgian": "Jurassic",
    "Kungurian": "Permian",
    "Ladinian": "Triassic",
    "Langhian": "Neogene",
    "Llandovery": "Silurian",
    "Lockhovian": "Devonian",
    "Lopingian": "Permian",
    "Ludlow": "Silurian",
    "Lutetian": "Paleogene",
    "Maastrichtian": "Cretaceous",
    "Messinian": "Neogene",
    "Moscovian": "Carboniferous",
    "Norian": "Triassic",
    "Olenikian": "Triassic",
    "Orosirian": "Paleoproterozoic",
    "Oxfordian": "Jurassic",
    "Piacenzian": "Neogene",
    "Pliensbachian": "Jurassic",
    "Pragian": "Devonian",
    "Priabonian": "Paleogene",
    "Pridoli": "Silurian",
    "Rhaetian": "Triassic",
    "Rhuddanian": "Silurian",
    "Roadian": "Permian",
    "Rupelian": "Paleogene",
    "Sakmarian": "Permian",
    "Sandbian": "Ordovician",
    "Santonian": "Cretaceous",
    "Selandian": "Paleogene",
    "Serpukhovian": "Carboniferous",
    "Serravallian": "Neogene",
    "Sheinwoodian": "Silurian",
    "Siderian": "Paleoproterozoic",
    "Sinemurian": "Jurassic",
    "Statherian": "Paleoproterozoic",
    "Stenian": "Mesoproterozoic",
    "Telychian": "Silurian",
    "Thanetian": "Paleogene",
    "Tithonian": "Jurassic",
    "Toarcian": "Jurassic",
    "Tonian": "Neoproterozoic",
    "Tortonian": "Neogene",
    "Tournaisian": "Carboniferous",
    "Tremadocian": "Ordovician",
    "Turonian": "Cretaceous",
    "Visean": "Carboniferous",
    "Wenlock": "Silurian",
    "Wordian": "Permian",
    "Wuchiapingian": "Permian",
    "Ypresian": "Paleogene",
    "Zanclean": "Neogene",
}


# Exact archive names keep invented substrings from matching real lithologies.
SGMC_EVAPORITE_PURE_NAMES = (
    "Anhydrite",
    "Gypsum",
    "Salt",
)
SGMC_EVAPORITE_NAMES = (
    "Evaporite",
)
SGMC_CARBONATE_CLASSES = {
    "Calcarenite": "scss",
    "Carbonate": "scmx",
    "Chalk": "scpu",
    "Coquina": "scss",
    "Coral": "scmx",
    "Dolostone": "scpu",
    "Limestone": "scpu",
}
SGMC_MIXED_FINE_NAMES = (
    "Marlstone",
)
SGMC_MIXED_NAMES = (
    "Mixed-clastic",
)
SGMC_COAL_NAMES = (
    "Anthracite",
    "Bituminous",
    "Coal",
    "Lignite",
    "Peat",
    "Sub-bituminous",
)
SGMC_SILICEOUS_NAMES = (
    "Chert",
    "Diatomite",
    "Novaculite",
)
SGMC_CLASTIC_COARSE_NAMES = (
    "Arenite",
    "Arkose",
    "Conglomerate",
    "Conglomerate-sandstone",
    "Graywacke",
    "Sandstone",
    "Sedimentary-breccia",
)
SGMC_CLASTIC_FINE_NAMES = (
    "Bentonite",
    "Black-shale",
    "Claystone",
    "Mudstone",
    "Oil-shale",
    "Phosphatic-shale",
    "Shale",
    "Siltstone",
    "Siltstone-mudstone",
)
SGMC_CLASTIC_MIXED_NAMES = (
    "Clastic",
    "Conglomerate-mudstone",
    "Sandstone-mudstone",
)
SGMC_CHEMICAL_OTHER_NAMES = (
    "Banded-iron-formation",
    "Phosphorite",
)
SGMC_SEDIMENTARY_GROUP_NAMES = (
    "Chemical",
)

SGMC_BASIC_NAMES = (
    "Anorthosite",
    "Basalt",
    "Basaltic-andesite",
    "Basanite",
    "Dunite",
    "Foidite",
    "Gabbro",
    "Gabbroic",
    "Hornblendite",
    "Hypabyssal-basalt",
    "Hypabyssal-basaltic-andesite",
    "Hypabyssal-mafic-alkaline",
    "Kimberlite",
    "Komatiite",
    "Lamprophyre",
    "Mafic-hypabyssal",
    "Mafic-volcanic",
    "Norite",
    "Peridotite",
    "Picrite",
    "Pyroxenite",
    "Quartz-gabbro",
    "Troctolite",
    "Ultramafic",
)
SGMC_INTERMEDIATE_NAMES = (
    "Alkali-feldspar-syenite",
    "Andesite",
    "Diorite",
    "Dioritic",
    "Felsic-hypabyssal",
    "Foid-syenite",
    "Foidal-syenitic",
    "Granodiorite",
    "Hypabyssal-andesite",
    "Hypabyssal-dacite",
    "Hypabyssal-felsic-alkaline",
    "Hypabyssal-latite",
    "Hypabyssal-quartz-latite",
    "Hypabyssal-quartz-trachyte",
    "Hypabyssal-rhyolite",
    "Hypabyssal-trachyte",
    "Latite",
    "Monzodiorite",
    "Monzonite",
    "Nepheline-syenite",
    "Quartz-alkali-feldspar-syenite",
    "Quartz-diorite",
    "Quartz-latite",
    "Quartz-monzodiorite",
    "Quartz-monzonite",
    "Quartz-syenite",
    "Quartz-trachyte",
    "Syenite",
    "Syenitic",
    "Trachyte",
)
SGMC_ACID_NAMES = (
    "Alaskite",
    "Alkali-feldspar-granite",
    "Alkali-granite",
    "Aplite",
    "Charnockite",
    "Dacite",
    "Felsic-volcanic",
    "Granite",
    "Granitic",
    "Leucocratic-granitic",
    "Monzogranite",
    "Pegmatite",
    "Phonolite",
    "Rhyolite",
    "Syenogranite",
    "Tonalite",
    "Trondhjemite",
)
SGMC_CARBONATITE_NAMES = (
    "Intrusive-carbonatite",
)
SGMC_IGNEOUS_GROUP_NAMES = (
    "Alkalic-volcanic",
    "Hypabyssal",
    "Plutonic",
    "Volcanic",
)

SGMC_METAMORPHIC_CLASSES = {
    "Amphibolite": "mtam",
    "Argillite": "mtsh",
    "Marble": "mtpu",
    "Quartzite": "mtpu",
    "Slate": "mtsh",
}
SGMC_METAMORPHIC_NAMES = (
    "Amphibole-schist",
    "Amphibolite",
    "Biotite-gneiss",
    "Biotite-schist",
    "Calc-silicate-gneiss",
    "Calc-silicate-rock",
    "Calc-silicate-schist",
    "Eclogite",
    "Gneiss",
    "Granoblastic",
    "Granofels",
    "Granulite",
    "Greenstone",
    "Hornblende-gneiss",
    "Hornfels",
    "Hydrothermally-altered",
    "Marble",
    "Metaandesite",
    "Metaanorthosite",
    "Metabasalt",
    "Metacarbonate",
    "Metaclastic",
    "Metaconglomerate",
    "Metadacite",
    "Metadiabase",
    "Metadiorite",
    "Metadunite",
    "Metagabbro",
    "Metagranite",
    "Metagraywacke",
    "Metaigneous",
    "Metaintrusive",
    "Metaperidotite",
    "Metapyroxenite",
    "Metarhyolite",
    "Metasandstone",
    "Metasedimentary",
    "Metasiltstone",
    "Metatonalite",
    "Metatrondhjemite",
    "Metaultramafic",
    "Metavolcanic",
    "Mica-schist",
    "Migmatite",
    "Muscovite-gneiss",
    "Muscovite-schist",
    "Orthogneiss",
    "Paragneiss",
    "Pelitic-schist",
    "Phyllite",
    "Quartz-feldspar-schist",
    "Quartzite",
    "Schist",
    "Serpentinite",
    "Skarn",
    "Spilite",
)
SGMC_UNCONSOLIDATED_COARSE_NAMES = (
    "Boulders",
    "Coarse-detrital",
    "Coral",
    "Gravel",
    "Sand",
)
SGMC_UNCONSOLIDATED_FINE_NAMES = (
    "Clay",
    "Fine-detrital",
    "Silt",
)
SGMC_UNCONSOLIDATED_ORGANIC_NAMES = (
    "Peat",
)
SGMC_UNCONSOLIDATED_MIXED_NAMES = (
    "Marl",
)
SGMC_TECTONITE_NAMES = (
    "Cataclasite",
    "Melange",
    "Mylonite",
    "Phyllonite",
)
SGMC_KNOWN_NAMES = frozenset(
    (
        *SGMC_EVAPORITE_PURE_NAMES,
        *SGMC_EVAPORITE_NAMES,
        *SGMC_CARBONATE_CLASSES,
        *SGMC_MIXED_FINE_NAMES,
        *SGMC_MIXED_NAMES,
        *SGMC_COAL_NAMES,
        *SGMC_SILICEOUS_NAMES,
        *SGMC_CLASTIC_COARSE_NAMES,
        *SGMC_CLASTIC_FINE_NAMES,
        *SGMC_CLASTIC_MIXED_NAMES,
        *SGMC_CHEMICAL_OTHER_NAMES,
        *SGMC_SEDIMENTARY_GROUP_NAMES,
        *SGMC_BASIC_NAMES,
        *SGMC_INTERMEDIATE_NAMES,
        *SGMC_ACID_NAMES,
        *SGMC_CARBONATITE_NAMES,
        *SGMC_IGNEOUS_GROUP_NAMES,
        *SGMC_METAMORPHIC_CLASSES,
        *SGMC_METAMORPHIC_NAMES,
        *SGMC_UNCONSOLIDATED_COARSE_NAMES,
        *SGMC_UNCONSOLIDATED_FINE_NAMES,
        *SGMC_UNCONSOLIDATED_ORGANIC_NAMES,
        *SGMC_UNCONSOLIDATED_MIXED_NAMES,
        *SGMC_TECTONITE_NAMES,
    ),
)
SGMC_LITH1_DEFAULTS: dict[str, str] = {
    "Ice": "ig__",
    "Igneous": "vi__",
    "Metamorphic": "mt__",
    "Sedimentary": "smmx",
    "Tectonite": "mt__",
    "Unconsolidated": "sumx",
}

# The Alaska map (USGS SIM 3340) shares the SGMC vocabulary, so these aliases map its other
# spellings onto SGMC names. Age leaves are classed by period when the SGMC tables lack the stage.
SIM3340_AGE_ALIASES: dict[str, str] = {
    "Aalenian": "Jurassic",
    "Ediacarian": "Ediacaran",
    "Gzelian": "Gzhelian",
    "Lockovian": "Lockhovian",
    "Olenekian": "Olenikian",
    "Rhuddian": "Rhuddanian",
    "Series 2": "Cambrian",
    "Valanginian": "Cretaceous",
}
SIM3340_LITHOLOGY_ALIASES: dict[str, str] = {
    "Cataclastite": "Cataclasite",
    "Chlorite-schist": "Schist",
    "Gabbronorite": "Gabbro",
    "Grainstone": "Limestone",
    "Lime-mudstone": "Limestone",
    "Lithic-wacke": "Graywacke",
    "Lithicarenite": "Arenite",
    "Melilitic": "Foidite",
    "Monzogabbro": "Gabbro",
    "Quartz-arenite": "Arenite",
    "Quartzose-sandstone": "Sandstone",
    "Red-shale": "Shale",
    "Sandstone-Mudstone": "Sandstone-mudstone",
    "Siltstone-Mudstone": "Siltstone-mudstone",
}

# GMNA qualifies ages with spaces where SGMC joins them with hyphens, so these spellings map across.
GMNA_AGE_ALIASES: dict[str, str] = {
    "Age unknown": "Undetermined",
    "Precambrian": "preCambrian",
    "Early Archean": "Early-Archean",
    "Middle Archean": "Middle-Archean",
    "Late Archean": "Late-Archean",
    "Early Proterozoic": "Early-Proterozoic",
    "Middle Proterozoic": "Middle-Proterozoic",
    "Late Proterozoic": "Late-Proterozoic",
    "Middle Cambrian": "Middle-Cambrian",
    "Upper Cambrian": "Late-Cambrian",
    "Early Cretaceous": "Early-Cretaceous",
    "Lower Cretaceous": "Early-Cretaceous",
    "Middle Cretaceous": "Middle-Cretaceous",
    "Mid-Cretaceous": "Middle-Cretaceous",
    "Late Cretaceous": "Late-Cretaceous",
    "Upper Cretaceous": "Late-Cretaceous",
    "Lower Devonian": "Early-Devonian",
    "Middle Devonian": "Middle-Devonian",
    "Upper Devonian": "Late-Devonian",
    "Lower Eocene": "Early-Eocene",
    "Middle Eocene": "Middle-Eocene",
    "Upper Eocene": "Late-Eocene",
    "Lower Jurassic": "Early-Jurassic",
    "Middle Jurassic": "Middle-Jurassic",
    "Late Jurassic": "Late-Jurassic",
    "Upper Jurassic": "Late-Jurassic",
    "Lower Mississippian": "Early-Mississippian",
    "Upper Mississippian": "Late-Mississippian",
    "Lower Ordovician": "Early-Ordovician",
    "Middle Ordovician": "Middle-Ordovician",
    "Upper Ordovician": "Late-Ordovician",
    "Lower Pennsylvanian": "Early-Pennsylvanian",
    "Upper Pennsylvanian": "Late-Pennsylvanian",
    "Lower Permian": "Early-Permian",
    "Upper Permian": "Late-Permian",
    "Lower Silurian": "Early-Silurian",
    "Upper Silurian": "Late-Silurian",
}

# A Pre- unit predates its bound but is otherwise undifferentiated, so each maps to its whole span.
GMNA_PRE_RANGES: dict[str, tuple[str, str]] = {
    "Pre-Cenozoic": ("Cretaceous", "Archean"),
    "Pre-Cenozoic undivided": ("Cretaceous", "Archean"),
    "Pre-Cretaceous": ("Jurassic", "Archean"),
    "Pre-Mesozoic": ("Permian", "Archean"),
}

# GMNA pairs one rock group with one lithology per unit, so each pair maps to one SGMC hierarchy.
GMNA_TYPE_HIERARCHIES: dict[tuple[str, str], tuple[str, str, str]] = {
    ("Ice", ""): ("Ice", "", ""),
    ("Metamorphic and undivided crystalline", ""): ("Metamorphic", "", ""),
    ("Metamorphic and undivided crystalline", "impact breccia"): ("Metamorphic", "", ""),
    ("Metamorphic and undivided crystalline", "mafic gneiss"): ("Metamorphic", "", "Gneiss"),
    ("Metamorphic and undivided crystalline", "mainly tonalite gneiss"): (
        "Metamorphic",
        "",
        "Metatonalite",
    ),
    ("Metamorphic and undivided crystalline", "marble"): ("Metamorphic", "", "Marble"),
    ("Metamorphic and undivided crystalline", "orthogneiss"): (
        "Metamorphic",
        "",
        "Orthogneiss",
    ),
    ("Metamorphic and undivided crystalline", "orthogneiss and paragneiss"): (
        "Metamorphic",
        "",
        "Gneiss",
    ),
    ("Metamorphic and undivided crystalline", "paragneiss"): (
        "Metamorphic",
        "",
        "Paragneiss",
    ),
    ("Metamorphic and undivided crystalline", "sedimentary and volcanic gneiss"): (
        "Metamorphic",
        "",
        "Gneiss",
    ),
    ("Metamorphic and undivided crystalline", "syenite gneiss"): (
        "Metamorphic",
        "",
        "Gneiss",
    ),
    (
        "Metamorphic and undivided crystalline",
        "undivided crystalline rocks (seafloor units may include a variety of metamorphosed rock)",
    ): ("Metamorphic", "", ""),
    ("Metamorphic and undivided crystalline", "undivided gneissic rocks"): (
        "Metamorphic",
        "",
        "Gneiss",
    ),
    ("Metamorphic and undivided crystalline", "volcanic gneiss"): (
        "Metamorphic",
        "",
        "Metavolcanic",
    ),
    ("Plutonic", "alkaline complex"): ("Igneous", "Plutonic", "Syenite"),
    ("Plutonic", "alkaline diorite gabbro and syenite"): ("Igneous", "Plutonic", "Syenite"),
    ("Plutonic", "anorthosite"): ("Igneous", "Plutonic", "Anorthosite"),
    ("Plutonic", "charnockite"): ("Igneous", "Plutonic", "Charnockite"),
    ("Plutonic", "diabase"): ("Igneous", "Plutonic", "Mafic-hypabyssal"),
    ("Plutonic", "early tonalite plutons in the Superior province"): (
        "Igneous",
        "Plutonic",
        "Tonalite",
    ),
    ("Plutonic", "felsic and intermediate rocks"): ("Igneous", "Plutonic", "Granodiorite"),
    ("Plutonic", "felsic and mafic rocks"): ("Igneous", "Plutonic", "Granite"),
    ("Plutonic", "felsite"): ("Igneous", "Plutonic", "Rhyolite"),
    ("Plutonic", "gabbro-anorthosite"): ("Igneous", "Plutonic", "Gabbro"),
    ("Plutonic", "granite"): ("Igneous", "Plutonic", "Granite"),
    ("Plutonic", "intermediate and mafic rocks"): ("Igneous", "Plutonic", "Diorite"),
    ("Plutonic", "intermediate rocks"): ("Igneous", "Plutonic", "Diorite"),
    ("Plutonic", "late felsic and intermediate plutons in the Superior province"): (
        "Igneous",
        "Plutonic",
        "Granodiorite",
    ),
    ("Plutonic", "mafic and ultramafic rocks"): ("Igneous", "Plutonic", "Ultramafic"),
    ("Plutonic", "mafic rocks"): ("Igneous", "Plutonic", "Gabbro"),
    ("Plutonic", "rapakivi granite"): ("Igneous", "Plutonic", "Granite"),
    ("Plutonic", "syenite, monzogranite"): ("Igneous", "Plutonic", "Syenite"),
    ("Plutonic", "tonalite"): ("Igneous", "Plutonic", "Tonalite"),
    ("Plutonic", "two-mica granite"): ("Igneous", "Plutonic", "Granite"),
    ("Plutonic", "ultramafic rocks"): ("Igneous", "Plutonic", "Ultramafic"),
    ("Plutonic", "undivided granitic rocks"): ("Igneous", "Plutonic", "Granitic"),
    ("Sedimentary", ""): ("Sedimentary", "", ""),
    ("Sedimentary", "carbonate"): ("Sedimentary", "Carbonate", ""),
    ("Sedimentary", "evaporite"): ("Sedimentary", "Chemical", "Evaporite"),
    ("Volcanic", "alkaline mafic and felsic rocks"): ("Igneous", "Volcanic", ""),
    ("Volcanic", "alkaline mafic and inter-mediate rocks"): ("Igneous", "Volcanic", ""),
    ("Volcanic", "alkaline mafic rocks"): ("Igneous", "Volcanic", "Basanite"),
    ("Volcanic", "alkaline rocks"): ("Igneous", "Volcanic", "Alkalic-volcanic"),
    ("Volcanic", "bimodal alkaline rocks"): ("Igneous", "Volcanic", ""),
    ("Volcanic", "bimodal rocks (mafic and alkaline mafic)"): (
        "Igneous",
        "Volcanic",
        "Mafic-volcanic",
    ),
    ("Volcanic", "felsic and intermediate rocks"): ("Igneous", "Volcanic", ""),
    ("Volcanic", "felsic and mafic rocks"): ("Igneous", "Volcanic", ""),
    ("Volcanic", "felsic rocks"): ("Igneous", "Volcanic", "Felsic-volcanic"),
    ("Volcanic", "interlayered sedimentary and alkaline volcanic rocks"): (
        "Sedimentary",
        "",
        "",
    ),
    ("Volcanic", "interlayered sedimentary and mafic volcanic rocks"): (
        "Sedimentary",
        "",
        "",
    ),
    ("Volcanic", "interlayered sedimentary and volcanic rocks"): ("Sedimentary", "", ""),
    ("Volcanic", "intermediate and mafic rocks"): ("Igneous", "Volcanic", ""),
    ("Volcanic", "intermediate rocks"): ("Igneous", "Volcanic", "Andesite"),
    ("Volcanic", "mafic rocks"): ("Igneous", "Volcanic", "Mafic-volcanic"),
    ("Volcanic", "undivided volcanic rocks"): ("Igneous", "Volcanic", ""),
}


# INSPIRE lithology classes of the EGDI raster by cell value; None leaves the cell to the base.
EGDI_TYPE_NAMES: dict[int, str | None] = {
    1: "vb__",  # alkaliOlivineBasalt
    2: "mtam",  # amphibolite
    3: "vi__",  # andesite
    4: "pb__",  # anorthositicRock
    5: "ssss",  # arenite
    6: "pymx",  # ashBrecciaBombOrBlockTephra
    7: "pymx",  # ashTuffLapillistoneAndLapilliTuff
    8: "vb__",  # basalt
    9: "vb__",  # basanite
    10: "sssh",  # biogenicSilicaSedimentaryRock
    11: "ssss",  # breccia
    12: "mt__",  # brecciaGougeSeries
    13: "sush",  # carbonateMud
    14: "sush",  # carbonateOoze
    15: "scmx",  # carbonateSedimentaryRock
    16: None,  # carbonatite
    17: "scpu",  # chalk
    18: "mtgr",  # chloriteActinoliteEpidoteMetamorphicRock
    19: "ssss",  # clasticSandstone
    20: "sumx",  # clasticSediment
    21: "smmx",  # clasticSedimentaryMaterial
    22: "ssmx",  # clasticSedimentaryRock
    23: "sush",  # clay
    24: "sssh",  # claystone
    25: "ssss",  # conglomerate
    26: "va__",  # dacite
    27: "smmx",  # diamictite
    28: "sumx",  # diamicton
    29: "pi__",  # diorite
    30: "pi__",  # dioriticRock
    31: "vb__",  # doleriticRock
    32: "scpu",  # dolomite
    33: "scmx",  # dolomiticOrMagnesianSedimentaryRock
    34: "mt__",  # eclogite
    35: None,  # exoticCompositionIgneousRock
    36: None,  # fineGrainedIgneousRock
    37: "pi__",  # foidBearingSyenite
    38: "pi__",  # foidSyenitoid
    39: "mt__",  # foliatedMetamorphicRock
    40: "pymx",  # fragmentalIgneousMaterial
    41: "pb__",  # gabbro
    42: "pb__",  # gabbroicRock
    43: "pb__",  # gabbroid
    44: "mt__",  # glaucophaneLawsoniteEpidoteMetamorphicRock
    45: "mt__",  # gneiss
    46: "pa__",  # granite
    47: "pa__",  # granitoid
    48: "pa__",  # granodiorite
    49: "mt__",  # granulite
    50: "suss",  # gravel
    51: "evpu",  # gypsumOrAnhydrite
    52: "mt__",  # hornfels
    53: None,  # igneousMaterial
    54: None,  # igneousRock
    55: None,  # impactGeneratedMaterial
    56: "sumx",  # impureCarbonateSediment
    57: "smmx",  # impureCarbonateSedimentaryRock
    58: "smmx",  # impureDolomite
    59: "smmx",  # impureLimestone
    60: "vb__",  # komatiiticRock
    61: "scpu",  # limestone
    62: "mtpu",  # marble
    63: "mt__",  # metamorphicRock
    64: "mt__",  # metasomaticRock
    65: "mt__",  # micaSchist
    66: "mt__",  # migmatite
    67: "pa__",  # monzogranite
    68: "pi__",  # monzonite
    69: "sush",  # mud
    70: "sssh",  # mudstone
    71: "mt__",  # myloniticRock
    72: "sssh",  # nonClasticSiliceousSedimentaryRock
    73: "sssh",  # organicBearingMudstone
    74: "suor",  # organicRichSediment
    75: "smor",  # organicRichSedimentaryMaterial
    76: "mt__",  # orthogneiss
    77: "mt__",  # paragneiss
    78: "suor",  # peat
    79: "pb__",  # peridotite
    80: None,  # phaneriticIgneousRock
    81: "va__",  # phonolite
    82: "mt__",  # phyllite
    83: "mt__",  # phyllonite
    84: None,  # porphyry
    85: "pymx",  # pyroclasticMaterial
    86: "pymx",  # pyroclasticRock
    87: "pb__",  # pyroxenite
    88: "pi__",  # quartzDiorite
    89: "mtpu",  # quartzite
    90: "sumx",  # residualMaterial
    91: "va__",  # rhyolite
    92: "va__",  # rhyolitoid
    93: None,  # rock
    94: "suss",  # sand
    95: "ssss",  # sandstone
    96: "mt__",  # schist
    97: "sumx",  # sediment
    98: "smmx",  # sedimentaryMaterial
    99: "smmx",  # sedimentaryRock
    100: "mt__",  # serpentinite
    101: "sssh",  # shale
    102: "sush",  # silicateMud
    103: "sush",  # silt
    104: "sssh",  # siltstone
    105: "mt__",  # skarn
    106: "mtsh",  # slate
    107: "vb__",  # spilite
    108: "pi__",  # syenite
    109: "pi__",  # syeniticRock
    110: "pa__",  # syenogranite
    111: "vb__",  # tephrite
    112: "vb__",  # tholeiiticBasalt
    113: "pa__",  # tonalite
    114: "va__",  # trachyte
    115: "va__",  # trachyticRock
    116: "va__",  # trachytoid
    117: "scpu",  # travertine
    118: "pymx",  # tuffBrecciaAgglomerateOrPyroclasticBreccia
    119: "pb__",  # ultramaficIgneousRock
    120: "ssss",  # wacke
    121: None,  # waste
    122: None,  # Unknown
    123: None,  # Unpopulated
}


