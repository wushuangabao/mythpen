# Windows L1 production candidate acceptance

## Accepted scope

This acceptance freezes one exact Windows production candidate built from source
commit `f3641a2f0e1da237ce900e04547556f72ae5457e` for target
`x86_64-pc-windows-msvc`. Task 5 added only the compiled production E2E and this
acceptance record; it did not change production code, probes, the VM runner,
build logic, or an existing contract.

The earlier Task 5 runs from `e730a24` are invalid audit traces. They did not
authorize a manifest or candidate. The evidence below was generated anew after
the approved volume-sector binding fix and is the only accepted Task 5 evidence.

## Feature RED

Before any reviewed manifest existed, the compiled `server/production-sidecar.js`
entry was exercised against a real schema-10 project. It exited with status 1,
empty stdout, and the exact `DURABILITY_UNSUPPORTED` startup error. The project
remained schema 10, had no native durability backend or activation evidence, and
the complete data-root byte/hash snapshot was unchanged.

Command: `node --test scripts/tests/l1-production-e2e.test.mjs`

Result: PASS, 1/1. This was the slice's single feature RED.

## Accepted external VM evidence

Both matrices ran serially against `Mythpen-L1-Win10-LTSC2021` from a clean
`f3641a2f0e1da237ce900e04547556f72ae5457e` source tree. Each row binds the same
Windows/NTFS/VirtualBox profile and a 512-byte queried volume sector.

| Matrix | Accepted host run | Rows | Probe SHA-256 | `manifest.complete.json` SHA-256 |
|---|---|---:|---|---|
| rollback journal | `D:\Mythpen\l1-vm\evidence\rollback-journal\2026-08-14T18-57-20-476Z-9b1b1ce9-f15d-4367-a89a-58a2ab21b625` | 13/13, 0 failure | `51e5aad3211ac250c02c98048ebd6c7db2a62ef5a7c6df6346d3070f9b9b77d9` | `98a2dc8eb4db61568af2a5f80ed3f10f5837163b8f2b13a7a4b6df864770649b` |
| application directory | `D:\Mythpen\l1-vm\evidence\application-directory\2026-08-14T19-52-35-265Z-28df81c3-24e2-4334-9a50-fdbcfdc642d4` | 19/19, 0 failure | `b50342294a027f4516754a994b1da0c982ae4dc45e28fa53f5b760bbc7cd4fb8` | `2245be1d43df32952bb08dcb7d658655eaf71e63c5a325c997fb15f68aba9440` |

The shared runtime profile is Bun 1.3.14, SQLite 3.53.0, SQLite source ID
`2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b`,
VFS `win32`, Windows 10 Enterprise LTSC 2021 evaluation x64, NTFS plain
directory, and VirtualBox 7.2.14 SATA/IntelAhci with host I/O cache disabled.
Rollback rows additionally bind `journal_mode=delete` and `synchronous=3`.

## Reviewed manifest and candidate attestation

The deterministic external manifest was reviewed before it became build input.
The reviewer checked the raw runs, every row/action, source, probe digests,
runtime/platform profile, sector binding, and aggregate digests and returned
`MANIFEST APPROVE`.

| Artifact | Path | SHA-256 |
|---|---|---|
| reviewed manifest / authorization digest | `D:\Mythpen\l1-vm\evidence\windows-l1-reviewed-manifest.json` | `2caedf0e34b5e45db3ee268deae0e212258e78b8360ac3603a48975ca1309709` |
| production candidate | `src-tauri\target\production-sidecars\mythpen-server-production-x86_64-pc-windows-msvc.exe` | `a0cc26f1e442a1e9167914ab0285e8b37c1cc6e3436450aa48413475c30cd04c` |
| external attestation | `D:\Mythpen\l1-vm\evidence\windows-l1-production-attestation.json` | `3c83b2b9cdda0c8a34db32c310f75a2a51815a93359ce146c67930db348534b3` |

The candidate was built exactly once with:

```powershell
node scripts/build-sidecars.mjs --production-reviewed-manifest D:\Mythpen\l1-vm\evidence\windows-l1-reviewed-manifest.json
```

The executable embeds only the reviewed authorization digest and stable profile.
Its final SHA-256 exists only in the external attestation; the executable was not
rebuilt to contain its own digest.

## GREEN verification

The attested candidate followed the real compiled path
`production-sidecar.js -> index.js -> REST -> db.js -> NativeProjectStore`.
It created and wrote a schema-10 project through REST, enabled L1, continued
ordinary read/write, cleanly restarted, and reopened schema 11 with exactly one
matching prepared/activated pair. A second write survived another clean restart.
The off and embedded-profile-mismatch controls both failed closed without SQLite
or activation-evidence mutation.

| Command | Result |
|---|---|
| candidate/manifest environment + `node --test scripts/tests/l1-production-e2e.test.mjs` | PASS: 3/3; no-manifest zero-write, attested activation/two restarts, off/profile-mismatch zero-write |
| `bun test --timeout 30000 server/tests/production-native-activation-controller.test.js` | PASS: 5/5 |
| focused profile/activation/adapter/probe/API suite, excluding the isolation-sensitive controller file | PASS: 80 pass / 2 expected platform skip / 0 fail |
| `bun test --timeout 120000 server/tests/fixture-native-sidecar-e2e.test.js` | PASS: 1/1 compiled fixture REST E2E |
| `node --test scripts/tests/build-sidecars.test.mjs scripts/tests/windows-l1-vm.test.mjs` | PASS: 28/28 with a Windows PowerShell 5.1-only module path in the validation process |
| `bun test --isolate ./server/tests/` | PASS: 968 pass / 5 expected skip / 0 fail across 68 files |

The default non-isolated `pnpm test:server` run completed 966 pass / 5 expected
skip / 2 fail. Both failures were cross-file Bun module-state interference and
passed together under Bun's official per-file `--isolate` mode: the native DB
cold-instance test and the production controller's pre-load `require.cache`
assertion. This is a test-runner isolation backlog item, not accepted evidence of
a product failure.

The first build-contract run also exposed a host-only module discovery issue:
Codex's PowerShell 7 `PSModulePath` put its PowerShell 7 Utility module before the
Windows PowerShell 5.1 built-in module when Node spawned `powershell.exe`.
Restricting `PSModulePath` only for that verification process restored the exact
Windows PowerShell module set and the unmodified contract suite passed 28/28.

## Acceptance boundary

This accepts one externally attested Windows L1 production candidate for the
exact profile above. Benchmark/performance remains `NOT_RUN`; the formal binary
token gate remains `NOT MET/DEFERRED`. Same-path adoption, other-platform
evidence, installer validation, packaging, tag, push, release, and the phrase
"full cross-platform L1 complete" remain outside this acceptance.
