#!/usr/bin/env python3
"""Stage one detached worktree for local npm-baseline packing (Windows host variant of
scripts/publish-npm-baseline.ts WorkspacePackageSet.stage).

- Discovers every package manifest under vendor/*, packages/*/*, apps/*.
- Deletes `private`; pins every internal dependency range (all sections) to <version>.
- Drops optionalDependencies of the landlock-run entry package so the consumer
  install reproduces the supported no-platform-package configuration (probe -> unusable,
  consumers fall closed) instead of pointing at tarballs a Windows host cannot produce.

Usage: python stage_worktree.py <worktree> <version>
"""
import json
import os
import sys

SKIP_OPTIONAL_PACKAGES_PREFIX = "@deepseek-ai/node-addon-landlock-run-"


def discover(worktree):
    manifests = []
    scopes = [
        (os.path.join(worktree, "vendor"), 2),
        (os.path.join(worktree, "packages"), 3),
        (os.path.join(worktree, "apps"), 2),
        (os.path.join(worktree, "native", "landlock-run", "packages"), 2),
    ]
    for base, depth in scopes:
        for current, directories, files in os.walk(base):
            rel = os.path.relpath(current, base)
            if rel != "." and rel.count(os.sep) >= depth - 1:
                directories[:] = []
            if "package.json" in files:
                manifests.append(os.path.join(current, "package.json"))
    return manifests


def main():
    worktree, version = sys.argv[1], sys.argv[2]
    manifests = discover(worktree)
    if not manifests:
        raise SystemExit("no package manifests discovered")
    internal = set()
    records = []
    for path in manifests:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        name = data.get("name")
        if not isinstance(name, str) or name == "@deepseek-ai/dsh-root":
            continue
        internal.add(name)
        records.append((path, data))

    for path, data in records:
        changed = False
        if data.pop("private", None) is not None:
            changed = True
        for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            deps = data.get(section)
            if not isinstance(deps, dict):
                continue
            for dep_name, dep_range in list(deps.items()):
                if dep_name in internal and isinstance(dep_range, str) and dep_range.startswith("workspace:"):
                    # Pin to the dependency's own published version, not the baseline version:
                    # independently-versioned packages (landlock-run entry) keep their own.
                    target = next((d for _, d in records if d.get("name") == dep_name), None)
                    deps[dep_name] = target.get("version", version) if target else version
                    changed = True
        if data.get("name") == "@deepseek-ai/node-addon-landlock-run":
            optionals = data.get("optionalDependencies")
            if isinstance(optionals, dict):
                kept = {k: v for k, v in optionals.items()
                        if not k.startswith(SKIP_OPTIONAL_PACKAGES_PREFIX)}
                if kept != optionals:
                    data["optionalDependencies"] = kept
                    changed = True
        if changed:
            with open(path, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(data, handle, indent=2)
                handle.write("\n")

    print(f"staged {len(records)} packages at {version} "
          f"(internal names pinned, landlock platform optionals dropped)")


if __name__ == "__main__":
    main()
