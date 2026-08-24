#!/usr/bin/env python3
"""Android-ize a deployed payload in place before zipping.

Currently: disable every @deepseek-ai/dsh-terminal* row inside the shipped
agent presets — node-pty ships glibc native bindings that cannot load under
Android's bionic libc, and the preset roster eagerly imports all shipped
presets at boot.
"""
import json
import os
import sys


def disable_terminal_rows(path):
    with open(path, encoding="utf-8") as handle:
        lines = handle.readlines()
    out = []
    changed = 0
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("name: '@deepseek-ai/dsh-terminal"):
            # Idempotent: skip when a disabled row already follows.
            following = lines[index + 1].strip() if index + 1 < len(lines) else ""
            if not following.startswith("disabled:"):
                indent = line[: len(line) - len(line.lstrip())]
                out.append(line)
                out.append(f"{indent}disabled: true  # android: node-pty has no bionic binding\n")
                changed += 1
                continue
        out.append(line)
    if changed:
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.writelines(out)
    return changed


def install_node_pty_stub(payload):
    """Replace node-pty with a lazy-throwing stub.

    dsh-subprocess-local imports node-pty statically but calls it only inside
    spawnTerminal; every other code path (pipe spawn, collect readers,
    tree-scoped termination) is pure node:child_process. The stub lets the
    module load under Android while keeping terminal allocation fail-loud.
    """
    target = os.path.join(payload, "node_modules", "node-pty")
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, "package.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump({
            "name": "node-pty",
            "version": "0.0.0-android-stub",
            "description": "Android assembly stub: terminal allocation throws; unused on this host",
            "main": "index.js",
        }, handle)
    with open(os.path.join(target, "index.js"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(
            "'use strict'\n"
            "// Android assembly stub (see docs/m1-notes.md): the real node-pty\n"
            "// native binding targets glibc/musl and cannot load under bionic.\n"
            "// Consumers on this host never reach these calls.\n"
            "module.exports = new Proxy({}, {\n"
            "  get() {\n"
            "    return function unavailable() {\n"
            "      throw new Error('node-pty stub: pty allocation is unsupported on Android')\n"
            "    }\n"
            "  },\n"
            "})\n"
        )
    print("installed node-pty android stub")


def install_native_stub(payload, name, version_note):
    """Install a lazy-throwing stub package over a native-dependent module."""
    target = os.path.join(payload, "node_modules", name)
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, "package.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump({
            "name": name,
            "version": f"0.0.0-{version_note}",
            "description": f"Android assembly stub: {name} native bindings are unavailable; calls throw",
            "main": "index.js",
        }, handle)
    with open(os.path.join(target, "index.js"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(
            "'use strict'\n"
            f"// Android assembly stub (see docs/m1-notes.md): real {name} native\n"
            "// bindings target glibc/musl and cannot load under bionic. Consumers on\n"
            "// this host never reach these calls on mounted code paths.\n"
            "module.exports = new Proxy({}, {\n"
            "  get() {\n"
            "    return function unavailable() {\n"
            f"      throw new Error('{name} stub: native-backed API is unsupported on Android')\n"
            "    }\n"
            "  },\n"
            "})\n"
        )
    print(f"installed {name} android stub")


def install_koffi_stub(payload):
    """Replace koffi with an Android-safe lazy stub.

    Upstream rc.2 made dsh-subprocess-local import koffi for its Win32
    process-tree inspector AND evaluate `koffi.pointer("void")` at module
    scope (lib/index.js PVOID). A throw-on-any-use stub therefore still kills
    loader entry `subprocess` at boot. Real native work in koffi's API model
    always flows through load()/open(); type-descriptor constructors
    (pointer/struct/array/enum/...) only build inert metadata. So: descriptor
    factories return opaque tokens (module scope loads clean), load()/open()
    throw fail-loud, and every reachable Android path is pure-node /proc code
    that never touches either.
    """
    target = os.path.join(payload, "node_modules", "koffi")
    os.makedirs(target, exist_ok=True)
    with open(os.path.join(target, "package.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump({
            "name": "koffi",
            "version": "0.0.0-android-stub",
            "description": "Android assembly stub: type descriptors are inert tokens; load()/open() throw",
            "main": "index.js",
        }, handle)
    with open(os.path.join(target, "index.js"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(
            "'use strict'\n"
            "// Android assembly stub (see docs/m1-notes.md): koffi's prebuilt\n"
            "// bindings target glibc/musl and cannot init under bionic, and rc.2\n"
            "// evaluates koffi.pointer() at subprocess-local module scope.\n"
            "// Descriptor constructors return inert tokens so importing modules\n"
            "// load; all native traffic must pass load()/open(), which throw.\n"
            "const TOKEN = { __koffiAndroidStub: true }\n"
            "function unavailable() {\n"
            "  throw new Error('koffi stub: native FFI is unsupported on Android')\n"
            "}\n"
            "function token() { return TOKEN }\n"
            "module.exports = new Proxy({}, {\n"
            "  get(_target, prop) {\n"
            "    if (prop === 'load' || prop === 'open') return unavailable\n"
            "    if (prop === 'version' || prop === 'instances') return '0.0.0-android-stub'\n"
            "    if (typeof prop === 'symbol') return undefined\n"
            "    return token\n"
            "  },\n"
            "})\n"
        )
    print("installed koffi android stub")


def patch_session_link_fallback(payload):
    """Add a rename() fallback to the JSONL session publisher's link() publish.

    Hardened OEM ROMs (MIUI/HarmonyOS SELinux) deny hardlink creation inside
    app-private data dirs, which kills every session materialization with
    EACCES. When link() fails with EACCES/EPERM and the destination is absent,
    publish via rename() instead — the single-process mobile host gives up the
    multi-writer TOCTOU guarantee the source deliberately keeps on desktop.
    """
    rel = os.path.join("node_modules", "@deepseek-ai", "dsh-session-persistence-jsonl", "lib", "index.js")
    path = os.path.join(payload, rel)
    with open(path, encoding="utf-8") as handle:
        source = handle.read()

    if "ANDROID LINK FALLBACK" in source:
        print("session link fallback already patched")
        return
    if 'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";' not in source:
        raise SystemExit("session-persistence-jsonl import line drifted; update patch_session_link_fallback")

    source = source.replace(
        'import { readdirSync } from "node:fs";',
        'import { existsSync, readdirSync } from "node:fs";',
    )
    source = source.replace(
        'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";',
        'import { link, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";',
    )

    original_block = (
        "\t\tlet linked = false;\n"
        "\t\ttry {\n"
        "\t\t\tawait link(tmp, finalPath);\n"
        "\t\t\tlinked = true;\n"
        "\t\t} finally {\n"
        "\t\t\t/* v8 ignore next -- link failure is the TOCTOU/IO race guarded above; not reachable in test */\n"
        "\t\t\tif (!linked) await rm(tmp, { force: true });\n"
        "\t\t}\n"
    )
    patched_block = (
        "\t\tlet linked = false;\n"
        "\t\ttry {\n"
        "\t\t\t// ANDROID LINK FALLBACK: hardened OEM ROMs deny hardlink(2) in app\n"
        "\t\t\t// data dirs; publish via rename() when the dest is absent.\n"
        "\t\t\ttry {\n"
        "\t\t\t\tawait link(tmp, finalPath);\n"
        "\t\t\t\tlinked = true;\n"
        "\t\t\t} catch (linkError) {\n"
        "\t\t\t\tconst code = linkError && linkError.code;\n"
        "\t\t\t\tif ((code === 'EACCES' || code === 'EPERM') && !existsSync(finalPath)) {\n"
        "\t\t\t\t\tawait rename(tmp, finalPath);\n"
        "\t\t\t\t\tlinked = true;\n"
        "\t\t\t\t} else {\n"
        "\t\t\t\t\tthrow linkError;\n"
        "\t\t\t\t}\n"
        "\t\t\t}\n"
        "\t\t} finally {\n"
        "\t\t\tif (!linked) await rm(tmp, { force: true });\n"
        "\t\t}\n"
    )
    if original_block not in source:
        raise SystemExit("session-persistence-jsonl publish block drifted; update patch_session_link_fallback")
    source = source.replace(original_block, patched_block)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(source)
    print("patched session link->rename fallback")


def main():
    payload = sys.argv[1]
    presets_root = os.path.join(payload, "config", "agent-presets")
    total = 0
    for current, _dirs, files in os.walk(presets_root):
        for name in files:
            if name.endswith(".cordis.yml"):
                total += disable_terminal_rows(os.path.join(current, name))
    print(f"disabled {total} terminal rows across shipped presets")
    install_node_pty_stub(payload)
    install_native_stub(payload, "sharp", "android-stub")
    # Upstream rc.2 made dsh-subprocess-local statically import koffi for its
    # Win32 process-tree inspector (windows-inspector.js). See
    # install_koffi_stub for why a plain lazy-throw stub is not enough here.
    install_koffi_stub(payload)
    patch_session_link_fallback(payload)


if __name__ == "__main__":
    main()
