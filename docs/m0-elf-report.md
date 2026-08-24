# M0 ELF audit report

- scanned ELFs: 17 (aarch64: 17), symlinks: 27
- unresolved NEEDED: 0
- wrong-arch: 0

| path | type | min PT_LOAD align | NEEDED |
|---|---|---|---|
| c-ares\data\data\com.termux\files\usr\lib\libcares.so | DYN | 16K | libc.so |
| libc++\data\data\com.termux\files\usr\lib\libc++_shared.so | DYN | 16K | libc.so, libdl.so, libm.so |
| libicu\data\data\com.termux\files\usr\lib\libicudata.so.78.3 | DYN | 16K | - |
| libicu\data\data\com.termux\files\usr\lib\libicui18n.so.78.3 | DYN | 16K | libc++_shared.so, libc.so, libdl.so, libicuuc.so.78, libm.so |
| libicu\data\data\com.termux\files\usr\lib\libicuio.so.78.3 | DYN | 16K | libc++_shared.so, libc.so, libdl.so, libicui18n.so.78, libicuuc.so.78 |
| libicu\data\data\com.termux\files\usr\lib\libicutest.so.78.3 | DYN | 16K | libc++_shared.so, libc.so, libdl.so, libicutu.so.78, libicuuc.so.78 |
| libicu\data\data\com.termux\files\usr\lib\libicutu.so.78.3 | DYN | 16K | libc++_shared.so, libc.so, libdl.so, libicui18n.so.78, libicuuc.so.78 |
| libicu\data\data\com.termux\files\usr\lib\libicuuc.so.78.3 | DYN | 16K | libc++_shared.so, libc.so, libdl.so, libicudata.so.78, libm.so |
| libsqlite\data\data\com.termux\files\usr\lib\libsqlite3.53.4.so | DYN | 16K | libc.so, libdl.so, libm.so, libz.so.1 |
| libsqlite\data\data\com.termux\files\usr\lib\libsqlite3.so.3.53.4 | DYN | 16K | libc.so, libdl.so, libm.so, libz.so.1 |
| nodejs-lts\data\data\com.termux\files\usr\bin\node | DYN | 16K | libc++_shared.so, libc.so, libcares.so, libcrypto.so.3, libdl.so, libicui18n.so.78, libicuuc.so.78, libm.so, libsqlite3.so, libssl.so.3, libz.so.1 |
| openssl\data\data\com.termux\files\usr\lib\engines-3\capi.so | DYN | 16K | libc.so |
| openssl\data\data\com.termux\files\usr\lib\engines-3\loader_attic.so | DYN | 16K | libc.so, libcrypto.so.3 |
| openssl\data\data\com.termux\files\usr\lib\libcrypto.so.3 | DYN | 16K | libc.so, libdl.so |
| openssl\data\data\com.termux\files\usr\lib\libssl.so.3 | DYN | 16K | libc.so, libcrypto.so.3 |
| openssl\data\data\com.termux\files\usr\lib\ossl-modules\legacy.so | DYN | 16K | libc.so, libcrypto.so.3 |
| zlib\data\data\com.termux\files\usr\lib\libz.so.1.3.2 | DYN | 16K | libc.so |

## Symlinks (must be materialized as copies for jniLibs)

- `ca-certificates\data\data\com.termux\files\usr\share\doc\ca-certificates\copyright` -> ..\..\LICENSES\MPL-2.0.txt
- `libc++\data\data\com.termux\files\usr\share\doc\libc++\copyright` -> ..\..\LICENSES\NCSA.txt
- `libicu\data\data\com.termux\files\usr\lib\icu\Makefile.inc` -> current\Makefile.inc
- `libicu\data\data\com.termux\files\usr\lib\icu\current` -> 78.3
- `libicu\data\data\com.termux\files\usr\lib\icu\pkgdata.inc` -> current\pkgdata.inc
- `libicu\data\data\com.termux\files\usr\lib\libicudata.so` -> libicudata.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicudata.so.78` -> libicudata.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicui18n.so` -> libicui18n.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicui18n.so.78` -> libicui18n.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicuio.so` -> libicuio.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicuio.so.78` -> libicuio.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicutest.so` -> libicutest.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicutest.so.78` -> libicutest.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicutu.so` -> libicutu.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicutu.so.78` -> libicutu.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicuuc.so` -> libicuuc.so.78.3
- `libicu\data\data\com.termux\files\usr\lib\libicuuc.so.78` -> libicuuc.so.78.3
- `libsqlite\data\data\com.termux\files\usr\lib\libsqlite3.so` -> libsqlite3.so.3.53.4
- `libsqlite\data\data\com.termux\files\usr\lib\libsqlite3.so.0` -> libsqlite3.so.3.53.4
- `libsqlite\data\data\com.termux\files\usr\share\doc\libsqlite\copyright` -> ..\..\LICENSES\Public Domain.txt
- `nodejs-lts\data\data\com.termux\files\usr\bin\corepack` -> ..\lib\node_modules\corepack\dist\corepack.js
- `openssl\data\data\com.termux\files\usr\lib\libcrypto.so` -> libcrypto.so.3
- `openssl\data\data\com.termux\files\usr\lib\libssl.so` -> libssl.so.3
- `openssl\data\data\com.termux\files\usr\share\doc\openssl\copyright` -> ..\..\LICENSES\Apache-2.0.txt
- `resolv-conf\data\data\com.termux\files\usr\share\doc\resolv-conf\LICENSE` -> ..\..\LICENSES\Public Domain.txt
- `zlib\data\data\com.termux\files\usr\lib\libz.so` -> libz.so.1.3.2
- `zlib\data\data\com.termux\files\usr\lib\libz.so.1` -> libz.so.1.3.2
