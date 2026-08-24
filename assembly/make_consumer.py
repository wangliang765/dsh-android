#!/usr/bin/env python3
"""Write a consumer package.json whose dependencies map every packed internal
tarball by file: URL (the InstalledBundleSmoke shape).

Usage: python make_consumer.py <tarballs-dir> <out-package-json>
"""
import json
import os
import pathlib
import sys
import tarfile


def main():
    tarballs_dir, out_path = sys.argv[1], sys.argv[2]
    dependencies = {}
    for name in sorted(os.listdir(tarballs_dir)):
        if not name.endswith(".tgz"):
            continue
        path = os.path.join(tarballs_dir, name)
        with tarfile.open(path, "r:gz") as tar:
            member = tar.extractfile("package/package.json")
            manifest = json.loads(member.read().decode("utf-8"))
        pkg_name = manifest["name"]
        if pkg_name in dependencies:
            raise SystemExit(f"duplicate package name across tarballs: {pkg_name}")
        dependencies[pkg_name] = pathlib.Path(path).resolve().as_uri()
    consumer = {
        "name": "dsh-android-payload",
        "version": "0.0.0",
        "private": True,
        "dependencies": dependencies,
    }
    with open(out_path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(consumer, handle, indent=2)
        handle.write("\n")
    print(f"consumer manifest with {len(dependencies)} file deps -> {out_path}")


if __name__ == "__main__":
    main()
