#!/usr/bin/env python3
"""Static ELF audit for the extracted termux sysroot.

For every ELF under --root:
  - machine must be EM_AARCH64 (183)
  - collect DT_NEEDED sonames
  - report minimum PT_LOAD p_align (Android 16 KB page requirement: >= 0x1000 legacy,
    0x4000 for 16 KB devices)

Cross-checks every NEEDED soname against the shipped library set (+ Android system
allowlist) and fails loud on anything unresolvable.

Usage: python elfcheck.py --root <sysroot-dir> [--out <report.md>]
"""
import argparse
import json
import os
import struct
import sys

EM_AARCH64 = 183
PT_LOAD = 1
PT_DYNAMIC = 2
DT_NEEDED = 1
DT_STRTAB = 5

# Libraries provided by the Android system (bionic), never shipped.
SYSTEM_SONAMES = {
    "libc.so", "libm.so", "libdl.so", "libandroid.so", "liblog.so",
    "libz.so", "libstdc++.so", "ld-android.so", "liblinker_bootstrap.so",
}


def read_cstr(buf, offset):
    end = buf.find(b"\x00", offset)
    if end < 0:
        raise ValueError("unterminated string")
    return buf[offset:end].decode("utf-8", "replace")


def parse_elf(path):
    """Return {machine, etype, needed:[], load_align_min, dynamic:bool} or None if not ELF."""
    size = os.path.getsize(path)
    if size < 64:
        return None
    with open(path, "rb") as handle:
        ident = handle.read(64)
        if ident[:4] != b"\x7fELF":
            return None
        ei_class = ident[4]
        if ei_class != 2:  # only ELF64 ships here
            return {"machine": f"class{ei_class}", "etype": "?", "needed": [], "load_align_min": None}
        e_type, e_machine = struct.unpack_from("<HH", ident, 16)

        handle.seek(0)
        header = handle.read(64)
        e_phoff, e_shoff = struct.unpack_from("<QQ", header, 32)
        e_phentsize, e_phnum = struct.unpack_from("<HH", header, 54)
        e_shentsize, e_shnum = struct.unpack_from("<HH", header, 58)

        phdrs = []
        handle.seek(e_phoff)
        blob = handle.read(e_phentsize * e_phnum)
        for i in range(e_phnum):
            p_type, _flags = struct.unpack_from("<II", blob, i * e_phentsize)
            p_offset, p_vaddr = struct.unpack_from("<QQ", blob, i * e_phentsize + 8)
            align = struct.unpack_from("<Q", blob, i * e_phentsize + 48)[0]
            phdrs.append((p_type, p_offset, p_vaddr, align))

        loads = [p for p in phdrs if p[0] == PT_LOAD]
        align_min = min((p[3] for p in loads), default=None)

        needed = []

        # Use section headers when present.
        strtab_off = None
        dyn_entries = []
        if e_shoff and e_shnum:
            handle.seek(e_shoff)
            shdrs_blob = handle.read(e_shentsize * e_shnum)
            shdrs = []
            for i in range(e_shnum):
                base = i * e_shentsize
                sh_name, sh_type = struct.unpack_from("<II", shdrs_blob, base)
                sh_addr, sh_offset, sh_size = struct.unpack_from("<QQQ", shdrs_blob, base + 16)
                link = struct.unpack_from("<I", shdrs_blob, base + 40)[0]
                shdrs.append({"type": sh_type, "addr": sh_addr, "offset": sh_offset,
                              "size": sh_size, "link": link})
            dyn = next((s for s in shdrs if s["type"] == 6), None)  # SHT_DYNAMIC
            dynstr = next((s for s in shdrs if s["type"] == 3), None)  # SHT_STRTAB linked to dyn
            if dyn and dynstr:
                handle.seek(dyn["offset"])
                dynblob = handle.read(dyn["size"])
                for off in range(0, len(dynblob) - 15, 16):
                    tag, val = struct.unpack_from("<qQ", dynblob, off)
                    dyn_entries.append((tag, val))
                handle.seek(dynstr["offset"])
                strbuf = handle.read(dynstr["size"])
                needed = [read_cstr(strbuf, val) for tag, val in dyn_entries if tag == DT_NEEDED]

        if not needed and not dyn_entries:
            # Fallback: walk PT_DYNAMIC and resolve strings through LOAD mapping.
            dynamics = [p for p in phdrs if p[0] == PT_DYNAMIC]
            if dynamics:
                p_type, p_offset, _vaddr, _align = dynamics[0]
                handle.seek(p_offset)
                dynblob = handle.read(4096 * 16)
                entries = []
                for off in range(0, len(dynblob) - 15, 16):
                    tag, val = struct.unpack_from("<qQ", dynblob, off)
                    entries.append((tag, val))
                    if tag == 0:
                        break
                strtab_vaddr = next((val for tag, val in entries if tag == DT_STRTAB), None)
                if strtab_vaddr is not None:
                    seg = next(((o, v) for (_, o, v, _a) in loads if v <= strtab_vaddr), None)
                    if seg:
                        file_off = strtab_vaddr - seg[1] + seg[0]
                        handle.seek(file_off)
                        strbuf = handle.read(65536)
                        needed = [read_cstr(strbuf, val) for tag, val in entries if tag == DT_NEEDED]

        return {
            "etype": {2: "EXEC", 3: "DYN"}.get(e_type, str(e_type)),
            "machine": e_machine,
            "needed": sorted(set(needed)),
            "load_align_min": align_min,
        }


def walk_nofollow(root):
    """Yield (dirpath, filenames) without following directory symlinks."""
    stack = [root]
    while stack:
        current = stack.pop()
        files = []
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                stack.append(entry.path)
            else:
                files.append(entry.name)
        yield current, files


def fmt_align(value):
    if value is None:
        return "?"
    return f"{value // 1024}K" if value % 1024 == 0 else hex(value)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    results = []
    problems = []
    symlinks = []
    for dirpath, filenames in walk_nofollow(args.root):
        for name in filenames:
            path = os.path.join(dirpath, name)
            if os.path.islink(path):
                try:
                    target = os.readlink(path)
                except OSError:
                    target = "?"
                symlinks.append({"path": os.path.relpath(path, args.root), "target": target})
                continue
            info = parse_elf(path)
            if info is None:
                continue
            rel = os.path.relpath(path, args.root)
            entry = {"path": rel, **info}
            results.append(entry)
            if isinstance(info["machine"], int) and info["machine"] != EM_AARCH64:
                problems.append(f"{rel}: machine {info['machine']} != AARCH64")

    shipped = {os.path.basename(r["path"]) for r in results}
    shipped |= {os.path.basename(s["path"]) for s in symlinks}
    for r in results:
        for needed in r["needed"]:
            if needed in SYSTEM_SONAMES or needed in shipped:
                continue
            problems.append(f"{r['path']}: NEEDED '{needed}' unresolved (not shipped, not system)")

    arm64 = [r for r in results if r["machine"] == EM_AARCH64]
    lines = [
        "# M0 ELF audit report",
        "",
        f"- scanned ELFs: {len(results)} (aarch64: {len(arm64)}), symlinks: {len(symlinks)}",
        f"- unresolved NEEDED: {len([p for p in problems if 'NEEDED' in p])}",
        f"- wrong-arch: {len([p for p in problems if 'machine' in p])}",
        "",
        "| path | type | min PT_LOAD align | NEEDED |",
        "|---|---|---|---|",
    ]
    for r in sorted(results, key=lambda item: item["path"]):
        lines.append(f"| {r['path']} | {r['etype']} | {fmt_align(r['load_align_min'])} | {', '.join(r['needed']) or '-'} |")
    if problems:
        lines += ["", "## Problems", ""]
        lines += [f"- {problem}" for problem in problems]
    if symlinks:
        lines += ["", "## Symlinks (must be materialized as copies for jniLibs)", ""]
        lines += [f"- `{s['path']}` -> {s['target']}" for s in sorted(symlinks, key=lambda item: item["path"])]

    report = "\n".join(lines) + "\n"
    print(report)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(report)
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "elf-audit.json"), "w", encoding="utf-8") as handle:
        json.dump(results, handle, indent=2)
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
