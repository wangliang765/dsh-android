#!/usr/bin/env python3
"""Compute the transitive dependency closure of termux packages from one apt Packages index.

Usage: python closure.py <Packages-index> <root-pkg> [more-roots...]
Outputs JSON manifest (stdout): [{"name","version","filename","size","sha256"}...] sorted by name.
Fail loud on any unresolvable dependency (first alternative only, version constraints ignored).
"""
import json
import re
import sys


def parse_index(path):
    stanzas = {}
    current = {}
    last_key = None

    def flush():
        nonlocal current
        name = current.get("Package")
        if name:
            stanzas.setdefault(name, current)
        current = {}

    with open(path, encoding="utf-8", errors="replace") as handle:
        for raw in handle:
            line = raw.rstrip("\n")
            if not line.strip():
                flush()
                last_key = None
                continue
            if line[0] in " \t":
                if last_key and last_key in current:
                    current[last_key] += " " + line.strip()
                continue
            if ":" in line:
                key, value = line.split(":", 1)
                last_key = key.strip()
                current[last_key] = value.strip()
    flush()
    return stanzas


def first_alternative(dep_field):
    names = []
    for group in dep_field.split(","):
        group = group.strip()
        if not group:
            continue
        alternative = group.split("|")[0].strip()
        name = re.sub(r"\s*\(.*$", "", alternative)
        if name:
            names.append(name)
    return names


def main():
    index_path, roots = sys.argv[1], sys.argv[2:]
    stanzas = parse_index(index_path)

    closure = {}
    queue = list(roots)
    while queue:
        name = queue.pop(0)
        if name in closure:
            continue
        stanza = stanzas.get(name)
        if stanza is None:
            raise SystemExit(f"unresolved dependency: {name} (fail loud)")
        closure[name] = stanza
        depends = stanza.get("Depends", "")
        queue.extend(dep for dep in first_alternative(depends) if dep not in closure)

    manifest = [
        {
            "name": stanza["Package"],
            "version": stanza.get("Version", ""),
            "filename": stanza.get("Filename", ""),
            "size": int(stanza.get("Size", "0")),
            "sha256": stanza.get("SHA256", ""),
        }
        for stanza in sorted(closure.values(), key=lambda item: item["Package"])
    ]
    json.dump(manifest, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
