# Configurable Storage CLI Final Fix Report

Date: 2026-07-30

Branch: `codex/configurable-storage-cli`
Binding brief: `.superpowers/sdd/final-review-findings.md`

## Status

The requested review findings were addressed:

- One cross-platform `scripts/build-sidecars.mjs` path now embeds WASM once, reads the
  native host triple from `rustc -vV`, requires Bun 1.3.14, and emits both Tauri
  target-triple sidecars with `.exe` only for Windows triples.
- `package.json`, local Tauri `beforeBuildCommand`, and all three existing CI build
  jobs use the shared path exactly once through the Tauri hook. The jobs and
  triggers/topology were not changed; all three Bun setup steps are pinned to 1.3.14
  and the duplicate/manual compile/rename blocks are gone.
- Migration copies into a unique same-parent staging directory, compares source and
  staging SHA-256 manifests, and publishes only by rename after full verification.
  Copy/hash/publication failure cleans the internally-created staging directory,
  preserves the source, and leaves an absent or pre-existing empty final target
  retryable. A pre-existing empty target is atomically moved to an internal backup and
  restored with the same directory identity if publication fails. CLI persistence
  remains after successful migration only.
- Positive legacy recent-project and Windows `REG_SZ`/argument-array tests were added.
- README and the implementation plan now distinguish plain `set` (new/empty directory,
  no copy) from `set --migrate` and document source retention/safety.

## TDD RED Evidence

The first in-sandbox Node runs were not accepted as product RED evidence because the
sandbox denied `node:test` worker creation:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test scripts/tests/build-sidecars.test.mjs` | 1 | Infrastructure failure: `spawn EPERM`. |
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 1 | Infrastructure failure: both test files failed at worker spawn with `EPERM`. |
| `node --test server/tests/recent-projects.test.js server/tests/path-store.test.js` | 1 | Infrastructure failure: both test files failed at worker spawn with `EPERM`. |

The tests were then rerun outside that sandbox restriction:

| Command | Exit | RED result |
|---|---:|---|
| `node --test scripts/tests/build-sidecars.test.mjs` | 1 | Expected product RED: `ERR_MODULE_NOT_FOUND` for `scripts/build-sidecars.mjs`. |
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 1 | Expected product RED: 16 pass / 3 fail. The CLI ignored the injected migration boundary, and copy/hash fault tests reported “Missing expected exception,” proving direct-final-target behavior. |
| `node --test server/tests/recent-projects.test.js server/tests/path-store.test.js` | 0 | 6/6 pass. These are the two requested positive coverage additions for already-correct behavior, not production behavior changes. |

No production implementation was changed before the product RED runs.

## GREEN Evidence

| Command | Exit | Result |
|---|---:|---|
| `node --test scripts/tests/build-sidecars.test.mjs` | 0 | 4/4 pass: triple parsing, output naming, Bun 1.3.14, local/CI shared packaging path and both `externalBin` entries. |
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 19/19 pass. |
| `node --test server/tests/recent-projects.test.js server/tests/path-store.test.js` | 0 | 6/6 pass. |
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` (after making CLI fault injection call the real migration implementation) | 0 | 19/19 pass; copy and manifest failures now exercise real staging/copy/hash cleanup while asserting configuration/source/final-target state. |

Independent review then identified two additional Important cases. Both received a
new RED before implementation:

| Command | Exit | Review RED result |
|---|---:|---|
| `node --test scripts/tests/build-sidecars.test.mjs` | 1 | 3/4 pass; static packaging assertion expected zero explicit CI sidecar steps but found three, proving each CI job would compile once explicitly and once through Tauri's hook. |
| `node --test server/tests/storage-migration.test.js` | 1 | 9/10 pass; injected staging-to-final rename failure restored an empty directory with a different inode, proving the original target identity/ACL container had been discarded. |
| `node --test scripts/tests/build-sidecars.test.mjs` after fix | 0 | 4/4 pass; all three jobs now reach the shared path only through their Tauri build hook. |
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` after fix | 0 | 20/20 pass; publication failure atomically restores the same original empty target and removes internal migration paths. |

## Required Verification Log

| Command | Exit | Result |
|---|---:|---|
| `pnpm test:server` (before independent review) | 0 | 30/30 server tests pass. |
| `pnpm test:server` (final, after independent-review fixes) | 0 | 31/31 server tests pass. |
| `pnpm typecheck` | 0 | TypeScript check completed with no errors. |
| `pnpm build` | 0 | Vite production build completed. It retained the existing informational chunk-size warning for the 583.76 kB main chunk. |
| Temporary PATH prepend, `bun.exe --version; rustc -vV; pnpm build:sidecar` | 0 | Bun `1.3.14`; host `x86_64-pc-windows-msvc`; both target-triple sidecars built. No machine path was written to the repository. |
| Final temporary PATH prepend, `bun.exe --version; pnpm build:sidecar` | 0 | Fresh post-review build with Bun 1.3.14 emitted both target-triple sidecars. |
| Compiled CLI `data-dir get` | 0 | Read-only output: `C:\Users\wanghongao\.mythpen`. |
| Compiled CLI `export-dir get` | 0 | Read-only output: `C:\Users\wanghongao\.mythpen\exports`. |
| Compiled CLI with no arguments | 2 | Usage/help printed. |
| Compiled CLI `data-dir get unexpected` | 2 | Invalid shape rejected and usage printed. |
| `pnpm tauri build` (Bun 1.3.14 temporarily on PATH) | 1 | Environment-only block before build hooks: host Cargo 1.54.0 cannot parse Rust 2021 edition (`feature edition2021 is required`). This command was attempted once and not silently retried. |
| `node --test scripts/tests/build-sidecars.test.mjs` (fresh after Tauri failure) | 0 | 4/4 pass. |
| Resolve `tauri.conf.json` `externalBin` entries against the `rustc -vV` host triple and assert both files exist | 0 | Located `mythpen-server-x86_64-pc-windows-msvc.exe` and `mythpen-cli-x86_64-pc-windows-msvc.exe`. |
| `git diff --check` | 0 | No whitespace errors/output. |
| `git status --short` | 0 | Only intentional source/test/docs/workflow changes and the two new build-script files were present before this report. Generated binaries are ignored. |

Exact full Tauri error:

```text
failed to run 'cargo metadata' command to get workspace directory:
failed to parse manifest at `src-tauri\Cargo.toml`
Caused by:
  feature `edition2021` is required
```

Host toolchain evidence:

```text
rustc 1.54.0 (a178d0322 2021-07-26)
cargo 1.54.0 (5ae8d74b3 2021-06-22)
stable-x86_64-pc-windows-msvc (default)
```

## Safety Evidence

- No real CLI `set` or `--migrate` command was executed.
- No user registry value, configured novel directory, or export directory was written.
- Migration tests use temporary directories and injected in-memory stores/filesystem
  boundaries.
- Read-only compiled smoke was limited to `get`, usage/help, and invalid arguments.
- Fault tests confirm source contents survive, configuration does not change, staging
  is absent after failure, and the final target can be retried.

## Self-review and Independent Review

The final diff was checked against every binding brief item. The staging directory is
created only after source/final-target validation, on the same parent/volume as the
final target. A pre-existing empty target is moved to a unique sibling backup only after
manifest equality; if publication fails, that same directory is moved back before the
error propagates. Cleanup targets only the owned staging directory or an owned empty
backup; unowned backup candidates are never changed. CI triggers and job topology are
unchanged.

The independent review reported no Critical issues and two Important issues:

1. Duplicate CI sidecar compilation through an explicit step plus Tauri hook.
2. Loss of existing-empty-target identity on publication rename failure.

Both were reproduced with RED tests, fixed, and verified GREEN as recorded above. The
review found no other blocking issue in the Minor tests, Bun pinning, triple naming,
README, or plan.

## Final Minor Follow-up

A final review requested two additional Minor closures.

### Backup candidate ownership and collision retry

RED was established before production changes:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/storage-migration.test.js` | 1 | 10/11 pass. The new occupied-candidate test expected two injected candidate names but observed zero, proving the existing `mkdtemp` reservation flow did not implement direct collision-safe rename ownership. |

GREEN and full verification:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 21/21 pass. The first candidate returns injected `EEXIST`, migration retries a second candidate, publishes successfully, and preserves the external directory/file. Existing publication-failure coverage still restores the same original empty-target inode. |
| `pnpm test:server` | 0 | 32/32 server tests pass. |
| `git diff --check` | 0 | No whitespace errors/output. |
| `git status --short --branch` | 0 | Only the four intentional follow-up files were modified before commit. |

Production now generates a high-entropy `crypto.randomUUID()` candidate by default,
with an injectable generator for deterministic fault tests. It directly attempts
`renameSync(finalTarget, candidate)` without creating or probing the candidate. Only a
successful rename establishes backup ownership. `EEXIST`/`ENOTEMPTY` retries another
candidate; no unowned path is removed. Owned backup cleanup uses `rmdirSync` only.

### Implementation-plan authority

Task 2 no longer contains the stale long implementation snippet or the undefined
`reserveUniqueSiblingPath`. It now records the actual interfaces and precise contracts
for physical realpath/reparse validation, nesting rejection, owned staging, SHA-256
manifests, collision-safe owned backup acquisition, publication/rollback, and cleanup.
It explicitly identifies `server/storage-migration.js`,
`server/tests/storage-migration.test.js`, and `server/tests/cli.test.js` as the
authoritative production implementation and executable examples.

## Windows Native Rename Follow-up

A final Windows-native review showed that naked
`renameSync(finalTarget, backupCandidate)` may replace an existing external file rather
than returning `EEXIST`. The prior random-name retry therefore did not establish safe
ownership.

RED evidence:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/storage-migration.test.js` | 1 | 10/12 pass. With real Windows filesystem semantics, the old implementation replaced and removed the pre-existing external backup-prefix file. The injected publish+restore double failure also returned only the publication error instead of preserving/reporting an owned recovery location. |

GREEN evidence:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 22/22 pass. Real external file, empty directory, and non-empty directory siblings retain their inode/content; successful publication works; publication failure restores the same target inode; restoration failure leaves that inode at `<owned-container>/original-target`, removes staging, and reports the full location. |
| `pnpm test:server` | 0 | 33/33 server tests pass. |
| `git diff --check` | 0 | No whitespace errors/output. |
| `git status --short --branch` | 0 | Only the four intentional Windows-native follow-up files were modified before commit. |

The final ownership model is:

1. Staging remains a separately owned `mkdtempSync` directory and is the only path
   recursively removed after failure.
2. An existing empty final target gets an atomically-created owned sibling backup
   container from `mkdtempSync(".<base>.mythpen-backup-")`; the container is never
   deleted and recreated.
3. The original target moves only to the guaranteed-absent
   `<owned-container>/original-target` child.
4. Successful publication removes the empty child and container with `rmdirSync`.
5. Failed publication restores the child to the final path and then removes the empty
   container. Failed restoration preserves both owned container and child and reports
   the exact manual recovery location; backup data is never recursively deleted.

Task 2's implementation contract was updated to match this final model and continues
to point to the production module and fault tests as the implementation authority.

## Explicit Migration Commit Point

The final Important review established that a fully verified
`renameSync(staging, finalTarget)` is the migration commit point. The backup contains
only the pre-migration empty placeholder, so post-commit backup cleanup must never
cause the CLI to retain the old configured path.

RED evidence:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 1 | 22/25 pass. Injected `rmdirSync(original-target)` and `rmdirSync(backupContainer)` failures escaped as migration errors; CLI returned 1 and did not persist the already-published target. |

GREEN evidence:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 25/25 pass. Both cleanup failures leave the complete new final target and unchanged source, preserve all external content, return exact residual-path/error warnings, and make CLI persist the target before printing warnings with exit 0. |
| `pnpm test:server` | 0 | 36/36 server tests pass. |
| `git diff --check` | 0 | No whitespace errors/output. |
| `git status --short --branch` | 0 | Only the seven intentional commit-point follow-up files were modified before commit. |

Final semantics:

- `published = true` immediately after the verified staging-to-final rename succeeds.
- Child cleanup failure records its exact path/error and skips container removal.
- If child cleanup succeeds but container cleanup fails, the empty container path/error
  is recorded.
- `copyAndVerifyDirectory()` returns `cleanupWarnings`; no backup path is recursively
  removed.
- The CLI calls `store.set` after the verified publish returns, then emits each
  “迁移已完成，但临时备份清理失败...” warning.
- README and Task 2 now document this commit point and manual-cleanup warning behavior.

## No-clobber Publication and Stdout Boundary

The final review identified two Windows safety/ordering defects:

1. The CLI printed a success summary before `store.set`, so a throwing stdout could
   leave published data with the old configured path.
2. Windows can replace a race-created external file during
   `renameSync(staging, finalTarget)`; `existsSync` checks cannot make that rename
   no-clobber.

RED evidence:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/cli.test.js` | 1 | 11/13 pass. First-success-output failure left the old store value after publication; a real Windows race-created file was replaced and migration returned success. |

GREEN evidence:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 27/27 pass. Stdout failures return 1 and are reported on stderr only after the new path is persisted. Real race-created file and directory targets retain identity/content, source remains unchanged, configuration does not switch, and the error clearly reports a publication conflict. |
| `pnpm test:server` | 0 | 38/38 server tests pass. |
| `git diff --check` | 0 | No whitespace errors/output. |
| `git status --short --branch` | 0 | Only the seven intentional final-review files were modified before commit. |

Final publication semantics prioritize no-clobber safety over atomic directory rename:

- A pre-existing empty placeholder is first preserved in its owned backup container.
- The final path is atomically claimed with non-recursive `mkdirSync`; `EEXIST` is a
  conflict, never something to overwrite.
- The verified staging tree is copied with `force:false` / `errorOnExist:true`, and the
  final SHA-256 manifest must match the source before commit.
- Conflict/failure never recursively removes the final target. External content and
  source remain untouched; a partially populated final target may require manual
  inspection before retry.
- The final manifest match is the commit point. All successful stdout writes occur
  after `store.set`; stdout failure has exit code 1 but cannot produce a
  published-data/old-configuration split.

README and Task 2 were updated to this commit point. Task 3's stale implementation
block was replaced with the current parameters, `cleanupWarnings`, environment
override behavior, persistence/output ordering, and exit-code contract.

## Exclusive Entry Publication and Store Failure Recovery

RED: `node --test server/tests/cli.test.js` exited 1 with 13/15 passing. A committed
migration whose `store.set` failed only printed the low-level error, and a same-name
external directory was merged into and committed.

GREEN:

- `node --test server/tests/storage-migration.test.js server/tests/cli.test.js`: exit 0,
  29/29.
- `pnpm test:server`: exit 0, 40/40.

Publication now creates directories with non-recursive `mkdirSync` and files with
`copyFileSync(..., COPYFILE_EXCL)`. The manifest records directories as well as files,
while `fileCount`/`totalBytes` still count files only. Real Windows tests preserve the
inode/content of same-name empty and non-empty external directories and detect an
extra empty directory; source/configuration remain unchanged and no `story.md` is
added to external nodes.

If `store.set` fails after migration commit, CLI exits 1 with a diagnostic containing
the committed absolute target, configuration failure, retained source, full recovery
command `mythpen-cli <scope> set "<target>"`, and original error. Plain-set failures
remain clearly described without claiming a migration commit.

## Reparse Rejection, Publication Ownership, and Residual Recovery

The final safety review found three remaining boundaries:

1. Final manifest traversal could silently omit a junction/reparse or unsupported
   filesystem entry.
2. Newly claimed root and nested directories were empty briefly enough to permit
   `rmdir` plus replacement while publication was still copying.
3. A post-commit `store.set` failure did not include cleanup residuals already returned
   by the migration.

Implemented semantics:

- Manifest and publication traversal explicitly reject symlinks, junctions/reparse
  points, and unsupported `Dirent` types.
- Every claimed directory receives an exclusive random ownership marker before its
  contents are copied. Markers remain through final manifest comparison, and only the
  exact marker paths created by this invocation are ignored by that comparison.
- After commit, marker removal is best-effort; each failure becomes an exact
  `{ path, error }` cleanup warning. No final target, external junction target, source,
  or backup is recursively removed.
- If configuration persistence fails after commit, the recovery diagnostic lists every
  returned residual path/error in addition to the committed target, retained source,
  recovery command, and configuration error.

Verification evidence:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 32/32 passed after the initial implementation; real Windows final-junction injection preserved the external inode/content and prevented configuration switching, while root/nested marker probes could not remove claimed directories. |
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 34/34 passed after adding focused unsupported-`Dirent` rejection and exact post-commit marker-residual coverage. |
| `pnpm test:server` | 0 | 45/45 server tests passed. |
| `git diff --check` | 0 | No whitespace errors or output before commit. |
| `git show --check --stat --oneline HEAD` | 0 | No committed-patch errors; the worktree was clean before recording this result. |

## Absolute Launcher and Filesystem-Corroborated Moves

Review of `3afc038` found three Important boundaries:

1. Bare `powershell.exe` remained vulnerable to CWD/`PATH` executable resolution.
2. A completed `Directory.Move` followed by an erroneous callback was treated as
   uncommitted, leaving published data with the old configured path.
3. The empty-placeholder backup still used naked `renameSync`, so a raced
   `original-target` child could be replaced and later removed.

RED evidence:

| Command | Exit | Evidence |
|---|---:|---|
| Focused 3-Important regression command | 1 | 0/9 passed: bare executable captured, invalid roots reached `execFile`, final/backup synthetic callback errors were rejected, false-success callback was accepted, and backup did not use the helper. |

Implemented semantics:

- PowerShell resolves only to an absolute
  `<SystemRoot|WINDIR>\System32\WindowsPowerShell\v1.0\powershell.exe`. Missing or
  relative roots and relative test overrides fail before process launch. A fake
  `powershell.exe` in CWD/`PATH` is never selected.
- Before both backup and final moves, the helper records owned source directory type,
  `dev`, `ino`, and `birthtimeMs`. After normal or error/signal callbacks, commit
  requires source absence plus a non-reparse target with exactly the same identity.
  A callback error after a proven move cannot block configuration persistence, and a
  success callback without filesystem proof is rejected.
- Empty-placeholder backup now uses the same atomic no-replace helper. A raced file,
  ordinary directory, or junction at `original-target` is preserved along with the
  original target. Cleanup only attempts `rmdir` on the owned container; if that fails,
  the thrown error retains the original move error and reports exact container/child
  residuals. No external target is written, unlinked, or recursively removed.

GREEN evidence so far:

| Command | Exit | Evidence |
|---|---:|---|
| Focused 3-Important regression command | 0 | 9/9 passed, including final and backup callback-error corroboration plus three real Windows backup-child conflict types. |
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 44/44 focused tests passed. |
| `pnpm test:server` | 0 | 55/55 server tests passed. |
| `git diff --check` | 0 | No whitespace errors or output before commit. |
| `git show --check --stat --oneline HEAD` | 0 | No committed-patch errors; the worktree was clean before recording this result. |

## Atomic No-Replace Publication Supersedes Markers

Commit `e500baf` was rejected after a real Windows counterexample demonstrated that
the marker protocol could not close its own race windows: a target directory could be
replaced between `mkdir` and marker creation, and an ignored marker path could itself
be replaced before cleanup. That protocol and its final-tree copy are removed.

Root cause:

- Multiple filesystem operations (`mkdir`, marker write, entry copies, manifest walk,
  marker unlink) could not form one atomic ownership transition.
- Ignoring a marker pathname did not prove that the directory entry at that pathname
  was still the owned marker.
- Therefore the old flow could write into or unlink an external replacement.

RED evidence:

| Command | Exit | Evidence |
|---|---:|---|
| `node --test --test-name-pattern "atomically publishes|Windows atomic publication" server/tests/storage-migration.test.js` | 1 | 0/4 passed because the required atomic helper did not exist. |
| `node --test --test-name-pattern "migration publishes through the Windows atomic helper boundary" server/tests/cli.test.js` | 1 | The old marker flow never called the injected helper (`0 !== 1`). |

Current implementation:

- Source is copied to an owned sibling staging directory; source/staging manifests
  include directories and file size/SHA-256 and reject links/reparse/unsupported
  entries.
- `atomicMoveDirectoryNoReplace()` launches a fixed PowerShell script through
  callback-style `execFile`. Source and target are UTF-16LE Base64 argument values,
  decoded inside a fixed scriptblock, so paths are never interpolated into executable
  text and PowerShell 5 cannot split spaces.
- `[System.IO.Directory]::Move(staging, final)` is the commit point. It succeeds only
  when final is missing. Existing files, ordinary directories, and junctions are not
  replaced.
- `copyAndVerifyDirectory()` is asynchronous and the CLI awaits it before persisting
  configuration. Non-Windows migration fails closed rather than using naked rename.
- The original source, conflicting final target, external junction destination, and
  owned backup are never recursively removed. Post-commit empty-backup cleanup warnings
  and `store.set` recovery residual diagnostics remain intact.

GREEN evidence so far:

| Command | Exit | Evidence |
|---|---:|---|
| Atomic helper real-Windows focus | 0 | 4/4: missing Unicode/space target moved successfully; existing file, ordinary directory, and junction retained identity/content. |
| CLI helper-boundary focus | 0 | File/directory/junction races each invoked the helper once, failed without commit, and retained source/configuration/external state. |
| `node --test server/tests/storage-migration.test.js server/tests/cli.test.js` | 0 | 36/36 focused tests passed, including encoded argument injection, non-Windows fail-closed, unsupported staging entry, cleanup warnings, and store recovery residuals. |
| `pnpm test:server` | 0 | 47/47 server tests passed. |
| `git diff --check` | 0 | No whitespace errors or output before commit. |
| `git show --check --stat --oneline HEAD` | 0 | No committed-patch errors; the worktree was clean before recording this result. |
