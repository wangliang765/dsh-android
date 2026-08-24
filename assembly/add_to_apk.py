#!/usr/bin/env python3
"""Copy one zip into a new zip, appending extra entries.

Usage: python add_to_apk.py <src.apk> <dst.apk> <entry-name>=<file> [more...]
Existing entries keep their original compression; new entries are DEFLATED
(legal for native libs because the manifest sets extractNativeLibs=true).
"""
import sys
import zipfile


def main():
    src, dst = sys.argv[1], sys.argv[2]
    additions = []
    for pair in sys.argv[3:]:
        name, path = pair.split("=", 1)
        additions.append((name, path))
    with zipfile.ZipFile(src) as source, zipfile.ZipFile(dst, "w") as target:
        for info in source.infolist():
            if info.filename in {name for name, _ in additions}:
                raise SystemExit(f"entry already exists: {info.filename}")
            target.writestr(info, source.read(info.filename))
        for name, path in additions:
            with open(path, "rb") as handle:
                target.writestr(name, handle.read(), zipfile.ZIP_DEFLATED)


if __name__ == "__main__":
    main()
