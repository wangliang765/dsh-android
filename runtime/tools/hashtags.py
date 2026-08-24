#!/usr/bin/env python3
"""Dump DT_HASH/DT_GNU_HASH/DT_STRSZ presence for two ELF files (original vs patched)."""
import struct
import sys


def hash_tags(path):
    with open(path, "rb") as handle:
        ident = handle.read(64)
        e_shoff, = struct.unpack_from("<Q", ident, 40)
        e_shentsize, e_shnum = struct.unpack_from("<HH", ident, 58)
        handle.seek(e_shoff)
        sh = handle.read(e_shentsize * e_shnum)
        dyn = None
        strsz = None
        for i in range(e_shnum):
            base = i * e_shentsize
            sh_type, = struct.unpack_from("<I", sh, base + 4)
            if sh_type == 6:
                dyn = struct.unpack_from("<QQ", sh, base + 24)
        if dyn is None:
            return "no dynamic section"
        handle.seek(dyn[0])
        blob = handle.read(dyn[1])
        found = []
        for off in range(0, len(blob) - 15, 16):
            tag, val = struct.unpack_from("<qQ", blob, off)
            if tag == 0:
                break
            if tag in (4, 5, 0x6FFFFEF5, 10):  # HASH, STRTAB, GNU_HASH, STRSZ
                found.append((hex(tag), hex(val)))
        return found


for path in sys.argv[1:3]:
    print(path)
    print(" ", hash_tags(path))
