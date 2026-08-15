# Windows L1 VM Hard-Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Each vertical slice has at most one RED, one GREEN, one blocker-only review, and one commit.

**Goal:** Produce real Windows/NTFS VirtualBox hard-reset evidence for Mythpen's two native durability capabilities, then use an external reviewed manifest and an immutable build-time trust root to enable a production L1 candidate without exposing existing user projects prematurely.

**Architecture:** A host-side runner controls one dedicated Windows VM. Compiled `fixture_only` probes run from guest-local NTFS, publish only an arm signal through a separate control channel, and block until the host performs `VBoxManage controlvm ... poweroff`. A cold verifier runs before any normal Mythpen open. Raw VM results are aggregated into an external reviewed manifest; the production build embeds only that manifest's stable authorization digest, never its own final EXE hash. Runtime callers can never turn JSON, environment variables, or CLI input into authority.

**Tech Stack:** VirtualBox 7.2.14, Windows 10 Enterprise LTSC 2021 Evaluation x64, NTFS, Bun 1.3.14 compiled executables, `bun:sqlite`, Node/Bun test runner, PowerShell/VBoxManage.

**Evidence ledger:** `l1-windows-vm-evidence-ledger.md` records executed evidence and keeps every unrun capability or release gate explicit.

## Global Constraints

- Repository worktree: `E:\github\mythpen\.worktrees\l1-durability-foundation`. The implementation baseline (the last code commit before this plan) is `4498d16f405acbd1bf120f34881c6dfb54e23136`; execute from a clean descendant containing the approved plan commits.
- ISO: `D:\Mythpen\l1-vm\downloads\Windows10EnterpriseLTSC2021Eval-x64-zh-cn.iso`, 5,043,298,304 bytes, SHA-256 `2181EAAEED2F1A78BE41F45692671DB050D9FF76291F767AB696147C8A322DA3`.
- VM name: `Mythpen-L1-Win10-LTSC2021`; machine folder: `D:\Mythpen\l1-vm\VirtualBox`.
- Existing `ubuntu-16.04.6-desktop-amd64` VM is out of scope and must not be started, modified, cloned, or deleted.
- Database and ControlStore roots must be guest-local canonical NTFS directories. VirtualBox shared folders may carry control frames or binaries only.
- Record VM reset, process kill, and physical power loss as distinct evidence classes. This plan proves only VirtualBox hard reset.
- Production activation stays `DURABILITY_UNSUPPORTED` until both capability matrices and the build-time trust-root slice pass.
- The tested source commit is frozen before the final matrices. Any subsequent production-code change invalidates the manifest and requires both affected matrices to be rerun from the new commit.
- The final production EXE SHA-256 is recorded in an external candidate attestation. It is never embedded into the same EXE and is never part of the runtime self-check.
- No version bump, installer, tag, push, release, same-path adoption, benchmark, Linux, or macOS work in this plan.
- On any non-environment test failure, stop the current slice. Non-Critical adjacent issues go to backlog.

---

### Task 1: Create a repeatable isolated Windows VM baseline

**Files:**
- Create: `scripts/windows-l1-vm.mjs`
- Create: `scripts/tests/windows-l1-vm.test.mjs`
- External state: `D:\Mythpen\l1-vm\VirtualBox\Mythpen-L1-Win10-LTSC2021`
- External secret: `D:\Mythpen\l1-vm\secrets\guest-credentials.json` (never committed)

**Interfaces:**
- Produces CLI commands `inspect`, `create`, `install`, `snapshot-baseline`, `smoke`, and `destroy-test-run`.
- Refuses any VM whose name, UUID, or `CfgFile` does not resolve inside the exact Mythpen VM directory.
- Writes machine-readable host reports under `D:\Mythpen\l1-vm\evidence\environment`.

- [x] **RED:** Add one table-driven test for exact VM name/path, ISO hash, SATA host I/O cache off, NAT-only network, no shared data root, 2 CPUs, 4096 MiB RAM, and dynamic 64 GiB VDI. Run:

  ```powershell
  node --test scripts/tests/windows-l1-vm.test.mjs
  ```

  Expected: one feature-shaped failure because `scripts/windows-l1-vm.mjs` does not exist.

- [x] **GREEN:** Implement the runner with `spawnSync()` argument arrays only. `create` refuses an existing non-exact VM and the unattended path remains fail-closed. VirtualBox 6.1.6 could not detect this ISO and VirtualBox 7.2.14 generated an unusable empty product-key answer file, so the user-approved installation exception was a clean manual install from the verified ISO. The task-scoped local credential remains outside Git and evidence logs.

- [x] Configure `Windows10_64`, SATA AHCI with host I/O cache off, NAT, no port forwarding, no clipboard/drag-and-drop, and no persistent shared folder. The approved manual path used the same isolated VM configuration and did not reuse the failed unattended answer file.

- [x] After Guest Additions and local NTFS smoke pass, shut down normally and create immutable snapshot `mythpen-l1-baseline-v1`. Record Windows build, NTFS filesystem/sector size, VirtualBox version, storage controller, host I/O cache, VM UUID, VDI UUID, and ISO hash.

- [x] **Review:** Confirm the Ubuntu VM is byte/state untouched, credentials are outside Git, and the tested root is guest-local NTFS.

- [x] **Commit:**

  ```powershell
  git add scripts/windows-l1-vm.mjs scripts/tests/windows-l1-vm.test.mjs
  git commit -m "test: add isolated Windows L1 VM harness"
  ```

**Task 1 result (2026-08-14): COMPLETE.** The immutable snapshot UUID is
`d1cf0188-a2ed-44b2-bc9e-7157c4712a04`; the VM is powered off. This completes
only the isolated experiment baseline and makes no native durability capability
claim. Exact installation identity, disk geometry, isolation controls, protected
Ubuntu hashes, evidence paths, manual normal-shutdown note, and remaining
`NOT_RUN` gates are recorded in the evidence ledger.

### Task 2: Make the exact rollback-journal matrix externally armable and cold-verifiable

**Files:**
- Modify: `server/testing/windows-native-rollback-probe.js`
- Modify: `server/testing/fault-injection.js`
- Modify: `server/tests/windows-native-rollback-probe.test.js`
- Modify: `scripts/windows-l1-vm.mjs`
- Modify: `scripts/tests/windows-l1-vm.test.mjs`

**Interfaces:**
- Probe command: `run-transaction <guestNtfsRoot> <cut> <armId> <controlDir>`.
- Cold command: `cold-inspect <guestNtfsRoot> <armId>`.
- Host command: `run-rollback-matrix --vm Mythpen-L1-Win10-LTSC2021`.
- Control frames live outside the tested NTFS root; the database and ControlStore never live in a VirtualBox shared folder.

- [x] **RED:** Replace the current arm-only smoke with one real transaction row. Require the probe to reach `native.tx.after-commit-return`, remain alive, and emit an arm frame before host poweroff. Expected failure: current probe writes `arm.json` and exits without executing a native transaction.

- [x] **GREEN:** Reuse the real NativeProjectStore transaction path. In a `fixture_only` probe build only, convert the selected existing crash point into: publish an exact arm frame to the host control channel, then block without graceful close. Do not add a production runtime evidence input or a general-purpose test seam.

- [x] The host runner must restore `mythpen-l1-baseline-v1`, copy the exact compiled probe to guest-local NTFS, verify its SHA-256 in the guest, start the row, observe the exact arm frame, record VM state as running, execute `VBoxManage controlvm <uuid> poweroff`, restart, and invoke `cold-inspect` before any normal Mythpen open.

- [x] Cold inspection must accept only one canonical state: the transaction is wholly before or wholly after; durability sequence is canonical; the write gate is empty; the source/prepared/terminal relationship is unique; there is no duplicate terminal.

- [x] Freeze `WINDOWS_ROLLBACK_CRASH_CASES` as the following exact ordered 13-case envelope; tests must compare the entire frozen list and must not derive it dynamically from every current fault point:

  1. `native.caller.after-source-postcheck`
  2. `native.tx.after-prepared-postcheck`
  3. `native.tx.after-begin-acquired`
  4. `native.tx.after-gate-insert`
  5. `native.tx.after-business-callback`
  6. `native.tx.after-seq-cas`
  7. `native.tx.after-gate-delete`
  8. `native.tx.before-commit-invoke`
  9. `native.tx.after-commit-return`
  10. `native.tx.before-terminal-append`
  11. `controlstore.append.before-publish`, selected only for the transaction terminal append
  12. `controlstore.append.before-dir-fsync`, selected only for the transaction terminal append
  13. `native.tx.after-terminal-postcheck`

- [x] Run the same harness over all 13 cases. Store raw host actions, guest binding, and cold results under a unique external run directory. Keep `requireWindowsNativeRollbackJournalDurability()` fail-closed. The two ControlStore append cases are rerun independently in Task 3 because one reset result cannot substitute for both capability envelopes.

- [x] **GREEN commands:**

  ```powershell
  bun test server/tests/windows-native-rollback-probe.test.js server/tests/windows-native-rollback-capability.test.js
  node scripts/windows-l1-vm.mjs run-rollback-matrix --vm Mythpen-L1-Win10-LTSC2021
  ```

- [x] **Review:** Block only on a missed cut, non-canonical cold state, writable user-root reachability, or a path that can mint runtime authority from caller JSON.

- [x] **Commit:**

  ```powershell
  git add server/testing/windows-native-rollback-probe.js server/testing/fault-injection.js server/tests/windows-native-rollback-probe.test.js scripts/windows-l1-vm.mjs scripts/tests/windows-l1-vm.test.mjs
  git commit -m "test: prove Windows rollback recovery under VM reset"
  ```

**Completed evidence (2026-08-14):**

- Source commit: `aec515aafd40c785d920ecac931ced6afeb3e0cd`.
- Accepted external run: `D:\Mythpen\l1-vm\evidence\rollback-journal\2026-08-14T06-52-57-187Z-9b5450ac-915e-463e-bf3f-f19c326344ae`.
- Compiled probe SHA-256: `E74286FD65C064808CA1A7FA597A67E238161CDFA19E2719723CF1C7CD5F26AB`.
- One run completed all 13 ordered cuts with 13 arm frames, 13 cold inspections, 13 accepted rows, and zero failures. Rows 1–8 converged to before/seq 0; rows 9–13 converged to after/seq 1; every row had an empty write gate.
- Focused probe/capability verification: 5 passed, 0 failed. Host-runner tests: 9 passed, 0 failed.
- Blocker-only review: **APPROVE**, Critical 0, reproducible data-loss risks 0, runtime-authority bypasses 0.
- Runtime and manifest capability remain `false`; Task 2 evidence alone does not enable production activation.

### Task 3: Prove application-directory entry durability

**Files:**
- Create: `server/platform/windows-native-directory-capability.js`
- Create: `server/testing/windows-native-directory-probe.js`
- Create: `server/tests/windows-native-directory-capability.test.js`
- Create: `server/tests/windows-native-directory-probe.test.js`
- Modify: `server/native/native-activation.js`
- Modify: `server/tests/native-activation.test.js`
- Modify: `scripts/build-sidecars.mjs`
- Modify: `scripts/tests/build-sidecars.test.mjs`
- Modify: `scripts/windows-l1-vm.mjs`

**Interfaces:**
- Export a frozen `WINDOWS_DIRECTORY_ENTRY_CRASH_CASES` whose exact ordered scenarios are listed below. Do not derive the evidence envelope dynamically from the contents of `FAULT_POINTS`.
- Compile an isolated directory probe under `src-tauri/target/capability-probes`; never include it in an installer or ordinary sidecar graph.
- Host command: `run-directory-matrix --vm Mythpen-L1-Win10-LTSC2021`.

- [x] **RED:** Add one integration table that requires a real host-reset row for ControlStore append, checkpoint installation/GC, and activation installation. Expected failure: no directory probe, evaluator, or matrix exists.

- [x] **GREEN:** Reuse the external arm-and-block mechanism from Task 2. Freeze and execute this exact ordered 19-case directory envelope:

  1. generic ControlStore event `controlstore.append.before-publish`
  2. generic ControlStore event `controlstore.append.before-dir-fsync`
  3. checkpoint activation tail `controlstore.tail.before-publish`
  4. checkpoint activation tail `controlstore.tail.before-dir-fsync`
  5. `controlstore.checkpoint.before-publish`
  6. `controlstore.checkpoint.before-candidate-unlink`
  7. `controlstore.checkpoint.before-final-dir-fsync`
  8. `controlstore.checkpoint.after-final-dir-fsync`
  9. `controlstore.checkpoint.before-gc`
  10. `controlstore.checkpoint.after-gc-entry` selected for an event entry
  11. `controlstore.checkpoint.after-gc-entry` selected for an old-checkpoint entry
  12. `controlstore.checkpoint.before-gc-dir-fsync`
  13. `controlstore.retire.before-dir-fsync`
  14. activation `prepared` append at `controlstore.append.before-publish`
  15. activation `prepared` append at `controlstore.append.before-dir-fsync`
  16. activation `activated` append at `controlstore.append.before-publish`
  17. activation `activated` append at `controlstore.append.before-dir-fsync`
  18. activation `aborted` append at `controlstore.append.before-publish`
  19. activation `aborted` append at `controlstore.append.before-dir-fsync`

- [x] The `aborted` rows are not optional: first implement the already-frozen §11.3 transition only when a prepared activation is proven to have returned to exact schema 10 with no native state. Bind it to the same activation/prepared identity, then test its two append installation windows. Ambiguous state remains `RECOVERY_REQUIRED`.

- [x] Cold verification must reject malformed or ambiguous state and prove that event/tail/checkpoint/activation recovery converges to exactly one valid before/after state, with no partial candidate promoted, no lost committed evidence, and no duplicate activation/checkpoint identity.

- [x] Keep the directory capability evaluator non-authoritative: matching JSON may report shape/binding completeness but must still return `authority:false` until Task 4 installs a reviewed build-time trust root.

- [x] **GREEN commands:**

  ```powershell
  bun test server/tests/windows-native-directory-capability.test.js server/tests/windows-native-directory-probe.test.js
  node scripts/windows-l1-vm.mjs run-directory-matrix --vm Mythpen-L1-Win10-LTSC2021
  node --test scripts/tests/build-sidecars.test.mjs
  ```

- [x] **Review:** Block only on missing install/GC cuts, ambiguous cold recovery, test probe leakage into ordinary builds, or runtime-mintable authority.

- [x] **Commit:**

  ```powershell
  git add server/platform/windows-native-directory-capability.js server/testing/windows-native-directory-probe.js server/tests/windows-native-directory-capability.test.js server/tests/windows-native-directory-probe.test.js server/native/native-activation.js server/tests/native-activation.test.js scripts/build-sidecars.mjs scripts/tests/build-sidecars.test.mjs scripts/windows-l1-vm.mjs
  git commit -m "test: prove Windows directory durability under VM reset"
  ```

**Accepted Task 3 evidence (2026-08-14):**

- Source commit: `c5c0c57138f32d4bfd10947d34422e8323c6c75b`.
- Accepted external run: `D:\Mythpen\l1-vm\evidence\application-directory\2026-08-14T14-08-45-201Z-c7f6682a-4151-4f07-b00d-bab59945fdc3`.
- Compiled probe SHA-256: `0391615360D84976A45162C7F75AF59FCD571BDAD226DB40A26745427890A69B`.
- The single accepted run completed all 19 ordered cuts with 19 accepted rows and zero failures in 4,700.2 seconds. The manifest reports `complete:true` while both capability and runtime authority remain `false`.
- Post-matrix focused verification: 11 passed, 0 failed. Host-runner verification: 14 passed, 0 failed. Changed-file syntax checks and `git diff --check` passed.
- The first blocker-only review rejected a false-positive `aborted` convergence that continued to schema 11. Commit `c5c0c57` closed it by requiring exact schema 10, no native residue, the preserved prepared/aborted identity, and a stable second cold inspection for rows 18–19. The same reviewer then returned **APPROVE**, Critical 0 and reproducible data-loss risks 0.
- Earlier incomplete/debug runs remain external audit traces and are not accepted evidence.

### Task 4: Wire production authority and trust-root mechanics while remaining fail-closed

**Files:**
- Create: `server/platform/windows-native-durability-profile.js`
- Create: `server/tests/windows-native-durability-profile.test.js`
- Create: `server/native/native-activation-controller.js`
- Create: `server/native/production-native-activation-authority.js`
- Create: `server/native/production-native-activation-controller.js`
- Create: `server/tests/production-native-activation-controller.test.js`
- Create: `server/production-sidecar.js`
- Modify: `server/platform/windows-native-rollback-capability.js`
- Modify: `server/platform/windows-native-directory-capability.js`
- Modify: `server/native/native-activation.js`
- Modify: `server/testing/fixture-native-activation-controller.js`
- Modify: `server/db.js`
- Modify: `server/routes/api.js`
- Modify: `server/sidecar-control.js`
- Modify: `scripts/build-sidecars.mjs`
- Modify: `scripts/tests/build-sidecars.test.mjs`

**Interfaces:**
- Production requirements take no caller-supplied evidence object. With no compile-time reviewed-manifest digest, they remain `DURABILITY_UNSUPPORTED`.
- `server/native/native-activation-controller.js` owns the non-testing closure-private registry and exact mode brand. `db.js` validates controllers through this module and no longer imports `server/testing/fixture-native-activation-controller.js`.
- The fixture controller remains usable only in a `fixture_only` entry and receives only a fixture brand. The production controller receives a production brand only from the production-owned factory after the compiled trust-root/profile check succeeds.
- `server/production-sidecar.js` is the only production entry: it installs the exact production controller before database initialization, then starts the normal server. Ordinary/off entries do not install it.
- The production enable path accepts only a registered exact schema-10 project. Under ConfigLifecycleLease then the project writer turn it flushes/fences/closes v1, activates, and atomically replaces the cache. Failure or uncertainty isolates the project.
- The trust-root mechanism accepts a compile-time authorization digest generated from an external manifest. It does not contain or compare the final EXE's own SHA-256.

- [x] **RED:** Add one combined production-authority table proving: arbitrary frozen JSON/environment/CLI cannot make either capability true; a fixture controller cannot install in production; a production controller cannot install in fixture/off; `db.js` has no production graph dependency on `server/testing/*`; and missing/mismatched compile-time digest rejects before filesystem, lease, ControlStore, SQLite, or activation mutation. Expected failure: there is no production controller/brand or trust-root build path.

- [x] **GREEN:** Implement the production-owned controller registry, opaque production activation receipt bound to the registered canonical database path/dbKey/profile, production entry, and db installation boundary. Reuse the existing activation core and native adapter; do not reuse or import the testing controller in the production graph.

- [x] Implement deterministic external-manifest validation and the compile-time digest plumbing, but keep the ordinary build and all tests fail-closed unless a reviewed external manifest is explicitly supplied to the production build command. Do not generate or accept the final manifest in this task.

- [x] Ordinary open remains non-activating. Production enable must satisfy the exact registered schema-10/lifecycle/cache replacement rules; off, fixture, missing profile, profile mismatch, prepared ambiguity, and any authority mismatch reject or isolate before unsafe service continues.

- [x] **Review:** Treat any synthetic-authority path, testing-controller import in the production graph, mode confusion, double writer, unsafe cache reuse, partial-profile acceptance, or early mutation as a blocker. A correctly wired but still unsupported production build is the expected result of this task.

- [x] **Commit:**

  ```powershell
  git add server/platform/windows-native-durability-profile.js server/tests/windows-native-durability-profile.test.js server/native/native-activation-controller.js server/native/production-native-activation-authority.js server/native/production-native-activation-controller.js server/tests/production-native-activation-controller.test.js server/production-sidecar.js server/platform/windows-native-rollback-capability.js server/platform/windows-native-directory-capability.js server/native/native-activation.js server/testing/fixture-native-activation-controller.js server/db.js server/routes/api.js server/sidecar-control.js scripts/build-sidecars.mjs scripts/tests/build-sidecars.test.mjs
  git commit -m "feat: wire fail-closed Windows production activation"
  ```

**Accepted Task 4 implementation (2026-08-15):**

- Commit: `6d8342f` (`feat: wire fail-closed Windows production activation`).
- The production-owned controller registry, opaque one-shot receipt, production entry, exact schema-10 lifecycle/cache replacement path, deterministic manifest/profile validator, and explicit production build plumbing are implemented.
- Runtime callers cannot supply evidence or mint production authority. Ordinary/off/fixture modes cannot install the production controller. Without a compile-time reviewed manifest/profile, startup and activation remain `DURABILITY_UNSUPPORTED` before filesystem, lease, ControlStore, SQLite, or activation mutation.
- The accepted platform identity is exact `VirtualBox 7.2.14 / SATA / IntelAhci / hostIoCache=false`, matching the accepted VM ledger. `NVMe` and the wrong controller identity are rejected.
- Exact focused GREEN: 23 passed, 0 failed. Expanded related GREEN: 165 passed, 2 platform skips, 0 failed. Post-review affected regression: 65 passed, 2 platform skips, 0 failed. Nineteen changed/new JS/MJS syntax checks and `git diff --check` passed.
- The single blocker-only review found one trust-root profile mismatch (`NVMe` versus the accepted SATA/IntelAhci VM). It was corrected in the same GREEN, and the same reviewer returned **CLOSED / APPROVE**. No synthetic-authority, data-loss, testing-controller leakage, mode-confusion, double-writer, unsafe-cache, or early-mutation blocker remained.
- No reviewed external manifest was generated or accepted in Task 4; no VM matrix, benchmark, installer, tag, push, or release was run.

### Task 5: Freeze evidence, build, and verify a production Windows L1 candidate

**Files:**
- Create: `server/tests/native-production-activation.test.js`
- Create: `scripts/tests/l1-production-e2e.test.mjs`
- Create: `docs/superpowers/plans/l1-windows-production-candidate-acceptance.md`
- External input: `D:\Mythpen\l1-vm\evidence\windows-l1-reviewed-manifest.json`
- External output: `D:\Mythpen\l1-vm\evidence\windows-l1-production-attestation.json`

**Interfaces:**
- This task starts from the clean Task 4 code commit and makes no production-code changes. If a test requires a production-code fix, invalidate all evidence, return to Task 4, commit the fix, and restart Task 5 from the new commit.
- The reviewed external manifest binds raw-run digests, exact probe SHA-256, frozen source commit, target triple, Bun/SQLite/VFS, Windows/NTFS profile, VirtualBox storage configuration, and both exact matrix results.
- The production build embeds only the manifest authorization digest plus stable profile fields. The external candidate attestation records final production EXE SHA-256, source commit, manifest digest, and build command.

- [x] **RED:** Before supplying a reviewed manifest, run the compiled-production E2E and require deterministic `DURABILITY_UNSUPPORTED` with zero activation/SQLite marker mutation. This is the single feature RED for the slice.

- [x] Freeze the clean Task 4 source commit. Build both probes from that commit and rerun the complete 13-case rollback matrix and 19-case directory matrix. Aggregate raw run hashes into the deterministic external reviewed manifest and perform one blocker-only evidence review.

- [x] Build the production candidate from the same frozen source commit while explicitly supplying the reviewed external manifest. Embed only its digest/profile, then write the final EXE SHA-256 to the external candidate attestation. Never rebuild the EXE to contain that SHA.

- [x] **GREEN:** Run one compiled-production E2E: create schema 10 and write through existing REST, enable L1, continue normal read/write, terminate/restart, verify schema 11 and exactly one prepared/activated pair, write again, and restart again. Include off/profile-mismatch zero-write controls.

- [x] Run focused profile/controller/activation/adapter tests, related server/API tests, compiled production E2E, and the complete current L1 correctness suites. Run `node --check` for changed JS and `git diff --check`.

- [x] **Review:** Block on evidence/source mismatch, incomplete matrix, authority bypass, concurrent/double-writer activation, cache replacement data loss, restart non-recovery, user-root overreach, or reproducible corruption. Record the final candidate EXE hash only in the external attestation and acceptance ledger.

- [x] **Commit:**

  ```powershell
  git add server/tests/native-production-activation.test.js scripts/tests/l1-production-e2e.test.mjs docs/superpowers/plans/l1-windows-production-candidate-acceptance.md
  git commit -m "test: accept reviewed Windows production L1 candidate"
  ```

**Accepted Task 5 candidate (2026-08-15):**

- A sector-identity mismatch discovered before manifest creation invalidated the first Task 5 runs. Commit `f3641a2` corrected the directory probe to query the tested volume's actual sector size; its focused GREEN was 17/17 and its blocker-only review returned **APPROVE**.
- Frozen source: `f3641a2f0e1da237ce900e04547556f72ae5457e`. Accepted reruns: rollback 13/13 and directory 19/19, zero failures, with exact queried sector size 512 in both envelopes.
- Reviewed manifest/authorization digest: `2caedf0e34b5e45db3ee268deae0e212258e78b8360ac3603a48975ca1309709`. The manifest authority review returned **MANIFEST APPROVE** before build.
- Production candidate: `src-tauri\target\production-sidecars\mythpen-server-production-x86_64-pc-windows-msvc.exe`, 103,717,376 bytes, SHA-256 `a0cc26f1e442a1e9167914ab0285e8b37c1cc6e3436450aa48413475c30cd04c`. The executable was built once and was not rebuilt to contain its own digest.
- External attestation: `D:\Mythpen\l1-vm\evidence\windows-l1-production-attestation.json`, SHA-256 `3c83b2b9cdda0c8a34db32c310f75a2a51815a93359ce146c67930db348534b3`.
- Compiled candidate E2E: 3/3 passed, covering no-manifest zero-write rejection, real REST activation plus two restarts and retained writes, and off/profile-mismatch zero-write rejection. Server correctness under per-file isolation: 968 passed, 5 expected skips, 0 failed across 68 files.
- The same Task 5 reviewer returned final **APPROVE**, Critical 0. Acceptance commit: `1f2cc26`.
- The default non-isolated Bun aggregate has two cross-file module-cache failures that pass under `--isolate`; this is recorded as a non-Critical test-runner backlog and is not presented as an all-green default aggregate.

## Delivery Milestones

1. **After Task 1:** A reproducible isolated Windows/NTFS experiment machine exists; no L1 capability claim.
2. **After Task 2:** Rollback-journal VM hard-reset evidence exists; production remains disabled.
3. **After Task 3:** Both required evidence matrices exist; production remains disabled pending trust-root review.
4. **After Task 4:** Production authority/controller/lifecycle code is wired but remains fail-closed without a reviewed manifest.
5. **After Task 5:** A usable Windows production L1 candidate exists for one exact externally attested profile.

The phrase **full cross-platform L1 complete** remains prohibited. Task 5 does not change these ledger states: benchmark/performance stays `NOT_RUN`; formal binary-token gate stays `NOT MET/DEFERRED`; same-path adoption, other platform evidence, installer validation, tag, push, and release remain incomplete or unauthorized.

## Plan Self-Review

- Production cannot become enabled before both matrices and a reviewed immutable trust root.
- The current arm-only probe is not counted as hard-reset evidence.
- VirtualBox shared folders are excluded from the tested durability root.
- The exact 13-row rollback matrix and exact 19-row directory-entry matrix are separate capability envelopes.
- The production EXE never embeds or validates its own final SHA-256; the external candidate attestation owns that binding.
- Production code/controller wiring is committed before the final evidence run; any later production-code change invalidates the evidence.
- Each slice has one RED, one GREEN, one blocker-only review, and an immediate commit.
- No placeholder work, versioning, packaging, or release action is hidden in this plan.
