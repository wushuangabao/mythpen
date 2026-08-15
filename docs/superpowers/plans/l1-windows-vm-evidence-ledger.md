# Windows L1 VirtualBox Evidence Ledger

Date: 2026-08-14  
Execution plan: `2026-08-13-l1-windows-vm-evidence.md`

This ledger records only evidence that was actually produced. A completed VM
baseline does not prove either native durability capability and does not enable
production activation.

## Current status

| Gate | Status | Evidence boundary |
|---|---|---|
| Task 1 isolated Windows/NTFS baseline | **COMPLETE** | Manual clean install, Guest Additions, guest-local NTFS smoke, normal shutdown, immutable snapshot |
| Task 2 rollback-journal hard-reset matrix | **COMPLETE** | Task 5 accepted rerun: 13/13, exact source/profile, zero failures |
| Task 3 application-directory hard-reset matrix | **COMPLETE** | Task 5 accepted rerun: 19/19, exact source/profile/512-byte sector, zero failures |
| Task 4 production authority / trust-root plumbing | **COMPLETE** | Commit `6d8342f`; exact reviewed manifest was authorized only during Task 5 candidate build |
| Task 5 Windows production candidate E2E | **COMPLETE — EXACT PROFILE** | Externally attested candidate; real REST activation, two restarts, retained writes, zero-write negative controls |
| Benchmark, other platforms, installer, tag, push, release | **NOT_RUN / OUT OF SCOPE** | No release claim |

## Task 2 rollback-journal hard-reset evidence

The accepted run used source commit
`aec515aafd40c785d920ecac931ced6afeb3e0cd` and the compiled probe SHA-256
`E74286FD65C064808CA1A7FA597A67E238161CDFA19E2719723CF1C7CD5F26AB`.
Raw evidence is stored outside the repository at:

`D:\Mythpen\l1-vm\evidence\rollback-journal\2026-08-14T06-52-57-187Z-9b5450ac-915e-463e-bf3f-f19c326344ae`

The single accepted run contains:

- 13 exact ordered crash cuts, 13 `arm.json`, 13 `cold.json`, 13 `row.json`,
  and zero `failure.json` files;
- host-observed VM `running` state immediately before every external
  `VBoxManage controlvm <uuid> poweroff`;
- rows 1–8 uniquely converged to before with durability seq 0;
- rows 9–13 uniquely converged to after with durability seq 1;
- an empty write gate and exact source/prepared/terminal relationships in every
  cold inspection;
- `externalVmResetVerified=true` per row, while row, cold frame, and manifest
  all keep `capability=false`.

Fresh focused verification was 5 passed, 0 failed for the rollback probe and
capability tests; the host runner was 9 passed, 0 failed. The blocker-only
evidence review was **APPROVE** with Critical 0, reproducible data-loss risks 0,
and runtime-authority bypasses 0.

Earlier incomplete/debug runs remain external audit traces and are not counted
as accepted evidence. Task 2 does not authorize production: the rollback
runtime inspector remains non-authoritative, Task 3 application-directory
evidence cannot substitute for its separate capability envelope, and the
reviewed external trust root is still `NOT_RUN`.

## Task 3 application-directory hard-reset evidence

The accepted run used source commit
`c5c0c57138f32d4bfd10947d34422e8323c6c75b` and the compiled probe SHA-256
`0391615360D84976A45162C7F75AF59FCD571BDAD226DB40A26745427890A69B`.
Raw evidence is stored outside the repository at:

`D:\Mythpen\l1-vm\evidence\application-directory\2026-08-14T14-08-45-201Z-c7f6682a-4151-4f07-b00d-bab59945fdc3`

The single accepted run contains:

- all 19 exact ordered crash cuts across ControlStore append, checkpoint
  tail/install/GC/retire, and activation prepared/activated/aborted windows;
- 19 accepted cold-recovery rows and zero failures over 4,700.2 seconds;
- exact before/after convergence without partial checkpoint promotion, lost
  committed evidence, or duplicate activation/checkpoint identity;
- exact schema-10/no-native-state convergence for the aborted rows, preserving
  the prepared/aborted identity and remaining stable across a second cold
  inspection;
- `complete=true` in the run manifest while capability and runtime authority
  remain `false`.

Post-matrix focused verification was 11 passed, 0 failed; the host runner was
14 passed, 0 failed; changed-file syntax checks and `git diff --check` passed.
The first blocker-only review found that an earlier run incorrectly allowed the
aborted rows to continue to schema 11. That earlier run is invalid evidence.
Commit `c5c0c57` closed the issue, the entire 19-row matrix was rerun from clean
source, and the same reviewer returned **APPROVE** with Critical 0 and
reproducible data-loss risks 0.

Earlier incomplete/debug runs remain external audit traces and are not counted
as accepted evidence. These results are VM hard-reset evidence, not physical
power-loss evidence. They do not authorize production activation: Task 4's
reviewed external manifest is still `NOT_RUN`, and production therefore remains
`DURABILITY_UNSUPPORTED`.

## Task 4 fail-closed production authority plumbing

Commit `6d8342f` introduced the production-owned controller registry, opaque
one-shot activation authority bound to the exact canonical database path/dbKey
and embedded profile, the production-only sidecar entry, and deterministic
reviewed-manifest/profile build plumbing. `db.js` no longer imports a testing
controller or any `server/testing/*` module.

The implementation is deliberately non-authorizing at this ledger state:

- runtime JSON, environment variables, CLI objects, fixture receipts, and duck
  typed controllers cannot mint production authority;
- off, fixture-only, and production controller modes are not interchangeable;
- a production build without an exact compile-time reviewed manifest/profile
  fails `DURABILITY_UNSUPPORTED` before filesystem, lease, ControlStore,
  SQLite, or activation mutation;
- ordinary project open remains non-activating; production enable is restricted
  to an exact registered schema-10 project under ConfigLifecycleLease then the
  project writer turn, with v1 flush/close and atomic native adapter replacement;
- the embedded profile identity is exact VirtualBox `7.2.14`, SATA,
  `IntelAhci`, host I/O cache disabled, matching the accepted VM ledger. NVMe
  and wrong-controller profiles are rejected.

Exact focused verification was 23 passed, 0 failed. The expanded related suite
was 165 passed, 2 platform skips, 0 failed; the post-review affected suite was
65 passed, 2 platform skips, 0 failed. Nineteen syntax checks and
`git diff --check` passed. The single blocker-only review found and closed an
incorrect NVMe profile fixture, then returned **APPROVE**. No production
candidate, external reviewed manifest, VM rerun, benchmark, installer, tag,
push, or release was produced by Task 4.

## Task 5 accepted Windows production candidate

The first Task 5 evidence attempt from `e730a24` is invalid audit history. It
exposed a directory-probe bug that wrote the 4,096-byte allocation unit into a
`bytesPerSector` field while rollback evidence correctly reported 512. No
manifest or candidate was authorized from those runs. Commit `f3641a2` fixed the
probe to query the tested volume, passed 17/17 focused tests and blocker-only
review, and became the frozen source for the accepted reruns.

Accepted evidence and authority:

- frozen source: `f3641a2f0e1da237ce900e04547556f72ae5457e`;
- rollback run: `D:\Mythpen\l1-vm\evidence\rollback-journal\2026-08-14T18-57-20-476Z-9b1b1ce9-f15d-4367-a89a-58a2ab21b625`, 13/13, zero failures, probe SHA-256 `51e5aad3211ac250c02c98048ebd6c7db2a62ef5a7c6df6346d3070f9b9b77d9`;
- directory run: `D:\Mythpen\l1-vm\evidence\application-directory\2026-08-14T19-52-35-265Z-28df81c3-24e2-4334-9a50-fdbcfdc642d4`, 19/19, zero failures, probe SHA-256 `b50342294a027f4516754a994b1da0c982ae4dc45e28fa53f5b760bbc7cd4fb8`;
- both envelopes bind the same Bun 1.3.14, SQLite 3.53.0/source ID, Win32 VFS, NTFS 512-byte sector, Windows LTSC, and VirtualBox 7.2.14 SATA/IntelAhci/cache-disabled profile;
- external reviewed manifest: `D:\Mythpen\l1-vm\evidence\windows-l1-reviewed-manifest.json`, canonical/authorization SHA-256 `2caedf0e34b5e45db3ee268deae0e212258e78b8360ac3603a48975ca1309709`;
- manifest review: **APPROVE** before it was used as build input.

Accepted candidate and runtime proof:

- executable: `src-tauri\target\production-sidecars\mythpen-server-production-x86_64-pc-windows-msvc.exe`, 103,717,376 bytes, SHA-256 `a0cc26f1e442a1e9167914ab0285e8b37c1cc6e3436450aa48413475c30cd04c`;
- external attestation: `D:\Mythpen\l1-vm\evidence\windows-l1-production-attestation.json`, SHA-256 `3c83b2b9cdda0c8a34db32c310f75a2a51815a93359ce146c67930db348534b3`;
- final EXE SHA appears only in the attestation, not in the executable's embedded trust root;
- compiled production E2E: 3/3 passed — no-manifest zero-write rejection, attested real REST schema-10 activation/native read-write/two restarts/retained second write, and off/profile-mismatch zero-write rejection;
- correctness: controller 5/5, related focused 80 pass/2 expected skips, fixture compiled REST 1/1, build/VM contracts 28/28, and 68 isolated server files 968 pass/5 expected skips/0 failures;
- final Task 5 review: **APPROVE**, Critical 0; acceptance commit `1f2cc26`.

This accepts one exact Windows production candidate profile. It is not a
physical-power-loss claim or a full cross-platform L1 claim. Benchmark,
formal binary-token gate, same-path adoption, other-platform evidence,
installer/package validation, tag, push, and release remain `NOT_RUN`,
`DEFERRED`, incomplete, or unauthorized as stated below.

## Task 1 manual installation record

The automated install path was not used to weaken or replace durability
evidence. VirtualBox 6.1.6 returned `E_NOTIMPL` during ISO detection. After the
approved in-place upgrade, VirtualBox 7.2.14 generated an unattended answer file
with an empty product key that Windows Setup rejected. The approved recovery was
a manual clean installation:

1. Attach the verified original Windows ISO to the isolated target VM.
2. Choose **Custom: Install Windows only**, select the single 64 GiB unallocated
   virtual disk, and let Setup create its normal partitions.
3. Complete Windows OOBE with a task-scoped local account. Password and recovery
   answers remain only in the external secret file and are not recorded here.
4. Install the bundled VirtualBox 7.2.14 Guest Additions and restart Windows.
5. Detach the Windows ISO; SATA port 1 is now `emptydrive`.
6. Create `C:\Mythpen-L1-TestData` on guest-local NTFS and complete the
   write-through flush/readback smoke.
7. Shut Windows down normally from the interactive desktop and create the
   immutable powered-off snapshot `mythpen-l1-baseline-v1`.

The manual path changes only installation mechanics. The hard-reset matrices
still use host-driven VirtualBox power-off and cold verification as specified by
Tasks 2 and 3.

## Exact environment identity

| Property | Recorded value |
|---|---|
| VirtualBox | `7.2.14r174565` |
| Guest Additions | `7.2.14 r174565` |
| Windows product | `Windows 10 Enterprise LTSC 2021 Evaluation` |
| Windows display version | `21H2` |
| Windows build | `19044.1288` (`10.0.19044`) |
| Architecture | x64 |
| Guest computer name | `DESKTOP-R9H5HKA` |
| VM name | `Mythpen-L1-Win10-LTSC2021` |
| VM UUID | `a8f8e55e-e0ad-402f-aba2-ebfc061b0eaa` |
| VM state after baseline | `poweroff` |
| Base VDI UUID | `60a78c82-ddda-4cd0-9010-b284dfa25b5b` |
| Base VDI | dynamic VDI, 65,536 MiB |
| Storage controller | SATA / Intel AHCI, `useHostIOCache=false` |
| Network | NAT only; no port forwarding |
| Shared integration | no shared folders; clipboard and drag-and-drop disabled |
| Optical drive after install | SATA port 1 `emptydrive` |
| Guest data root | `C:\Mythpen-L1-TestData` (guest-local) |
| Filesystem | NTFS |
| Logical / physical sector | 512 / 512 bytes |
| Allocation unit | 4,096 bytes |
| Write-through readback | `true` |
| Baseline snapshot | `mythpen-l1-baseline-v1` |
| Baseline snapshot UUID | `d1cf0188-a2ed-44b2-bc9e-7157c4712a04` |

ISO:

- Path: `D:\Mythpen\l1-vm\downloads\Windows10EnterpriseLTSC2021Eval-x64-zh-cn.iso`
- Size: 5,043,298,304 bytes
- SHA-256: `2181EAAEED2F1A78BE41F45692671DB050D9FF76291F767AB696147C8A322DA3`

External evidence:

- `D:\Mythpen\l1-vm\evidence\environment\manual-install-identity.json`
- `D:\Mythpen\l1-vm\evidence\environment\smoke.json`
- VirtualBox snapshot metadata in the target `.vbox` file and snapshot list
- Secret: `D:\Mythpen\l1-vm\secrets\guest-credentials.json` (existence only;
  contents never committed or copied into evidence)

## Protected Ubuntu control

The pre-existing Ubuntu VM remained powered off and was never started, modified,
cloned, or deleted. Fresh post-baseline hashes equal the pre-execution values:

- VM UUID: `6c19b868-b08c-4f79-bd0e-e850a31e1e28`
- Config SHA-256: `46E8A08D3E358E57B0C54D8307751CB57B212CBB957EFF7B2FE3024BFEF48D68`
- VDI SHA-256: `16DC7BD5F248DA415E729E60663E29E240E71F89A7FF087C96773CA5239D45A1`
- State: `poweroff`

No VM was running when this record was closed.

## Verification and bounded backlog

- VM harness tests: 6 passed, 0 failed.
- `node --check` passed for the runner and its test.
- The baseline was shut down through the interactive Windows session because
  Guest Additions' non-interactive process session did not complete a normal
  shutdown. No forced power-off was used for the baseline.
- The current `inspect` command predates snapshot differencing disks and rejects
  the post-snapshot child VDI path. Snapshot-aware inspection and automated
  non-interactive baseline shutdown are backlog items; they do not weaken the
  immutable snapshot or the forthcoming host-driven hard-reset evidence.
