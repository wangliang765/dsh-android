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
    """Install a stub package over a native-dependent module.

    For sharp, install a pure-JS metadata parser instead of a throw-everything
    Proxy — read_image calls sharp().metadata() on every invocation, so a
    throw-only stub turns the tool into a 100%-failure bug. The shim parses
    JPEG/PNG/WebP/GIF headers to provide format/width/height/alpha/orientation,
    which is enough for read_image's pass-through fast path. Pipeline
    operations that need real pixel data (resize/re-encode) still fail loud.
    """
    target = os.path.join(payload, "node_modules", name)
    os.makedirs(target, exist_ok=True)

    if name == "sharp":
        _install_sharp_js_shim(target)
        return

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
            "// bindings target glibc/musl and cannot load under bionic.\n"
            "module.exports = new Proxy({}, {\n"
            "  get() {\n"
            "    return function unavailable() {\n"
            f"      throw new Error('{name} stub: native-backed API is unsupported on Android')\n"
            "    }\n"
            "  },\n"
            "})\n"
        )
    print(f"installed {name} android stub")


def _install_sharp_js_shim(target):
    """Install the full pure-JS sharp replacement from assembly/sharp-shim/.

    v2 shim implements real pixel operations on top of three vendored
    zero-dependency libraries (jpeg-js decode/encode, pngjs, omggif):
    metadata(), raw().toBuffer(), resize(fit:'inside'), rotate() EXIF orient,
    .jpeg()/.png() re-encode. WebP stays header-only and fails loud with a
    SHIM_NO_WEBP* code, which patch_attachment_webp_fallback() converts into
    an oversized candidate so the caller's fallback loops skip it cleanly.
    """
    shim_src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sharp-shim")
    index_src = os.path.join(shim_src, "index.js")
    vendor_src = os.path.join(shim_src, "vendor")
    if not (os.path.isfile(index_src) and os.path.isdir(vendor_src)):
        raise RuntimeError(
            "sharp-shim sources missing: expected %s (run once: "
            "npm install jpeg-js pngjs omggif in assembly/sharp-shim/vendor)" % index_src
        )
    import shutil as _shutil
    # Fresh target: no stale files from previous shim generations.
    if os.path.isdir(target):
        _shutil.rmtree(target)
    os.makedirs(target)
    with open(os.path.join(target, "package.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump({
            "name": "sharp",
            "version": "0.34.5-android-js-shim2",
            "description": "Android pure-JS sharp shim v2: jpeg-js/pngjs/omggif-backed decode, resize, re-encode; WebP header-only",
            "main": "index.js",
        }, handle)
    _shutil.copyfile(index_src, os.path.join(target, "index.js"))
    _shutil.copytree(vendor_src, os.path.join(target, "vendor"))
    print("installed sharp android pure-JS shim v2 (jpeg/png pixel pipeline)")


def patch_attachment_webp_fallback(payload):
    """Teach dsh-attachment-local to skip unencodable WebP candidates.

    The shim cannot encode WebP, but attachment-local mixes .webp attempts
    into its candidate lists ([png, ...webp] / [...webp]); one thrown
    candidate aborts encodeFirstWithinLimit entirely instead of falling
    through to the next format or the shrink loop. Patch both encode()
    helpers so a SHIM_NO_WEBP* failure yields an always-oversized candidate:
    byte comparisons treat it as "does not fit", preserving the caller's
    normal fallback and shrink-to-fit behaviour. Real sharp output is
    unaffected (it never throws those codes).
    """
    rel = os.path.join("node_modules", "@deepseek-ai", "dsh-attachment-local", "lib", "index.js")
    path = os.path.join(payload, rel)
    with open(path, "r", encoding="utf-8", newline="") as handle:
        src = handle.read()
    if "SHIM_NO_WEBP" in src:
        print("attachment-local webp fallback already patched")
        return

    head_a = '\tconst { data, info } = await (mediaType === "image/png" ? pipeline.png({'
    head_b = '\tconst { data, info } = await (mediaType === "image/png" ? image.png({'
    head_new = ('\tlet data, info;\n'
                '\ttry {\n'
                '\t\t({ data, info } = await (mediaType === "image/png" ? ')
    tail_old = (')).toBuffer({ resolveWithObject: true });\n'
                '\treturn {\n'
                '\t\tdata: new Uint8Array(data),')
    tail_new = (')).toBuffer({ resolveWithObject: true }));\n'
                '\t} catch (error) {\n'
                '\t\tif (error && typeof error.code === "string" && error.code.indexOf("SHIM_NO_WEBP") === 0) '
                'return { data: { byteLength: Number.MAX_SAFE_INTEGER }, mediaType, width: 0, height: 0 };\n'
                '\t\tthrow error;\n'
                '\t}\n'
                '\treturn {\n'
                '\t\tdata: new Uint8Array(data),')

    count = src.count(tail_old)
    if count != 2 or not (head_a in src and head_b in src):
        raise RuntimeError(
            "attachment-local encode() shape drifted: heads=%d/%d tails=%d — re-derive this patch"
            % (src.count(head_a), src.count(head_b), count)
        )
    src = src.replace(head_a, head_new + 'pipeline.png({')
    src = src.replace(head_b, head_new + 'image.png({')
    src = src.replace(tail_old, tail_new)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(src)
    print("patched attachment-local encode() x2 -> SHIM_NO_WEBP becomes oversized candidate")


def patch_attachment_android_io(payload):
    """Fix two Android-fatal filesystem assumptions in dsh-attachment-local.

    1. ensureDurableDirectory walks from the storage directory up to the
       filesystem root fsyncing every ancestor. On Android the walk crosses
       /data/data (realpath /data/user/0), which app domains cannot open ->
       EACCES on the very first attachment commit. Ancestor syncs outside the
       app sandbox are impossible here, so make them best-effort: ignore
       EACCES/EPERM, propagate anything else.
    2. commitPreparedImageFile publishes objects via hardlink(2). This OEM ROM
       denies link(2) inside app data dirs (same SELinux restriction already
       handled for session-jsonl and fs-local). Fall back to rename(2), which
       is allowed, keeping the EEXIST digest-verification semantics: content
       addressing means a renamed object carries identical bytes.
    """
    rel = os.path.join("node_modules", "@deepseek-ai", "dsh-attachment-local", "lib", "index.js")
    path = os.path.join(payload, rel)
    with open(path, "r", encoding="utf-8", newline="") as handle:
        src = handle.read()

    applied = []

    walk_old = (
        '\twhile (level !== stop) {\n'
        '\t\tconst parent = dirname(level);\n'
        '\t\tawait syncDirectory(parent);\n'
    )
    walk_new = (
        '\twhile (level !== stop) {\n'
        '\t\tconst parent = dirname(level);\n'
        '\t\t// ANDROID-IO-PATCH: ancestors above the app sandbox cannot be opened;\n'
        '\t\t// treat EACCES/EPERM ancestor syncs as best-effort instead of fatal.\n'
        '\t\tawait syncDirectory(parent).catch((error) => {\n'
        '\t\t\tif (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM"))) throw error;\n'
        '\t\t});\n'
    )
    if walk_old in src:
        src = src.replace(walk_old, walk_new)
        applied.append("ancestor-fsync")

    link_old = (
        '\t\ttry {\n'
        '\t\t\tawait link(temporary, target);\n'
        '\t\t} catch (error) {\n'
        '\t\t\t/* v8 ignore next -- Private same-filesystem directories make EEXIST the only recoverable link race. */\n'
        '\t\t\tif (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;\n'
        '\t\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");\n'
        '\t\t}\n'
    )
    link_new = (
        '\t\ttry {\n'
        '\t\t\tawait link(temporary, target);\n'
        '\t\t} catch (error) {\n'
        '\t\t\t// ANDROID-IO-PATCH: this kernel denies link(2) inside app data dirs.\n'
        '\t\t\tconst errorCode = error instanceof Error && "code" in error ? error.code : void 0;\n'
        '\t\t\tif (errorCode === "EEXIST") {\n'
        '\t\t\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");\n'
        '\t\t\t} else if (errorCode === "EPERM" || errorCode === "EACCES" || errorCode === "EXDEV" || errorCode === "ENOSYS" || errorCode === "EINVAL") {\n'
        '\t\t\t\ttry {\n'
        '\t\t\t\t\tawait rename(temporary, target);\n'
        '\t\t\t\t} catch (renameError) {\n'
        '\t\t\t\t\tif (!(renameError instanceof Error && "code" in renameError && renameError.code === "EEXIST")) throw renameError;\n'
        '\t\t\t\t}\n'
        '\t\t\t\tif (digest$1(new Uint8Array(await readFile(target))) !== sha256) throw new AttachmentError("Stored attachment failed integrity verification.", "ATTACHMENT_CORRUPT");\n'
        '\t\t\t} else {\n'
        '\t\t\t\tthrow error;\n'
        '\t\t\t}\n'
        '\t\t}\n'
    )
    if link_old in src:
        src = src.replace(link_old, link_new)
        applied.append("link-rename")

    # The rename fallback consumes the staging file, so the unconditional
    # cleanup unlink in the success path hits ENOENT and would misreport an
    # already-successful publish as ATTACHMENT_WRITE_FAILED. Tolerate ENOENT.
    unlink_old = (
        '\t\tawait syncDirectory(join(root, "objects"));\n'
        '\t\tawait unlink(temporary);\n'
    )
    unlink_new = (
        '\t\tawait syncDirectory(join(root, "objects"));\n'
        '\t\t// ANDROID-IO-PATCH: the rename fallback already consumed the staging\n'
        '\t\t// file; a missing temp object means the publish itself succeeded.\n'
        '\t\tawait unlink(temporary).catch((cleanupError) => {\n'
        '\t\t\tif (!(cleanupError instanceof Error && "code" in cleanupError && cleanupError.code === "ENOENT")) throw cleanupError;\n'
        '\t\t});\n'
    )
    if unlink_old in src:
        src = src.replace(unlink_old, unlink_new)
        applied.append("cleanup-unlink")

    if not applied:
        print("attachment-local android io already fully patched")
        return

    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(src)
    print("patched attachment-local io: " + ", ".join(applied))

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


def patch_fs_local_write_link_fallback(payload):
    """Add a rename() fallback to dsh-fs-local's writeFileAtomic createIfAbsent path.

    The write tool creates new files via hard-link(2) (temp → target), which
    hardened OEM ROMs (realme/MIUI SELinux) deny with EACCES inside app-private
    data dirs. Overwriting existing files uses rename(2) and works fine — which
    is why edit succeeds while write fails. When link fails with EACCES/EPERM,
    fall back to rename(); other errors keep flowing to the original guard.
    """
    # Locate the fs-local lib inside .pnpm (hash varies per build).
    pnpm_root = os.path.join(payload, "node_modules", ".pnpm")
    target_rel = os.path.join("node_modules", "@deepseek-ai", "dsh-fs-local", "lib", "index.js")
    source_path = None
    if os.path.isdir(pnpm_root):
        for entry in os.listdir(pnpm_root):
            if entry.startswith("@deepseek-ai+dsh-fs-local@"):
                candidate = os.path.join(pnpm_root, entry, target_rel)
                if os.path.isfile(candidate):
                    source_path = candidate
                    break
    if source_path is None:
        # Fallback: direct hoisted layout.
        candidate = os.path.join(payload, target_rel)
        if os.path.isfile(candidate):
            source_path = candidate
    if source_path is None:
        raise SystemExit("dsh-fs-local lib/index.js not found; cannot apply write link fallback")

    with open(source_path, encoding="utf-8") as handle:
        source = handle.read()

    marker = "ANDROID LINK FALLBACK"
    if marker in source:
        print("fs-local write link fallback already patched")
        return

    original_block = (
        "\t\tif (createIfAbsent !== void 0) try {\n"
        "\t\t\tawait linkFile(tempPath, absolutePath);\n"
        "\t\t} catch (error) {\n"
        "\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);\n"
        "\t\t}\n"
    )
    patched_block = (
        "\t\tif (createIfAbsent !== void 0) try {\n"
        "\t\t\tawait linkFile(tempPath, absolutePath);\n"
        "\t\t} catch (linkError) {\n"
        "\t\t\t// ANDROID LINK FALLBACK: hardened OEM ROMs deny hardlink(2)\n"
        "\t\t\t// inside app-private data dirs; publish via rename instead.\n"
        "\t\t\tif (linkError && (linkError.code === 'EACCES' || linkError.code === 'EPERM'))\n"
        "\t\t\t\tawait rename(tempPath, absolutePath);\n"
        "\t\t\telse\n"
        "\t\t\t\tawait throwGuardedCreateFailure(linkError, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);\n"
        "\t\t}\n"
    )
    if original_block not in source:
        raise SystemExit("fs-local writeFileAtomic block drifted; update patch_fs_local_write_link_fallback")
    source = source.replace(original_block, patched_block)
    with open(source_path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(source)
    print("patched fs-local write link->rename fallback")


def install_ripgrep(payload):
    """Install a static arm64 ripgrep binary where @vscode/ripgrep expects it.

    glob/grep tools delegate to @vscode/ripgrep which resolves
    `@vscode/ripgrep-linux-arm64/bin/rg` as an optional dependency — never
    installed because the deploy runs on Windows. A musl static binary works
    under bionic without any .so dependency.
    """
    import urllib.request
    import tarfile
    import tempfile
    import shutil as _shutil

    rg_version = "15.2.0"
    url = ("https://github.com/BurntSushi/ripgrep/releases/download/"
           f"{rg_version}/ripgrep-{rg_version}-aarch64-unknown-linux-musl.tar.gz")
    # process.platform on Android is 'android', NOT 'linux'. @vscode/ripgrep
    # resolves `@vscode/ripgrep-${process.platform}-${arch}/bin/rg` via
    # require.resolve — which follows pnpm's real-path layout and fails to
    # find a top-level install. Instead of fighting module resolution,
    # rewrite @vscode/ripgrep/lib/index.js to export a direct file URL.
    platform_pkg = os.path.join(payload, "node_modules", "@vscode", "ripgrep-android-arm64", "bin")
    rg_target = os.path.join(platform_pkg, "rg")
    if not (os.path.isfile(rg_target) and os.path.getsize(rg_target) > 1000000):
        os.makedirs(platform_pkg, exist_ok=True)
        tmpdir = tempfile.mkdtemp(prefix="dsh-rg-")
        try:
            tgz_path = os.path.join(tmpdir, "rg.tgz")
            print(f"downloading ripgrep {rg_version} arm64-musl...")
            urllib.request.urlretrieve(url, tgz_path)
            with tarfile.open(tgz_path, "r:gz") as tar:
                member = f"ripgrep-{rg_version}-aarch64-unknown-linux-musl/rg"
                tar.extract(member, tmpdir)
            extracted = os.path.join(tmpdir, f"ripgrep-{rg_version}-aarch64-unknown-linux-musl", "rg")
            _shutil.copy2(extracted, rg_target)
            os.chmod(rg_target, 0o755)
            print(f"installed ripgrep -> {rg_target} ({os.path.getsize(rg_target)} bytes)")
        except Exception as e:
            print(f"WARN: ripgrep install failed ({e}); glob/grep will not work until fixed")
        finally:
            _shutil.rmtree(tmpdir, ignore_errors=True)
    else:
        print("ripgrep binary already installed")
    # Rewrite @vscode/ripgrep/lib/index.js to export an ABSOLUTE path.
    # CRITICAL: targetSdk>=29 W^X blocks exec() from app-writable data dirs.
    # The only exec-permitted location is nativeLibraryDir; DshService creates
    # a symlink files/bin/rg -> nativeLibraryDir/librg.so and prepends
    # files/bin to PATH. So we point rgPath at the SYMLINK, not the payload.
    stub_content = (
        "const rgPath = '/data/data/dev.dsh.spike/files/bin/rg';\n"
        "export { rgPath };\n"
    )
    patched_count = 0
    nm_root = os.path.join(payload, "node_modules")
    for dirpath, dirs, files in os.walk(nm_root):
        dirs[:] = [d for d in dirs if d != '.bin']
        if os.path.basename(dirpath) != 'lib':
            continue
        parent = os.path.basename(os.path.dirname(dirpath))
        grandparent = os.path.basename(os.path.dirname(os.path.dirname(dirpath)))
        # Match @vscode/ripgrep/lib/ or .pnpm/@vscode+ripgrep@*/node_modules/@vscode/ripgrep/lib/
        if not (parent == 'ripgrep' and 'vscode' in (grandparent + dirpath).lower()):
            continue
        candidate = os.path.join(dirpath, 'index.js')
        if not os.path.isfile(candidate):
            continue
        # ALWAYS overwrite: the stub is deterministic and tiny.
        with open(candidate, 'w', encoding='utf-8', newline='\n') as hf:
            hf.write(stub_content)
        patched_count += 1
    print(f"patched {patched_count} @vscode/ripgrep copies -> direct rgPath")


def install_user_plugins(payload):
    """Copy standalone user plugins into the payload's node_modules AND make
    them resolvable.

    These are workspace members under packages/plugin/ in the harness repo.
    They produce tarballs during pack but are NOT dependencies of
    @deepseek-ai/dsh, so pnpm deploy skips them. Copying alone is not enough
    for the plugins to take effect: boot-time healProfilesModuleFallback()
    symlinks every package in the @deepseek-ai/dsh dependency closure into
    $DSH_HOME/profiles/node_modules (the flat fallback the loader resolves
    through from the profile directory). Plugins outside that closure never
    get links, so their loader rows cannot resolve. Fix: append each plugin
    name to node_modules/@deepseek-ai/dsh/package.json dependencies — a
    post-deploy manifest edit the BFS then picks up. The mounting leg lives
    in patches/android.patch.yml (- insert rows for both plugins).
    """
    upstream = os.environ.get("DSH_UPSTREAM", r"E:\code\deepseek-harness")
    src_root = os.path.join(upstream, "packages", "plugin")
    if not os.path.isdir(src_root):
        print(f"WARN: user plugin source not found: {src_root}")
        return
    nm = os.path.join(payload, "node_modules")
    import shutil as _shutil
    copied = []
    for name in os.listdir(src_root):
        pkg_json = os.path.join(src_root, name, "package.json")
        if not os.path.isfile(pkg_json):
            continue
        dst = os.path.join(nm, name)
        if os.path.exists(dst):
            _shutil.rmtree(dst)
        _shutil.copytree(
            os.path.join(src_root, name), dst,
            ignore=_shutil.ignore_patterns("node_modules", ".vite*", "tests", "*.spec.*"),
        )
        copied.append(name)
        print(f"copied user plugin {name} -> {dst}")
    if not copied:
        return
    app_manifest_path = os.path.join(nm, "@deepseek-ai", "dsh", "package.json")
    with open(app_manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    deps = manifest.setdefault("dependencies", {})
    changed = False
    for name in copied:
        if deps.get(name) != "*":
            deps[name] = "*"
            changed = True
    if changed:
        with open(app_manifest_path, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(manifest, handle, indent=2)
            handle.write("\n")
        print(f"registered user plugins into dsh manifest dependencies: {', '.join(sorted(copied))}")


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
    patch_fs_local_write_link_fallback(payload)
    # The JS shim cannot encode WebP; keep attachment-local's candidate loops
    # alive when a WebP attempt fails loud.
    patch_attachment_webp_fallback(payload)
    # Attachment publication walks to / and hardlinks: both fatal under the
    # Android app sandbox (see function doc).
    patch_attachment_android_io(payload)
    install_ripgrep(payload)
    install_user_plugins(payload)


if __name__ == "__main__":
    main()
