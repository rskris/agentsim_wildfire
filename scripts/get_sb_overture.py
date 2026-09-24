#!/usr/bin/env python3
"""
Download Overture Maps road segments and building footprints for
Santa Barbara County, split into study areas sized for the wildfire
egress simulator (each under 25 km across).

Setup (once):
    pip install overturemaps

Usage:
    python get_sb_overture.py                  # all study areas
    python get_sb_overture.py south_coast      # one area
    python get_sb_overture.py --list           # show areas and boxes
    python get_sb_overture.py --dry-run        # print commands only

Each area gets its own folder with segments.geojson, buildings.geojson,
landcover.geojson and landuse.geojson. Drop all four into the simulator.

Boxes are west, south, east, north. They include about 1-2 km of margin;
the simulator trims the edges and uses roads leaving the box as exits.
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

AREAS = {
    # Santa Barbara city, Riviera, Mission Canyon, Montecito, Summerland
    "south_coast":      (-119.78, 34.39, -119.56, 34.51),
    # Goleta, Isla Vista, Hope Ranch, western foothills
    "goleta":           (-119.95, 34.39, -119.73, 34.49),
    # Carpinteria, Summerland, eastern foothills to the county line
    "carpinteria":      (-119.62, 34.36, -119.44, 34.46),
    # Solvang, Buellton, Santa Ynez, Los Olivos, Ballard
    "santa_ynez":       (-120.27, 34.54, -120.04, 34.68),
    # Lompoc, Vandenberg Village, Mission Hills
    "lompoc":           (-120.55, 34.60, -120.38, 34.72),
    # Santa Maria, Orcutt, Guadalupe edge
    "santa_maria":      (-120.52, 34.83, -120.35, 34.99),
}
TYPES = {"segment": "segments.geojson", "building": "buildings.geojson",
         "land_cover": "landcover.geojson", "land_use": "landuse.geojson"}


def cmd_for(bbox, otype, out):
    return ["overturemaps", "download", "--no-stac",
            "--bbox=" + ",".join(str(v) for v in bbox),
            "-f", "geojson", "--type=" + otype, "-o", out]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("areas", nargs="*", help="area names (default: all)")
    ap.add_argument("--out", default="sb_overture", help="output folder (default: sb_overture)")
    ap.add_argument("--list", action="store_true", help="list areas and exit")
    ap.add_argument("--dry-run", action="store_true", help="print the commands without running them")
    ap.add_argument("--roads-only", action="store_true", help="download road segments only")
    ap.add_argument("--no-land", action="store_true", help="skip land cover and land use")
    a = ap.parse_args()

    if a.list:
        for k, b in AREAS.items():
            print(f"{k:14s} west={b[0]} south={b[1]} east={b[2]} north={b[3]}")
        return

    names = a.areas or list(AREAS)
    bad = [n for n in names if n not in AREAS]
    if bad:
        sys.exit(f"Unknown area(s): {', '.join(bad)}. Run with --list to see the options.")
    if not a.dry_run and not shutil.which("overturemaps"):
        sys.exit("The overturemaps tool isn't installed. Run: pip install overturemaps")

    types = {"segment": TYPES["segment"]} if a.roads_only else \
        {k: v for k, v in TYPES.items() if not (a.no_land and k.startswith("land"))}
    failures = []
    for n in names:
        folder = os.path.join(a.out, n)
        os.makedirs(folder, exist_ok=True)
        for otype, fname in types.items():
            out = os.path.join(folder, fname)
            c = cmd_for(AREAS[n], otype, out)
            print("$ " + " ".join(c))
            if a.dry_run:
                continue
            if os.path.exists(out) and os.path.getsize(out) > 0:
                print(f"  already have {out}, skipping")
                continue
            t = time.time()
            r = subprocess.run(c)
            if r.returncode != 0 or not os.path.exists(out):
                failures.append(out)
                print(f"  failed: {out}")
            else:
                print(f"  saved {out} ({os.path.getsize(out) / 1e6:.1f} MB, {time.time() - t:.0f} s)")

    if failures:
        sys.exit("Some downloads failed:\n  " + "\n  ".join(failures) + "\nRe-run the script to retry just those.")
    if not a.dry_run:
        print(f"\nDone. Drop all the .geojson files from one folder in {a.out}/ into the simulator.")


if __name__ == "__main__":
    main()
