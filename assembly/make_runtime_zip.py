#!/usr/bin/env python3
"""Zip the deployed consumer payload into the APK asset archive.

Walks the payload descending THROUGH Windows junctions/symlinks (pnpm deploy
leaves junctioned packages that plain os.walk skips, which would ship empty
directories), with a realpath cycle guard.

Usage: python make_runtime_zip.py <payload-dir> <out-zip> <file=entry-name>...
"""
import os
import sys
import zipfile


def iter_files(root):
    emitted = set()
    visited = set()
    stack = [root]
    while stack:
        current = stack.pop()
        real = os.path.realpath(current)
        if real in visited:
            continue
        visited.add(real)
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            path = entry.path
            if entry.is_dir():
                stack.append(path)
                continue
            real_file = os.path.realpath(path)
            if real_file in emitted:
                continue
            emitted.add(real_file)
            yield path


def main():
    payload_dir, out_zip = sys.argv[1], sys.argv[2]
    extras = []
    for pair in sys.argv[3:]:
        path, entry = pair.split("=", 1)
        extras.append((path, entry))
    written = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as target:
        for full in iter_files(payload_dir):
            rel = os.path.relpath(full, payload_dir).replace(os.sep, "/")
            target.write(full, rel)
            written += 1
        for path, entry in extras:
            target.write(path, entry)
            written += 1
    size = os.path.getsize(out_zip)
    print(f"{out_zip}: {written} entries, {size / (1 << 20):.0f} MB")


if __name__ == "__main__":
    main()
