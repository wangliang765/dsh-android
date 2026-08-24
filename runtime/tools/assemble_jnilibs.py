#!/usr/bin/env python3
"""Assemble the minimal node runtime into an Android jniLibs directory.

Pipeline:
  1. Inventory real ELFs + symlinks in the extracted termux sysroot.
  2. Index providers by DT_SONAME (fallback: filename and symlink aliases).
  3. BFS from the node binary over DT_NEEDED to get the minimal runtime closure.
  4. Rename every file to a `lib<name>.so` shape by shortening version suffixes
     (e.g. libcrypto.so.3 -> libcrypto.so) and patching DT_NEEDED/DT_SONAME
     strings in place inside .dynstr (shorter + NUL padding, offsets preserved).
  5. Copy patched files into the output dir and emit a manifest.

Also stages the CA bundle next to the output as `ca-cert.pem` for SSL_CERT_FILE.

Usage:
  python assemble_jnilibs.py --sysroot <dir> --node-pkg <pkg-name> --out <dir>
"""
import argparse
import json
import os
import struct
import sys

from elfcheck import SYSTEM_SONAMES, parse_elf, walk_nofollow

SHT_DYNAMIC = 6
SHT_STRTAB = 3
DT_NEEDED = 1
DT_SONAME = 14


def read_cstr(buf, offset):
    end = buf.find(b"\x00", offset)
    return buf[offset:end].decode("utf-8", "replace")


def dyn_strings(path):
    """Return {tag: [offsets]} into .dynstr for DT_NEEDED/DT_SONAME plus the dynstr bytes."""
    with open(path, "rb") as handle:
        ident = handle.read(64)
        if ident[:4] != b"\x7fELF" or ident[4] != 2:
            raise SystemExit(f"not ELF64: {path}")
        e_shoff, = struct.unpack_from("<Q", ident, 40)
        e_shentsize, e_shnum = struct.unpack_from("<HH", ident, 58)
        handle.seek(e_shoff)
        shdrs_blob = handle.read(e_shentsize * e_shnum)
        shdrs = []
        for i in range(e_shnum):
            base = i * e_shentsize
            _name, sh_type = struct.unpack_from("<II", shdrs_blob, base)
            _addr, sh_offset, sh_size = struct.unpack_from("<QQQ", shdrs_blob, base + 16)
            link, = struct.unpack_from("<I", shdrs_blob, base + 40)
            shdrs.append({"type": sh_type, "offset": sh_offset, "size": sh_size, "link": link})
        dyn = next((s for s in shdrs if s["type"] == SHT_DYNAMIC), None)
        if dyn is None:
            return None
        strtab = shdrs[dyn["link"]]
        assert strtab["type"] == SHT_STRTAB, "dynamic strtab link"
        handle.seek(dyn["offset"])
        dynblob = handle.read(dyn["size"])
        refs = {DT_NEEDED: [], DT_SONAME: []}
        for off in range(0, len(dynblob) - 15, 16):
            tag, val = struct.unpack_from("<qQ", dynblob, off)
            if tag == 0:
                break
            if tag in refs:
                refs[tag].append(val)
        handle.seek(strtab["offset"])
        strtab_bytes = handle.read(strtab["size"])
        return {"refs": refs, "strtab": strtab_bytes, "strtab_offset": strtab["offset"]}


def patch_dynstr(path, renames):
    """Shorten DT_NEEDED/DT_SONAME strings in place; return list of (old, new) applied."""
    meta = dyn_strings(path)
    if meta is None:
        return []
    applied = []
    blob = bytearray()
    with open(path, "rb") as handle:
        blob = bytearray(handle.read())
    strtab = meta["strtab"]
    strtab_offset = meta["strtab_offset"]
    for tag in (DT_NEEDED, DT_SONAME):
        for val in meta["refs"][tag]:
            old = read_cstr(strtab, val)
            new = renames.get(old)
            if new is None or new == old:
                continue
            if not old.startswith(new) or len(new) >= len(old):
                raise SystemExit(f"{path}: rename {old!r}->{new!r} must be a strict shortening")
            absolute = strtab_offset + val
            # Replace exactly old + its NUL terminator: same total length, offsets stable.
            patched = new.encode() + b"\x00" * (len(old) + 1 - len(new))
            assert len(patched) == len(old) + 1
            blob[absolute:absolute + len(old) + 1] = patched
            applied.append((old, new))
    with open(path, "r+b") as handle:
        handle.write(blob)
    if applied:
        if dyn_strings(path) is None:
            raise SystemExit(f"{path}: dynamic section unreadable after patch (size drifted?)")
    return applied


def shorten_soname(name):
    """libcrypto.so.3 -> libcrypto.so ; libz.so.1.3.2 -> libz.so ; node -> libnode_dsh.so."""
    if ".so." in name:
        return name[:name.index(".so.") + 3]
    if name == "node":
        return "libnode_dsh.so"
    if name.endswith(".so") and name.startswith("lib"):
        return name
    raise SystemExit(f"no shortening rule for soname/file: {name}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sysroot", required=True)
    parser.add_argument("--node-pkg", default="nodejs-lts")
    parser.add_argument("--out", required=True)
    parser.add_argument("--machine", type=int, default=183,
                        help="required ELF e_machine: 183=aarch64, 62=x86_64")
    parser.add_argument("--seed", action="append", default=[],
                        metavar="PKG:RELPATH:OUTNAME",
                        help="extra executable to ship alongside node, e.g. "
                             "bash:data/data/com.termux/files/usr/bin/bash:libbash.so")
    args = parser.parse_args()

    root = os.path.abspath(args.sysroot)
    real_files = []  # (abs_path, pkg, basename, elf_info)
    symlink_aliases = {}  # basename -> real basename
    for pkg_dir in sorted(os.listdir(root)):
        pkg_path = os.path.join(root, pkg_dir)
        if not os.path.isdir(pkg_path):
            continue
        for dirpath, filenames in walk_nofollow(pkg_path):
            for name in filenames:
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, root)
                if os.path.islink(path):
                    target = os.path.basename(os.readlink(path))
                    symlink_aliases[name] = target
                    continue
                info = parse_elf(path)
                if info and info.get("machine") == args.machine:
                    real_files.append({"path": path, "pkg": pkg_dir, "name": name, "info": info})

    by_name = {entry["name"]: entry for entry in real_files}

    def resolve(soname):
        """Provider lookup: DT_SONAME match, then filename, then symlink alias."""
        for entry in real_files:
            if entry["info"].get("needed") is not None and soname in entry["info"].get("sonames", []):
                return entry
        if soname in by_name:
            return by_name[soname]
        alias = symlink_aliases.get(soname)
        if alias and alias in by_name:
            return by_name[alias]
        return None

    # DT_SONAME index (elfcheck does not collect SONAME; do it here).
    sonames_by_file = {}
    for entry in real_files:
        meta = dyn_strings(entry["path"])
        names = []
        if meta:
            for val in meta["refs"][DT_SONAME]:
                names.append(read_cstr(meta["strtab"], val))
        sonames_by_file[entry["path"]] = names

    def resolve_by_soname(soname):
        for entry in real_files:
            if soname in sonames_by_file[entry["path"]]:
                return entry
        return resolve(soname)

    node_entry = next(e for e in real_files if e["pkg"] == args.node_pkg and e["name"] == "node")

    seeds = [node_entry]
    for seed_spec in args.seed:
        pkg, relpath, outname = seed_spec.split(":", 2)
        seed_path = os.path.normpath(os.path.join(root, pkg, relpath))
        if not os.path.isfile(seed_path):
            raise SystemExit(f"seed not found: {seed_path}")
        info = parse_elf(seed_path)
        if info is None or info.get("machine") != args.machine:
            raise SystemExit(f"seed is not the target architecture ELF: {seed_path}")
        if not outname.startswith("lib") or not outname.endswith(".so"):
            raise SystemExit(f"seed OUTNAME must match lib*.so: {outname}")
        seeds.append({"path": seed_path, "pkg": pkg, "name": os.path.basename(relpath), "info": info})

    closure = {}
    queue = list(seeds)
    while queue:
        entry = queue.pop(0)
        if entry["path"] in closure:
            continue
        closure[entry["path"]] = entry
        for needed in entry["info"]["needed"]:
            if needed in SYSTEM_SONAMES:
                continue
            provider = resolve_by_soname(needed)
            if provider is None:
                raise SystemExit(f"unresolved runtime dependency: {needed} (needed by {entry['name']})")
            queue.append(provider)

    # Rename plan: every shipped name -> unique lib*.so.
    renames = {}
    used = set()
    plan = []
    seed_outnames = {seed["path"]: spec.split(":", 2)[2] for seed, spec in zip(seeds[1:], args.seed)}
    for path, entry in closure.items():
        source_name = entry["name"]
        for soname in sonames_by_file[path]:
            renames.setdefault(soname, shorten_soname(soname))
        target = seed_outnames.get(path) or shorten_soname(source_name)
        if target in used:
            raise SystemExit(f"rename collision on {target}")
        used.add(target)
        renames.setdefault(source_name, target)
        plan.append({"source": os.path.relpath(entry["path"], root), "pkg": entry["pkg"],
                     "name": source_name, "out": target})
    plan.sort(key=lambda item: item["out"])

    os.makedirs(args.out, exist_ok=True)
    print(f"{'out':24} {'size':>10}  source")
    manifest = []
    for item in plan:
        source = os.path.join(root, item["source"])
        target_path = os.path.join(args.out, item["out"])
        with open(source, "rb") as handle:
            data = handle.read()
        with open(target_path, "wb") as handle:
            handle.write(data)
        applied = patch_dynstr(target_path, renames)
        import hashlib
        sha256 = hashlib.sha256(open(target_path, "rb").read()).hexdigest()
        manifest.append({**item, "sha256": sha256, "patched": sorted({f"{o}->{n}" for o, n in applied})})
        print(f"{item['out']:24} {len(data):>10,}  {item['source']}"
              f"  patched:{len(applied)}")

    # CA bundle for SSL_CERT_FILE.
    cert_candidates = []
    for dirpath, filenames in walk_nofollow(os.path.join(root, "ca-certificates")):
        for name in filenames:
            if name in ("cert.pem", "ca-certificates.crt", "tls-ca-bundle.pem"):
                cert_candidates.append(os.path.join(dirpath, name))
    if cert_candidates:
        import shutil
        cert_source = sorted(cert_candidates, key=len)[0]
        shutil.copyfile(cert_source, os.path.join(args.out, "..", "ca-cert.pem"))
        print(f"\nCA bundle: {os.path.relpath(cert_source, root)} -> ../ca-cert.pem")
    else:
        print("\nCA bundle: NOT FOUND under ca-certificates (TLS will need SSL_CERT_FILE)")

    with open(os.path.join(args.out, "jnilibs-manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
    print(f"\nstaged {len(plan)} files -> {args.out}")


if __name__ == "__main__":
    main()
