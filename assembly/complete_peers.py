#!/usr/bin/env python3
"""Complete a pnpm-deploy payload with peer packages npm would auto-install.

Walks every package.json under <payload>/node_modules, simulates Node resolution
of each declared peerDependency from the declaring directory, and copies any
missing peer from the harness workspace's node_modules (real files, junctions
materialized) into the payload top level so every dependent can resolve it.

Usage: python complete_peers.py <payload-dir> <harness-root>
Exit code 1 when some peer cannot be found in the workspace index.
"""
import json
import os
import shutil
import sys

INTERNAL_SCOPES = ("@deepseek-ai",)


def load_manifest(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None


def build_index(harness_root):
    """Map package name -> real source directory inside the harness install."""
    index = {}
    direct = os.path.join(harness_root, "node_modules")
    for scope in INTERNAL_SCOPES:
        scope_dir = os.path.join(direct, scope)
        if os.path.isdir(scope_dir):
            for name in os.listdir(scope_dir):
                candidate = os.path.join(scope_dir, name)
                if load_manifest(os.path.join(candidate, "package.json")):
                    index.setdefault(f"{scope}/{name}", candidate)
    pnpm = os.path.join(direct, ".pnpm")
    if os.path.isdir(pnpm):
        for entry in os.listdir(pnpm):
            store_node_modules = os.path.join(pnpm, entry, "node_modules")
            if not os.path.isdir(store_node_modules):
                continue
            for name in os.listdir(store_node_modules):
                candidate = os.path.join(store_node_modules, name)
                if name.startswith("@"):
                    # Scoped directory: descend one more level.
                    if not os.path.isdir(candidate):
                        continue
                    for sub in os.listdir(candidate):
                        sub_candidate = os.path.join(candidate, sub)
                        manifest = load_manifest(os.path.join(sub_candidate, "package.json"))
                        if manifest and manifest.get("name"):
                            index.setdefault(manifest["name"], sub_candidate)
                    continue
                manifest = load_manifest(os.path.join(candidate, "package.json"))
                if manifest and manifest.get("name"):
                    index.setdefault(manifest["name"], candidate)
    # Workspace source fallback: packages never installed anywhere (patch-only
    # entries like dsh-bash-local) resolve from their source tree, whose built
    # lib/ and dist/ artifacts ship alongside.
    for relative in (
        os.path.join("packages", "*", "*"),
        os.path.join("vendor", "*", "*"),
        os.path.join("vendor", "*"),
        os.path.join("apps", "*"),
        os.path.join("native", "landlock-run", "packages", "*"),
    ):
        import glob
        for candidate in glob.glob(os.path.join(harness_root, relative)):
            manifest = load_manifest(os.path.join(candidate, "package.json"))
            if manifest and manifest.get("name"):
                index.setdefault(manifest["name"], candidate)
    return index


def copy_real(src, dst):
    # NOTE: do NOT ignore "src" — shipped JS packages legitimately keep runtime
    # code under src/ (koffi ships src/koffi/index.js).
    shutil.copytree(
        src, dst,
        ignore=shutil.ignore_patterns(".git", "node_modules", "*.tsbuildinfo"),
        dirs_exist_ok=True,
    )

def main():
    payload, harness_root = sys.argv[1], sys.argv[2]
    top_node_modules = os.path.join(payload, "node_modules")
    index = build_index(harness_root)

    pending = {}
    for current, _directories, files in os.walk(top_node_modules):
        if "package.json" not in files:
            continue
        manifest = load_manifest(os.path.join(current, "package.json"))
        if not manifest:
            continue
        peers = manifest.get("peerDependencies") or {}
        for peer in peers:
            if not peer.startswith(INTERNAL_SCOPES):
                continue
            # Node resolution from the declaring package upward.
            satisfied = False
            probe = current
            while True:
                candidate = os.path.join(probe, "node_modules", peer, "package.json")
                if os.path.isfile(candidate):
                    satisfied = True
                    break
                if os.path.dirname(probe) == probe:
                    break
                probe = os.path.dirname(probe)
                if os.path.normpath(probe) == os.path.normpath(payload):
                    candidate = os.path.join(probe, "node_modules", peer, "package.json")
                    if os.path.isfile(candidate):
                        satisfied = True
                    break
            if not satisfied:
                pending[peer] = index.get(peer)

    missing = sorted(name for name, src in pending.items() if src is None)
    for name, src in sorted(pending.items()):
        if src is None:
            continue
        dst = os.path.join(top_node_modules, *name.split("/"))
        if os.path.exists(dst):
            continue
        copy_real(src, dst)
        print(f"hoisted {name}")

    # Loader entries resolve internal package NAMES at runtime (cordis.yml rows),
    # including packages that are merely devDependencies of the CLI and therefore
    # absent from a --prod deploy. Hoist every internal package the workspace
    # knows about so bare-name resolution always succeeds.
    hoisted_all = 0
    for name, src in sorted(index.items()):
        if not name.startswith(INTERNAL_SCOPES):
            continue  # unscoped workspace tooling (lint plugins etc.) is not loader-resolvable
        dst = os.path.join(top_node_modules, *name.split("/"))
        if os.path.exists(os.path.join(dst, "package.json")):
            continue
        copy_real(src, dst)
        hoisted_all += 1
    print(f"hoisted {hoisted_all} additional internal packages for name resolution")

    # Fixpoint pass: every package physically present under node_modules (deploy
    # output, hoisted sources) declares runtime deps; materialize any that are
    # missing from the pnpm store index so bare imports always resolve.
    for _pass in range(6):
        needed = {}
        for current, _directories, files in os.walk(top_node_modules):
            if "package.json" not in files:
                continue
            manifest = load_manifest(os.path.join(current, "package.json"))
            if not manifest:
                continue
            for section in ("dependencies", "peerDependencies"):
                for dep in (manifest.get(section) or {}):
                    if dep.startswith("node:"):
                        continue
                    dst = os.path.join(top_node_modules, *dep.split("/"))
                    if not os.path.isfile(os.path.join(dst, "package.json")) and dep not in needed:
                        needed[dep] = index.get(dep)
        missing = sorted(name for name, src in needed.items() if src is None)
        copied = 0
        for name, src in sorted(needed.items()):
            if src is None:
                continue
            copy_real(src, os.path.join(top_node_modules, *name.split("/")))
            copied += 1
        print(f"fixpoint pass {_pass}: copied {copied}, missing {missing or 'none'}")
        if copied == 0:
            break

    print(f"peers satisfied this pass; unresolved: {missing or 'none'}")
    if missing:
        sys.exit(1)


if __name__ == "__main__":
    main()
