"""
Build the local datasets and textures used by Earth 3D.

Everything the app needs at runtime is generated into ./data and ./textures,
so the website never depends on an external API while it is running.

Sources (all public):
  - Natural Earth 1:50m Admin-0 countries      -> borders, label points, Vietnamese names
  - Natural Earth 1:50m populated places        -> cities (coordinates, population)
  - mledoze/countries (ODbL)                    -> capital, area, languages, currencies, region
  - World Bank API, indicator SP.POP.TOTL       -> latest population figures
  - three.js example textures (Solar System Scope, CC BY 4.0) -> day, night, clouds, relief

Usage (from the earth-3d folder):
    python scripts/build_data.py                 # download sources into scripts/.cache
    python scripts/build_data.py --cache DIR     # reuse already downloaded files
    python scripts/build_data.py --skip-textures # only rebuild JSON data

Requires Python 3.9+. Texture processing additionally needs Pillow and numpy.
"""

import argparse
import datetime as dt
import json
import os
import shutil
import sys
import unicodedata
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
TEX = "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r170/examples/textures/planets"
SOURCES = {
    "ne_50m_admin_0_countries.geojson": f"{NE}/ne_50m_admin_0_countries.geojson",
    "ne_50m_populated_places_simple.geojson": f"{NE}/ne_50m_populated_places_simple.geojson",
    "mledoze_countries.json": "https://raw.githubusercontent.com/mledoze/countries/master/countries.json",
    "wb_pop.json": "https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?mrnev=1&format=json&per_page=400",
    "earth_day_4096.jpg": f"{TEX}/earth_day_4096.jpg",
    "earth_night_4096.jpg": f"{TEX}/earth_night_4096.jpg",
    "earth_bump_roughness_clouds_4096.jpg": f"{TEX}/earth_bump_roughness_clouds_4096.jpg",
}

# Natural Earth uses a few codes that differ from ISO / mledoze / World Bank.
CODE_ALIASES = {
    # NE code: (mledoze cca3, World Bank code)
    "KOS": ("UNK", "XKX"),
}

# Cities the app must always contain (name or ASCII name, ISO3 of the country).
REQUIRED_CITIES = [
    ("Hanoi", "VNM"), ("Ho Chi Minh City", "VNM"), ("Da Nang", "VNM"),
    ("Tokyo", "JPN"), ("Osaka", "JPN"),
    ("New York", "USA"), ("Los Angeles", "USA"), ("San Francisco", "USA"),
    ("Paris", "FRA"), ("London", "GBR"), ("Beijing", "CHN"), ("Shanghai", "CHN"),
]


def fetch(cache, name):
    path = os.path.join(cache, name)
    if not os.path.exists(path):
        print(f"  downloading {name} ...")
        req = urllib.request.Request(SOURCES[name], headers={"User-Agent": "earth-3d-build"})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, "wb") as f:
            shutil.copyfileobj(r, f)
    return path


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path, data, compact=False):
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"  wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) / 1024:.0f} KB)")


def ne_code(p):
    """Best ISO 3166-1 alpha-3 code for a Natural Earth feature (-99 means 'not assigned')."""
    for key in ("ISO_A3", "ISO_A3_EH", "ADM0_A3"):
        v = p.get(key)
        if v and v != "-99":
            return v
    return None


def simplify_ring(ring, digits=2):
    """Round coordinates and drop consecutive duplicates (keeps the ring closed)."""
    out = []
    for lon, lat, *_ in ring:
        pt = [round(lon, digits), round(lat, digits)]
        if not out or out[-1] != pt:
            out.append(pt)
    if len(out) >= 2 and out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def simplify_geometry(geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    result = []
    for poly in polys:
        rings = [r for r in (simplify_ring(r) for r in poly) if r]
        if rings:
            result.append(rings)
    if not result:
        return None
    if len(result) == 1:
        return {"type": "Polygon", "coordinates": result[0]}
    return {"type": "MultiPolygon", "coordinates": result}


def continent_from_region(region, subregion):
    if region == "Americas":
        return "South America" if subregion == "South America" else "North America"
    if region == "Antarctic":
        return "Antarctica"
    return region


def build_countries(cache):
    print("Countries")
    ne = load_json(fetch(cache, "ne_50m_admin_0_countries.geojson"))
    meta = {c["cca3"]: c for c in load_json(fetch(cache, "mledoze_countries.json"))}
    wb_raw = load_json(fetch(cache, "wb_pop.json"))
    wb = {r["countryiso3code"]: r for r in wb_raw[1] if r.get("value") is not None}

    features, info, seen = [], {}, set()
    for f in ne["features"]:
        p = f["properties"]
        code = ne_code(p)
        if not code or code in seen:
            print(f"  ! skipped feature {p.get('ADMIN')} (code {code})")
            continue
        seen.add(code)
        geom = simplify_geometry(f["geometry"])
        if not geom:
            continue
        meta_code, wb_code = CODE_ALIASES.get(code, (code, code))
        m = meta.get(meta_code)
        w = wb.get(wb_code)

        name = m["name"]["common"] if m else p["NAME"]
        features.append({
            "type": "Feature",
            "properties": {
                "iso3": code,
                "name": name,
                "labelLat": round(p["LABEL_Y"], 3),
                "labelLon": round(p["LABEL_X"], 3),
                "labelRank": p["LABELRANK"],
            },
            "geometry": geom,
        })
        info[code] = make_info(code, name, m, w, p)
        if not m:
            print(f"  ! no capital/language/currency metadata for {p['ADMIN']} ({code})")

    # Countries / territories that are too small for the 1:50m map still get info
    # (search can fly to them using their official coordinates).
    for cca3, m in meta.items():
        if cca3 in info or cca3 in {v[0] for v in CODE_ALIASES.values()}:
            continue
        info[cca3] = make_info(cca3, m["name"]["common"], m, wb.get(cca3), None)

    write_json(os.path.join(ROOT, "data", "countries.geojson"), {
        "type": "FeatureCollection",
        "source": "Natural Earth 1:50m Admin-0 Countries (public domain), coordinates rounded to 0.01 deg",
        "features": features,
    }, compact=True)
    write_json(os.path.join(ROOT, "data", "countries.json"), {
        "generated": dt.date.today().isoformat(),
        "sources": {
            "metadata": "mledoze/countries (ODbL) - https://github.com/mledoze/countries",
            "population": "World Bank SP.POP.TOTL - https://data.worldbank.org/indicator/SP.POP.TOTL",
            "populationFallback": "Natural Earth POP_EST",
            "continent": "Natural Earth CONTINENT",
        },
        "countries": dict(sorted(info.items())),
    })
    return info


def make_info(code, name, m, w, p):
    entry = {"name": name}
    if m:
        entry.update({
            "official": m["name"]["official"],
            "cca2": m["cca2"],
            "flag": m.get("flag", ""),
            "capital": m.get("capital", []),
            "area": m.get("area"),
            "region": m.get("region"),
            "subregion": m.get("subregion"),
            "languages": list((m.get("languages") or {}).values()),
            "currencies": [
                {"code": k, "name": v.get("name"), "symbol": v.get("symbol")}
                for k, v in (m.get("currencies") or {}).items()
            ],
            "latlng": [round(x, 4) for x in m.get("latlng", [])],
            "continent": continent_from_region(m.get("region"), m.get("subregion")),
        })
    if p:
        entry["continent"] = p["CONTINENT"]
        if p.get("NAME_VI"):
            entry["nameVi"] = p["NAME_VI"]
        if not m:
            entry["official"] = p.get("FORMAL_EN") or p["NAME_LONG"]
            entry["latlng"] = [round(p["LABEL_Y"], 4), round(p["LABEL_X"], 4)]
    if w:
        entry["population"] = int(w["value"])
        entry["populationYear"] = int(w["date"])
        entry["populationSource"] = "World Bank"
    elif p and p.get("POP_EST", 0) > 0:
        entry["population"] = int(p["POP_EST"])
        entry["populationYear"] = int(p["POP_YEAR"])
        entry["populationSource"] = "Natural Earth estimate"

    aliases = set()
    if m:
        aliases.update(a for a in m.get("altSpellings", []) if len(a) > 2)
        aliases.add(m["name"]["official"])
    if p:
        aliases.update(x for x in (p.get("NAME"), p.get("NAME_LONG"), p.get("ADMIN"), p.get("NAME_VI")) if x)
    aliases.discard(name)
    entry["aliases"] = sorted(aliases)
    return entry


def simple_name(s):
    """Accent-free, lower-case name used to compare city names between datasets."""
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn").lower()
    return " ".join("".join(ch if ch.isalnum() else " " for ch in s).split())


def build_cities(cache, info):
    print("Cities")
    places = load_json(fetch(cache, "ne_50m_populated_places_simple.geojson"))
    capital_types = {
        "Admin-0 capital": "national",
        # Natural Earth's "capital alt" mixes official capitals (Dodoma, Porto-Novo) with
        # historic/secondary ones (Kyoto, Lagos): resolved against the country's capital list below.
        "Admin-0 capital alt": "alternate",
        "Admin-0 region capital": "regional", "Admin-1 capital": "regional",
        "Admin-1 region capital": "regional",
    }
    cities = []
    for f in places["features"]:
        p = f["properties"]
        iso3 = p["adm0_a3"]
        country = info.get(iso3, {}).get("name") or p["adm0name"]
        official_capitals = {simple_name(c) for c in info.get(iso3, {}).get("capital", [])}
        city = {
            "name": p["name"],
            "country": country,
            "iso3": iso3,
            "lat": round(p["latitude"], 4),
            "lon": round(p["longitude"], 4),
            "population": max(int(p["pop_max"] or 0), 0),
            "rank": int(p["scalerank"]),
        }
        if p["nameascii"] and p["nameascii"] != p["name"]:
            city["ascii"] = p["nameascii"]
        cap = capital_types.get(p["featurecla"])
        if cap == "alternate" and official_capitals & {simple_name(p["name"]), simple_name(p["nameascii"])}:
            cap = "national"
        if cap:
            city["capital"] = cap
        cities.append(city)

    alternates = [c["name"] for c in cities if c.get("capital") == "alternate"]
    print(f"  {sum(c.get('capital') == 'national' for c in cities)} national capitals; alternate capitals: {', '.join(alternates)}")
    cities.sort(key=lambda c: (c["rank"], -c["population"]))
    for name, iso3 in REQUIRED_CITIES:
        ok = any(c["iso3"] == iso3 and name in (c["name"], c.get("ascii")) for c in cities)
        print(f"  {'ok ' if ok else 'MISSING'} {name} ({iso3})")
        if not ok:
            sys.exit(f"Required city {name} not found in Natural Earth data")

    write_json(os.path.join(ROOT, "data", "cities.json"), {
        "generated": dt.date.today().isoformat(),
        "source": "Natural Earth 1:50m Populated Places (public domain). rank = Natural Earth scalerank (0 = most important).",
        "cities": cities,
    })


def build_textures(cache):
    print("Textures")
    import numpy as np
    from PIL import Image, ImageFilter

    out = os.path.join(ROOT, "textures")
    shutil.copyfile(fetch(cache, "earth_day_4096.jpg"), os.path.join(out, "earth.jpg"))
    shutil.copyfile(fetch(cache, "earth_night_4096.jpg"), os.path.join(out, "night.jpg"))

    # R = relief (height), G = roughness (land rough / ocean smooth), B = clouds
    packed = Image.open(fetch(cache, "earth_bump_roughness_clouds_4096.jpg")).convert("RGB")
    height, rough, clouds = packed.split()
    size = (2048, 1024)

    clouds.resize(size, Image.LANCZOS).save(os.path.join(out, "clouds.png"), optimize=True)

    # Ocean mask for specular reflections: smooth surfaces (ocean, lakes) = white.
    spec = Image.eval(rough.resize(size, Image.LANCZOS), lambda v: 255 - v)
    spec.save(os.path.join(out, "earth-specular.jpg"), quality=88)

    # Tangent-space normal map derived from the relief channel (R = east, G = north).
    # A light blur removes JPEG block noise that would otherwise show up as ripples on the ocean.
    relief = height.resize(size, Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.5))
    h = np.asarray(relief, dtype=np.float32) / 255.0
    strength = 12.0
    dx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dy = np.zeros_like(h)
    dy[1:-1] = (h[2:] - h[:-2]) * 0.5  # image rows go south, tangent 'north' is -row
    nx, ny, nz = -dx * strength, dy * strength, np.ones_like(h)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([nx / length, ny / length, nz / length], axis=-1)
    rgb = ((normal * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8)
    Image.fromarray(rgb, "RGB").save(os.path.join(out, "earth-normal.jpg"), quality=90)

    for name in ("earth.jpg", "night.jpg", "clouds.png", "earth-normal.jpg", "earth-specular.jpg"):
        path = os.path.join(out, name)
        print(f"  wrote textures/{name} ({os.path.getsize(path) / 1024:.0f} KB)")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", default=os.path.join(ROOT, "scripts", ".cache"))
    ap.add_argument("--skip-textures", action="store_true")
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "textures"), exist_ok=True)

    info = build_countries(args.cache)
    build_cities(args.cache, info)
    if not args.skip_textures:
        build_textures(args.cache)
    print("Done.")


if __name__ == "__main__":
    main()
