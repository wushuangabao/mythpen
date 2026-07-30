# Configurable Storage CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a packaged `mythpen-cli.exe` that can query and change Mythpen's novel-data and export directories, optionally copying and verifying existing data before switching paths.

**Architecture:** A side-effect-free path resolver will centralize all storage paths and read persistent overrides from `HKCU\Software\Mythpen` on Windows. A separate CLI entry point will perform guarded copy-and-verify migrations and update the registry only after success; the GUI sidecar will consume the same resolver at its next launch.

**Tech Stack:** CommonJS JavaScript, Node.js built-in test runner, Bun standalone compilation, Tauri v2 external binaries, Windows Registry via `reg.exe`

**Status:** Design approved by the user on 2026-07-30.

## Global Constraints

- Scope is limited to Mythpen writing data: SQLite databases, project cover files, project metadata, and generated exports.
- WebView cache and frontend `localStorage` remain in their operating-system-managed locations.
- `data-dir` and `export-dir` are independently configurable; the default export directory is `<data-dir>\exports`.
- Persistent Windows configuration uses `HKCU\Software\Mythpen` values `DataDir` and `ExportDir`; environment variables `MYTHPEN_DATA_DIR` and `MYTHPEN_EXPORT_DIR` may override them for one process.
- Migration must refuse to run while the Mythpen server is listening on `127.0.0.1:3001`.
- `data-dir set <path>` 与 `export-dir set <path>` 可用于切换到新的/空的目录，不复制或哈希既有文件；只有带 `--migrate` 的迁移会先复制并做 SHA-256 校验，成功后才改变配置，且从不删除源目录。
- Existing `recent_projects.file_path` absolute paths must be repaired after a data-directory move.
- No UI controls are added.

---

### Task 1: Central storage path resolution

**Files:**
- Create: `server/path-store.js`
- Create: `server/storage-paths.js`
- Create: `server/tests/storage-paths.test.js`

**Interfaces:**
- Produces: `createPathStore(options)` with `get(name)`, `set(name, value)`, and `delete(name)`.
- Produces: `resolveStoragePaths(options)` returning `{ dataDir, configDbPath, projectsDir, exportDir }`.
- Produces: `DATA_DIR_ENV`, `EXPORT_DIR_ENV`, `DATA_DIR_VALUE`, and `EXPORT_DIR_VALUE` constants.

- [ ] **Step 1: Write failing resolver tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveStoragePaths } = require('../storage-paths');

function fakeStore(values = {}) {
  return { get: (name) => values[name] || null };
}

test('defaults writing data to <home>/.mythpen', () => {
  const paths = resolveStoragePaths({
    homeDir: 'C:\\Users\\author',
    env: {},
    store: fakeStore(),
  });
  assert.equal(paths.dataDir, path.resolve('C:\\Users\\author', '.mythpen'));
  assert.equal(paths.projectsDir, path.join(paths.dataDir, 'projects'));
  assert.equal(paths.configDbPath, path.join(paths.dataDir, 'config.db'));
  assert.equal(paths.exportDir, path.join(paths.dataDir, 'exports'));
});

test('registry overrides defaults and export defaults under configured data dir', () => {
  const paths = resolveStoragePaths({
    homeDir: 'C:\\Users\\author',
    env: {},
    store: fakeStore({ DataDir: 'D:\\MythpenData' }),
  });
  assert.equal(paths.dataDir, path.resolve('D:\\MythpenData'));
  assert.equal(paths.exportDir, path.join(paths.dataDir, 'exports'));
});

test('explicit export directory and process environment take precedence', () => {
  const paths = resolveStoragePaths({
    homeDir: 'C:\\Users\\author',
    env: {
      MYTHPEN_DATA_DIR: 'E:\\SessionData',
      MYTHPEN_EXPORT_DIR: 'F:\\SessionExports',
    },
    store: fakeStore({
      DataDir: 'D:\\PersistentData',
      ExportDir: 'D:\\PersistentExports',
    }),
  });
  assert.equal(paths.dataDir, path.resolve('E:\\SessionData'));
  assert.equal(paths.exportDir, path.resolve('F:\\SessionExports'));
});
```

- [ ] **Step 2: Run the resolver tests and verify they fail**

Run: `node --test server/tests/storage-paths.test.js`

Expected: FAIL with `Cannot find module '../storage-paths'`.

- [ ] **Step 3: Implement the persistent path store**

`server/path-store.js` must use a fixed registry key and pass values to `reg.exe` as argument-array entries, never through a shell:

```js
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REGISTRY_KEY = 'HKCU\\Software\\Mythpen';
const FALLBACK_FILE = path.join(os.homedir(), '.mythpen-paths.json');

function createWindowsStore(execFile = execFileSync) {
  return {
    get(name) {
      try {
        const output = execFile('reg.exe', ['query', REGISTRY_KEY, '/v', name], {
          encoding: 'utf8',
          windowsHide: true,
        });
        const line = output.split(/\r?\n/).find((item) => item.includes(` ${name} `));
        const match = line && line.match(/\s+REG_\w+\s+(.+)\s*$/);
        return match ? match[1].trim() : null;
      } catch {
        return null;
      }
    },
    set(name, value) {
      execFile('reg.exe', ['add', REGISTRY_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    },
    delete(name) {
      try {
        execFile('reg.exe', ['delete', REGISTRY_KEY, '/v', name, '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        // Deleting an absent override is already the desired state.
      }
    },
  };
}

function createJsonStore(filePath = FALLBACK_FILE) {
  function read() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }
  return {
    get: (name) => read()[name] || null,
    set(name, value) {
      const values = { ...read(), [name]: value };
      fs.writeFileSync(filePath, JSON.stringify(values, null, 2), 'utf8');
    },
    delete(name) {
      const values = read();
      delete values[name];
      fs.writeFileSync(filePath, JSON.stringify(values, null, 2), 'utf8');
    },
  };
}

function createPathStore(options = {}) {
  const platform = options.platform || process.platform;
  return platform === 'win32'
    ? createWindowsStore(options.execFile)
    : createJsonStore(options.filePath);
}

module.exports = { REGISTRY_KEY, createPathStore, createWindowsStore, createJsonStore };
```

- [ ] **Step 4: Implement the central resolver**

`server/storage-paths.js` must normalize all configured values to absolute paths:

```js
const os = require('node:os');
const path = require('node:path');
const { createPathStore } = require('./path-store');

const DATA_DIR_ENV = 'MYTHPEN_DATA_DIR';
const EXPORT_DIR_ENV = 'MYTHPEN_EXPORT_DIR';
const DATA_DIR_VALUE = 'DataDir';
const EXPORT_DIR_VALUE = 'ExportDir';

function resolveStoragePaths(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const store = options.store || createPathStore();
  const dataDir = path.resolve(
    env[DATA_DIR_ENV] || store.get(DATA_DIR_VALUE) || path.join(homeDir, '.mythpen'),
  );
  const exportDir = path.resolve(
    env[EXPORT_DIR_ENV] || store.get(EXPORT_DIR_VALUE) || path.join(dataDir, 'exports'),
  );
  return {
    dataDir,
    configDbPath: path.join(dataDir, 'config.db'),
    projectsDir: path.join(dataDir, 'projects'),
    exportDir,
  };
}

module.exports = {
  DATA_DIR_ENV,
  EXPORT_DIR_ENV,
  DATA_DIR_VALUE,
  EXPORT_DIR_VALUE,
  resolveStoragePaths,
};
```

- [ ] **Step 5: Run the resolver tests**

Run: `node --test server/tests/storage-paths.test.js`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 6: Commit the resolver**

```powershell
git add server/path-store.js server/storage-paths.js server/tests/storage-paths.test.js
git commit -m "feat(storage): centralize configurable paths"
```

---

### Task 2: Safe copy-and-verify migration engine

**Files:**
- Create: `server/storage-migration.js`
- Create: `server/tests/storage-migration.test.js`

**Interfaces:**
- Produces: `validateMigrationPaths(sourceDir, targetDir, fsApi?)`.
- Produces: `copyAndVerifyDirectory(sourceDir, targetDir, options?)`.
- Produces: `isServerRunning(options)` for the CLI safety gate.

- [ ] **Step 1: Write failing migration tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  copyAndVerifyDirectory,
  validateMigrationPaths,
} = require('../storage-migration');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-${name}-`));
}

test('copies nested and Unicode-named files, verifies them, and retains source', async () => {
  const source = tempDir('source');
  const target = path.join(tempDir('target-parent'), 'data');
  fs.mkdirSync(path.join(source, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(source, 'config.db'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(source, 'projects', '暗影纪.mythpen.db'), 'novel');

  const result = await copyAndVerifyDirectory(source, target);

  assert.equal(result.fileCount, 2);
  assert.equal(fs.readFileSync(path.join(target, 'projects', '暗影纪.mythpen.db'), 'utf8'), 'novel');
  assert.equal(fs.readFileSync(path.join(source, 'projects', '暗影纪.mythpen.db'), 'utf8'), 'novel');
});

test('rejects a non-empty target and nested source/target pairs', () => {
  const source = tempDir('source');
  const target = tempDir('target');
  fs.writeFileSync(path.join(source, 'config.db'), 'source');
  fs.writeFileSync(path.join(target, 'existing.txt'), 'occupied');
  assert.throws(() => validateMigrationPaths(source, target), /目标目录必须为空/);
  assert.throws(
    () => validateMigrationPaths(source, path.join(source, 'nested')),
    /不能互相包含/,
  );
});
```

- [ ] **Step 2: Run the migration tests and verify they fail**

Run: `node --test server/tests/storage-migration.test.js`

Expected: FAIL with `Cannot find module '../storage-migration'`.

- [ ] **Step 3: Implement physical-path validation and owned atomic publication**

The authoritative production implementation and executable examples are:

- `server/storage-migration.js`
- `server/tests/storage-migration.test.js`
- `server/tests/cli.test.js`

The stable interfaces are:

```js
validateMigrationPaths(sourceDir, targetDir, fsApi?)
fileManifest(root, fsApi?)
copyAndVerifyDirectory(sourceDir, targetDir, {
  fsApi?,
  execFile?,
  platform?,
  powershellPath?,
  windowsRoot?,
}?)
isServerRunning(options?)
```

`copyAndVerifyDirectory()` is asynchronous because Windows atomic publication runs
through `execFile`.

The implementation contract is:

1. Resolve the logical source/final target and their physical paths through the nearest
   existing ancestor. Reject a missing/non-directory source, equal paths, physical
   source/target nesting, source-tree symlinks/reparse points, target symlinks/reparse
   points, a non-directory target, and a non-empty target before migration writes.
2. After validation, create a unique owned staging directory in the final target's
   parent.
3. Copy source into staging without modifying source. Build sorted source/staging
   manifests containing directory entries plus file relative path, byte length, and
   SHA-256. Manifest traversal rejects symbolic links, junctions/reparse points, and
   every unsupported `Dirent` instead of following or silently omitting them.
   Publication is forbidden unless the manifests are identical.
4. If an empty final target already exists, atomically create an owned unique sibling
   container with `mkdtempSync(".<base>.mythpen-backup-")`. Never delete and recreate
   that container. Move the original empty target to
   `<owned-container>/original-target` with the same atomic no-replace helper used for
   final publication. If a file, ordinary directory, or junction races into that child,
   preserve it and the original target. Only try `rmdir` on the empty owned container;
   if the external child makes it non-empty, report the exact container, child, cleanup
   error, and original move error. Never recursively remove either path.
5. Publication uses `atomicMoveDirectoryNoReplace(staging, target, options)`. On Windows,
   derive the absolute PowerShell 5.1 executable path as
   `<absolute SystemRoot|WINDIR>\System32\WindowsPowerShell\v1.0\powershell.exe`;
   missing or relative roots fail before `execFile`. A test-only `powershellPath`
   override must also be absolute. Never pass a bare executable name that CWD or `PATH`
   can resolve. Invoke `-NoProfile -NonInteractive -Command <fixed-script>` through
   callback-style `execFile` and an argument array. The fixed script uses `try/catch`,
   calls `[System.IO.Directory]::Move`, and exits 1 on failure. Encode source/target as
   UTF-16LE Base64 argument values so PowerShell 5 cannot split spaces and no path is
   interpolated into script text. Staging and final are siblings, so the move is same
   volume.
6. Before each backup or final helper invocation, `lstat` the owned source and record
   directory type, `dev`, `ino`, and `birthtimeMs`. After both normal and error/signal
   callbacks, corroborate that source is absent, target is a non-symlink real directory,
   and its identity exactly matches. That filesystem evidence is the irreversible
   commit point: a callback error after a proven move is success, while a success
   callback without matching identity is failure. An existing file, ordinary directory,
   or junction fails without replacement. On non-Windows, fail closed with an explicit
   unsupported-platform error; never fall back to naked `rename`. `execFile`, `platform`,
   `windowsRoot`, and `powershellPath` remain injectable for deterministic tests.
7. Every failure removes only the internally-created owned staging directory. Never
   recursively delete an owned backup container or child containing the original
   target, the final/external target, any unowned backup-prefix sibling, or the
   migration source. A failed publication leaves an original empty placeholder in the
   reported owned backup child.
8. After commit, perform only empty backup child/container cleanup. Cleanup failures
   are warnings, not migration failures.
   `copyAndVerifyDirectory()` returns `cleanupWarnings` containing the exact owned
   residual path and original error. If child removal fails, do not try to remove its
   non-empty container. The CLI persists the new configured path, then prints every
   warning as “迁移已完成，但临时备份清理失败...”, and still exits successfully.
   All successful stdout occurs after `store.set`; stdout failure returns exit 1 and is
   reported on stderr, but can never revert or prevent the already-persisted setting.
   If `store.set` itself fails after the migration commit, its recovery diagnostic must
   include the committed target, retained source, recovery command, original error, and
   every residual cleanup path/error returned by the migration.

Required fault tests cover copy failure, manifest/hash mismatch, atomic publication
conflicts that preserve an original placeholder in its owned backup child, and real
external file/empty-directory/non-empty-directory backup-prefix siblings. They also
inject child/container post-commit cleanup failures and assert complete published data,
unchanged source, persisted CLI configuration, exit code 0, and precise warnings.
Real Windows regressions additionally create a file, ordinary directory, and junction
at both backup-child and final-target helper boundaries and prove `Directory.Move`
preserves their identity/content, retains source/configuration, and refuses the commit.
They cover a missing Unicode/space target, absolute PowerShell resolution despite fake
CWD/PATH executables, invalid-root fail-closed behavior, parameter-array injection
without script interpolation, callback error after a physically completed backup/final
move, false-success callback rejection, non-Windows fail-closed behavior, unsupported
source/staging entries, and store failure with multiple residuals.

- [ ] **Step 4: Run migration tests**

Run: `node --test server/tests/storage-migration.test.js`

Expected: all migration tests pass, including injected copy, manifest/hash,
atomic-move false-success, callback-error, and final/backup conflict failures.
Pre-commit failures leave source/configuration unchanged, remove only owned staging,
and preserve every external conflict entry. Identity-corroborated post-commit
completion remains a committed success even when the move callback reports an error.

- [ ] **Step 5: Commit the migration engine**

```powershell
git add server/storage-migration.js server/tests/storage-migration.test.js
git commit -m "feat(storage): add verified directory migration"
```

---

### Task 3: User-facing CLI commands

**Files:**
- Create: `server/cli.js`
- Create: `server/tests/cli.test.js`

**Interfaces:**
- Consumes: `resolveStoragePaths`, `createPathStore`, `copyAndVerifyDirectory`, and `isServerRunning`.
- Produces: `runCli(argv, dependencies)` returning a numeric process exit code.
- Produces commands: `data-dir get`, `data-dir set <path> [--migrate]`, `export-dir get`, and `export-dir set <path> [--migrate]`.

- [ ] **Step 1: Write failing CLI tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../cli');

function memoryStore(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get: (name) => values[name] || null,
    set: (name, value) => { values[name] = value; },
    delete: (name) => { delete values[name]; },
  };
}

function output() {
  const lines = [];
  return { lines, write: (line) => lines.push(String(line)) };
}

test('data-dir get prints the effective data directory', async () => {
  const stdout = output();
  const code = await runCli(['data-dir', 'get'], {
    store: memoryStore({ DataDir: 'D:\\MythpenData' }),
    env: {},
    homeDir: 'C:\\Users\\author',
    stdout,
    stderr: output(),
  });
  assert.equal(code, 0);
  assert.deepEqual(stdout.lines, [path.resolve('D:\\MythpenData')]);
});

test('data-dir set --migrate switches only after a successful verified copy', async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-cli-source-'));
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-cli-target-')), 'data');
  fs.writeFileSync(path.join(source, 'config.db'), 'database');
  const store = memoryStore({ DataDir: source });
  const code = await runCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false,
    stdout: output(),
    stderr: output(),
  });
  assert.equal(code, 0);
  assert.equal(store.values.DataDir, path.resolve(target));
  assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'database');
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'database');
});

test('migration refuses to run while Mythpen is active and does not switch', async () => {
  const store = memoryStore({ DataDir: 'C:\\OldData' });
  const stderr = output();
  const code = await runCli(['data-dir', 'set', 'D:\\NewData', '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    isServerRunning: async () => true,
    stdout: output(),
    stderr,
  });
  assert.equal(code, 1);
  assert.equal(store.values.DataDir, 'C:\\OldData');
  assert.match(stderr.lines.join('\n'), /请先完全退出 Mythpen/);
});
```

- [ ] **Step 2: Run CLI tests and verify they fail**

Run: `node --test server/tests/cli.test.js`

Expected: FAIL with `Cannot find module '../cli'`.

- [ ] **Step 3: Implement parsing, help text, safety checks, and dependency injection**

The authoritative implementation and executable examples are `server/cli.js` and
`server/tests/cli.test.js`. Keep the executable bootstrap behind
`require.main === module` so tests can import:

```js
runCli(argv, {
  stdout?,
  stderr?,
  store?,
  env?,
  homeDir?,
  isServerRunning?,
  copyAndVerifyDirectory?,
}?)
```

The CLI contract is:

1. Accept exactly `data-dir|export-dir get` or
   `data-dir|export-dir set <path> [--migrate]`; malformed shapes return 2 and print
   help without creating directories or changing configuration.
2. Resolve both scopes with `store`, `env`, and `homeDir`. Definitions include their
   environment override keys (`MYTHPEN_DATA_DIR` / `MYTHPEN_EXPORT_DIR`), and a
   successful persistent `set` reports when the effective value remains overridden by
   the environment.
3. Plain `set` creates/switches to a new or empty directory without copying. Migrate
   first rejects an active Mythpen server, then calls the injected or production
   `copyAndVerifyDirectory`.
4. A migration publication or verification error returns 1, writes the error to
   stderr, and does not call `store.set`.
5. Once migration returns success, call `store.set` before every successful stdout
   write. A later stdout failure is reported on stderr with exit 1, but the committed
   published data and persisted setting remain consistent.
6. After persistence, print the copy/source-retention summary, then every returned
   `cleanupWarnings` item as
   `迁移已完成，但临时备份清理失败：<path>（<original error>）`, followed by the normal
   setting/restart or environment-override messages.

- [ ] **Step 4: Run all CLI tests**

Run: `node --test server/tests/cli.test.js`

Expected: all CLI tests pass, 0 fail.

- [ ] **Step 5: Run the CLI manually without changing configuration**

Run: `node server/cli.js data-dir get`

Expected: prints `C:\Users\wanghongao\.mythpen`.

Run: `node server/cli.js export-dir get`

Expected: prints `C:\Users\wanghongao\.mythpen\exports`.

- [ ] **Step 6: Commit the CLI**

```powershell
git add server/cli.js server/tests/cli.test.js
git commit -m "feat(cli): configure and migrate storage paths"
```

---

### Task 4: Connect the server and repair migrated project paths

**Files:**
- Create: `server/recent-project-paths.js`
- Create: `server/tests/recent-project-paths.test.js`
- Modify: `server/db.js`
- Modify: `server/routes/api.js`

**Interfaces:**
- Consumes: `resolveStoragePaths()`.
- Produces: `repairRecentProjectPaths(configDb, projectsDir, fsApi)`.
- Extends `server/db.js` exports with `getDataDir()` and `getExportDir()`.

- [ ] **Step 1: Write the failing recent-project repair test**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { repairRecentProjectPaths } = require('../recent-project-paths');

test('rewrites stale recent project paths when the database exists under the new root', () => {
  const updates = [];
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT')) {
        return { all: () => [{ name: '暗影纪', file_path: 'C:\\Old\\暗影纪.mythpen.db' }] };
      }
      return { run: (...args) => updates.push(args) };
    },
  };
  const projectsDir = path.resolve('D:\\MythpenData', 'projects');
  const expected = path.join(projectsDir, '暗影纪.mythpen.db');
  const changed = repairRecentProjectPaths(db, projectsDir, {
    existsSync: (candidate) => candidate === expected,
  });
  assert.equal(changed, 1);
  assert.deepEqual(updates, [[expected, '暗影纪']]);
});
```

- [ ] **Step 2: Run the repair test and verify it fails**

Run: `node --test server/tests/recent-project-paths.test.js`

Expected: FAIL with `Cannot find module '../recent-project-paths'`.

- [ ] **Step 3: Implement project-path repair**

```js
const fs = require('node:fs');
const path = require('node:path');

function repairRecentProjectPaths(configDb, projectsDir, fsApi = fs) {
  const rows = configDb.prepare('SELECT name, file_path FROM recent_projects').all();
  const update = configDb.prepare('UPDATE recent_projects SET file_path = ? WHERE name = ?');
  let changed = 0;
  for (const row of rows) {
    const candidate = path.join(projectsDir, `${row.name}.mythpen.db`);
    if (candidate !== row.file_path && fsApi.existsSync(candidate)) {
      update.run(candidate, row.name);
      changed += 1;
    }
  }
  return changed;
}

module.exports = { repairRecentProjectPaths };
```

- [ ] **Step 4: Replace hard-coded database paths**

In `server/db.js`, replace `os.homedir()` constants with:

```js
const { resolveStoragePaths } = require('./storage-paths');
const { repairRecentProjectPaths } = require('./recent-project-paths');

const STORAGE_PATHS = resolveStoragePaths();
const DB_DIR = STORAGE_PATHS.dataDir;
const CONFIG_DB = STORAGE_PATHS.configDbPath;
const PROJECTS_DIR = STORAGE_PATHS.projectsDir;
const EXPORT_DIR = STORAGE_PATHS.exportDir;
```

After `migrateConfig(wrapped)`, call:

```js
repairRecentProjectPaths(wrapped, PROJECTS_DIR);
```

Export:

```js
getDataDir: () => DB_DIR,
getExportDir: () => EXPORT_DIR,
```

- [ ] **Step 5: Replace the export route's independent home-directory path**

In `server/routes/api.js`, replace:

```js
const EXPORT_DIR = path.join(require('os').homedir(), '.mythpen', 'exports', pn);
```

with:

```js
const EXPORT_DIR = path.join(db.getExportDir(), pn);
```

- [ ] **Step 6: Run all server unit tests**

Run: `node --test server/tests/*.test.js`

Expected: 9 tests pass, 0 fail.

- [ ] **Step 7: Commit server integration**

```powershell
git add server/db.js server/routes/api.js server/recent-project-paths.js server/tests/recent-project-paths.test.js
git commit -m "feat(storage): use configured data and export roots"
```

---

### Task 5: Package the CLI and document its use

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `README.md`

**Interfaces:**
- Produces: installed `mythpen-cli.exe` alongside `mythpen.exe` and `mythpen-server.exe`.
- Produces: `pnpm test:server` and one cross-platform `pnpm build:sidecar` path used by
  local Tauri packaging and all three CI build jobs.

- [ ] **Step 1: Add tests and the shared target-triple sidecar build script**

`scripts/build-sidecars.mjs` runs the WASM embedding step exactly once, reads the native
host triple from `rustc -vV`, requires Bun 1.3.14, and compiles:

```text
src-tauri/binaries/mythpen-server-<triple>[.exe]
src-tauri/binaries/mythpen-cli-<triple>[.exe]
```

Only Windows triples receive `.exe`. `package.json` maps `build:sidecar` to the shared
script. `scripts/tests/build-sidecars.test.mjs` covers triple parsing, output naming,
local Tauri integration, all three CI jobs, and the exact Bun version.

- [ ] **Step 2: Add both sidecars to the Tauri bundle and local build**

In `src-tauri/tauri.conf.json`, set:

```json
"beforeBuildCommand": "pnpm build && pnpm build:sidecar",
"externalBin": [
  "binaries/mythpen-server",
  "binaries/mythpen-cli"
]
```

No Tauri shell permission is added because the GUI does not execute the CLI.
In `.github/workflows/build.yml`, each existing platform job installs Bun 1.3.14 and
then reaches the shared script exactly once through its existing `pnpm tauri build`
step and Tauri's `beforeBuildCommand`; no job contains a separate sidecar build,
Bun compile, or rename sequence.

- [ ] **Step 3: Document commands and safety behavior**

Add a “Storage CLI” section to `README.md` showing:

```powershell
& 'D:\Mythpen\mythpen-cli.exe' data-dir get
& 'D:\Mythpen\mythpen-cli.exe' data-dir set 'D:\MythpenData' --migrate
& 'D:\Mythpen\mythpen-cli.exe' export-dir get
& 'D:\Mythpen\mythpen-cli.exe' export-dir set 'E:\MythpenExports' --migrate
```

The documentation must state that plain `set <path>` switches to a new/empty directory
without copying, only `--migrate` copies and verifies, Mythpen must be closed for
migration, the source is retained, and the app must be restarted.

- [ ] **Step 4: Run unit and frontend checks**

Run: `node --test server/tests/*.test.js`

Expected: all tests pass.

Run: `pnpm typecheck`

Expected: exit code 0.

- [ ] **Step 5: Build both standalone binaries**

Run: `pnpm build:sidecar`

Expected (for the triple reported by `rustc -vV`):

```text
src-tauri/binaries/mythpen-server-<triple>[.exe]
src-tauri/binaries/mythpen-cli-<triple>[.exe]
```

- [ ] **Step 6: Smoke-test the compiled CLI without changing user configuration**

Run:

```powershell
& '.\src-tauri\binaries\mythpen-cli-<triple>.exe' data-dir get
& '.\src-tauri\binaries\mythpen-cli-<triple>.exe' export-dir get
```

Expected:

```text
C:\Users\wanghongao\.mythpen
C:\Users\wanghongao\.mythpen\exports
```

- [ ] **Step 7: Commit packaging and documentation**

```powershell
git add package.json src-tauri/tauri.conf.json README.md
git commit -m "build: package configurable storage CLI"
```

---

### Task 6: Final migration rehearsal and full verification

**Files:**
- Modify only if verification exposes a defect in files from Tasks 1–5.

**Interfaces:**
- Consumes the compiled `mythpen-cli.exe`.
- Produces reproducible evidence that `--migrate` configuration changes occur only after verified migration.

- [ ] **Step 1: Use isolated registry values and temporary directories for rehearsal**

Run tests with an injected in-memory store; do not change `HKCU\Software\Mythpen` during automated tests:

```powershell
node --test server/tests/*.test.js
```

Expected: all tests pass with no writes to the user's actual Mythpen directories.

- [ ] **Step 2: Verify help and invalid-command exit behavior**

Run:

```powershell
node server/cli.js
```

Expected: usage text and exit code 2.

- [ ] **Step 3: Verify repository quality gates**

Run:

```powershell
node --test server/tests/*.test.js
node --test scripts/tests/build-sidecars.test.mjs
pnpm typecheck
pnpm build
pnpm build:sidecar
pnpm tauri build
git diff --check
git status --short
```

Expected: tests, typecheck, frontend build, shared target-triple sidecar build, and (when
the host has the required Tauri packaging toolchain) desktop packaging succeed;
`git diff --check` has no output and status contains only intentional feature files.

- [ ] **Step 4: Review safety invariants**

Confirm from tests and code inspection:

- 对 `set <path> --migrate`，注册表变更只会发生在复制和 SHA-256 校验成功之后；普通 `set <path>` 有意不复制/哈希，用于切换至新的/空的目录。
- Source data is never deleted.
- A non-empty destination is rejected.
- Nested source and destination paths are rejected.
- Active server detection prevents migration while Mythpen is open.
- Data-directory migration repairs `recent_projects.file_path`.
- Export generation uses the configured export root.

- [ ] **Step 5: Commit any verification-only fixes**

```powershell
git add <only-files-changed-by-verification>
git commit -m "fix(storage): close CLI verification gaps"
```

Skip this commit when verification requires no fixes.
