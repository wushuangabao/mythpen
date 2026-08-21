const crypto = require('node:crypto');
const { execFile: nodeExecFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

let sqlModulePromise;

function loadSqlModule() {
  if (!sqlModulePromise) {
    const initSqlJs = require('sql.js');
    let wasmBinary;
    try {
      wasmBinary = require('./wasm-binary').getWasmBinary();
    } catch {
      // Development installs can let sql.js locate its own WASM file.
    }
    sqlModulePromise = initSqlJs(wasmBinary ? { wasmBinary } : undefined);
  }
  return sqlModulePromise;
}

function readSqlJsRows(database, sql) {
  const statement = database.prepare(sql);
  try {
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function closeReadOnlyDatabase(database, primaryError) {
  try {
    database?.close();
  } catch (cleanupError) {
    if (!primaryError) throw cleanupError;
    try {
      Object.defineProperty(primaryError, 'databaseCleanupError', {
        value: cleanupError,
        configurable: true,
      });
    } catch {
      // Preserve the primary inspection error if it cannot be extended.
    }
  }
}

function nativeDataRootMigrationUnsupported(projectPath) {
  const error = new Error(`Native project data roots cannot be migrated: ${projectPath}`);
  error.code = 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED';
  error.status = 409;
  error.recoverable = false;
  return error;
}

function missingDataRootPolicyAuthority() {
  const error = new Error('Production data-root policy authority is unavailable');
  error.code = 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED';
  error.status = 409;
  error.recoverable = false;
  return error;
}

function captureDataRootPolicyAuthority(authority) {
  if (
    authority === null
    || (typeof authority !== 'object' && typeof authority !== 'function')
  ) throw new TypeError('policyAuthority must be an object');
  const descriptor = Object.getOwnPropertyDescriptor(authority, 'assertChangeAllowed');
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, 'value')
    || typeof descriptor.value !== 'function'
  ) throw new TypeError('policyAuthority.assertChangeAllowed must be an own data function');
  return Object.freeze({
    assertChangeAllowed: (request) => Reflect.apply(descriptor.value, authority, [request]),
  });
}

function untrustedDataRoot(message, cause) {
  const error = new Error(message, { cause });
  error.code = 'STORAGE_UNAVAILABLE';
  error.status = 503;
  error.recoverable = false;
  return error;
}

function comparablePhysicalPath(filePath, fsApi) {
  const physical = fsApi.realpathSync.native(filePath);
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

function probePathExists(filePath, fsApi, label) {
  try {
    fsApi.lstatSync(filePath);
    return true;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return false;
    throw untrustedDataRoot(`${label} presence cannot be inspected: ${filePath}`, cause);
  }
}

function assertPlainPathChain(filePath, fsApi, label) {
  const absolute = path.resolve(filePath);
  const root = path.parse(absolute).root;
  const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stats;
    try {
      stats = fsApi.lstatSync(current);
    } catch (cause) {
      throw untrustedDataRoot(`${label} path chain cannot be inspected: ${current}`, cause);
    }
    if (stats.isSymbolicLink() || (index < segments.length - 1 && !stats.isDirectory())) {
      throw untrustedDataRoot(`${label} path chain contains an unsafe alias: ${current}`);
    }
  }
}

function assertPlainSingleLinkFile(filePath, expectedParent, fsApi, label) {
  assertPlainPathChain(filePath, fsApi, label);
  let stats;
  try {
    stats = fsApi.lstatSync(filePath);
  } catch (cause) {
    throw untrustedDataRoot(`${label} cannot be inspected: ${filePath}`, cause);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw untrustedDataRoot(`${label} must be a plain single-link file: ${filePath}`);
  }
  let physicalParent;
  try {
    physicalParent = comparablePhysicalPath(path.dirname(filePath), fsApi);
  } catch (cause) {
    throw untrustedDataRoot(`${label} parent cannot be resolved: ${filePath}`, cause);
  }
  if (physicalParent !== expectedParent) {
    throw untrustedDataRoot(`${label} escapes the controlled projects directory: ${filePath}`);
  }
}

function assertPlainDirectory(directory, fsApi, label) {
  assertPlainPathChain(directory, fsApi, label);
  let stats;
  try {
    stats = fsApi.lstatSync(directory);
  } catch (cause) {
    throw untrustedDataRoot(`${label} cannot be inspected: ${directory}`, cause);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw untrustedDataRoot(`${label} must be a plain directory: ${directory}`);
  }
  try {
    return comparablePhysicalPath(directory, fsApi);
  } catch (cause) {
    throw untrustedDataRoot(`${label} cannot be resolved: ${directory}`, cause);
  }
}

const PROJECT_DATABASE_SUFFIX = '.mythpen.db';
const PROJECT_IDENTITY_TABLES = new Set([
  'volumes', 'chapters', 'characters', 'relationships', 'locations', 'factions',
  'world_rules', 'plot_threads', 'timeline_events', 'foreshadows', 'scene_cards',
  'chapter_revisions',
]);

function isSupportedProjectFilename(filePath) {
  const name = path.basename(filePath);
  return !name.startsWith('.')
    && name.toLowerCase().endsWith(PROJECT_DATABASE_SUFFIX)
    && name.length > PROJECT_DATABASE_SUFFIX.length;
}

function inspectProjectMarkers(SQL, projectPath, fsApi) {
  let project;
  let primaryError;
  try {
    project = new SQL.Database(fsApi.readFileSync(projectPath));
    const tables = new Set(readSqlJsRows(
      project,
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((row) => String(row.name)));
    if (!tables.has('project_meta') || ![...PROJECT_IDENTITY_TABLES].some((name) => tables.has(name))) {
      throw untrustedDataRoot(`Project database identity is invalid: ${projectPath}`);
    }
    const rows = readSqlJsRows(
      project,
      "SELECT key, value FROM project_meta WHERE key IN ('schema_version', 'durability_backend')",
    ).map((row) => ({ key: String(row.key), value: String(row.value) }));
    const schemaRows = rows.filter((row) => row.key === 'schema_version');
    const backendRows = rows.filter((row) => row.key === 'durability_backend');
    if (
      schemaRows.some((row) => /^\d+$/.test(row.value) && Number(row.value) >= 11)
      || backendRows.some((row) => row.value === 'native-sqlite-v2')
    ) {
      throw nativeDataRootMigrationUnsupported(projectPath);
    }
    if (
      schemaRows.length !== 1
      || !/^\d+$/.test(schemaRows[0].value)
      || !Number.isSafeInteger(Number(schemaRows[0].value))
      || backendRows.length > 1
      || (backendRows.length === 1 && backendRows[0].value !== 'sqljs-v1')
    ) {
      throw untrustedDataRoot(`Project durability markers are invalid: ${projectPath}`);
    }
  } catch (error) {
    primaryError = [
      'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED',
      'STORAGE_UNAVAILABLE',
    ].includes(error?.code)
      ? error
      : untrustedDataRoot(`Project database cannot be read safely: ${projectPath}`, error);
    throw primaryError;
  } finally {
    closeReadOnlyDatabase(project, primaryError);
  }
}

async function assertDataRootMigrationSupported(dataDir, options = {}) {
  const fsApi = options.fsApi || fs;
  const source = path.resolve(dataDir);
  const targetRoot = options.targetRoot === undefined
    ? source
    : path.resolve(options.targetRoot);
  const migrate = options.migrate === true;
  if (options.policyAuthority !== undefined && options.policyAuthority !== null) {
    const policy = captureDataRootPolicyAuthority(options.policyAuthority);
    await policy.assertChangeAllowed(Object.freeze({
      sourceRoot: source,
      targetRoot,
      migrate,
    }));
  } else if (options.requirePolicyAuthority === true) {
    throw missingDataRootPolicyAuthority();
  }
  const configDbPath = path.join(source, 'config.db');
  const projectsDir = path.join(source, 'projects');
  if (!probePathExists(source, fsApi, 'Data root')) return;
  const physicalSource = assertPlainDirectory(source, fsApi, 'Data root');
  const configExists = probePathExists(configDbPath, fsApi, 'Configuration database');
  const projectsExist = probePathExists(projectsDir, fsApi, 'Projects directory');
  if (!configExists && !projectsExist) return;
  let physicalProjects = null;
  const projectPaths = new Map();
  if (projectsExist) {
    physicalProjects = assertPlainDirectory(projectsDir, fsApi, 'Projects directory');
    if (path.dirname(physicalProjects) !== physicalSource) {
      throw untrustedDataRoot('Projects directory escapes the data root');
    }
    let entries;
    try {
      entries = fsApi.readdirSync(projectsDir, { withFileTypes: true });
    } catch (cause) {
      throw untrustedDataRoot('Projects directory cannot be enumerated', cause);
    }
    for (const entry of entries) {
      if (!entry.name.toLowerCase().endsWith(PROJECT_DATABASE_SUFFIX)) continue;
      const projectPath = path.join(projectsDir, entry.name);
      if (!isSupportedProjectFilename(projectPath)) {
        throw untrustedDataRoot(`Unsupported project database filename: ${projectPath}`);
      }
      assertPlainSingleLinkFile(projectPath, physicalProjects, fsApi, 'Project database');
      projectPaths.set(comparablePhysicalPath(projectPath, fsApi), projectPath);
    }
  }
  const SQL = options.sqlModule || await loadSqlModule();
  for (const projectPath of projectPaths.values()) inspectProjectMarkers(SQL, projectPath, fsApi);
  if (!configExists) {
    if (projectPaths.size === 0) return;
    throw untrustedDataRoot('A non-empty projects directory requires config.db');
  }
  if (!projectsExist) throw untrustedDataRoot('config.db requires a controlled projects directory');
  assertPlainSingleLinkFile(configDbPath, physicalSource, fsApi, 'Configuration database');
  let config;
  let primaryError;
  let registeredPaths;
  try {
    config = new SQL.Database(fsApi.readFileSync(configDbPath));
    const table = readSqlJsRows(
      config,
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'recent_projects'",
    );
    if (table.length !== 1) throw untrustedDataRoot('config.db has no unique recent_projects registry');
    registeredPaths = readSqlJsRows(
      config,
      'SELECT file_path FROM recent_projects ORDER BY file_path, id',
    ).map((row) => row.file_path);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    closeReadOnlyDatabase(config, primaryError);
  }

  for (const registeredPath of registeredPaths) {
    if (typeof registeredPath !== 'string' || !path.isAbsolute(registeredPath)) {
      throw untrustedDataRoot('Registered project paths must be absolute');
    }
    const projectPath = path.resolve(registeredPath);
    if (!isSupportedProjectFilename(projectPath)) {
      throw untrustedDataRoot(`Registered project filename is invalid: ${projectPath}`);
    }
    assertPlainSingleLinkFile(projectPath, physicalProjects, fsApi, 'Registered project database');
    const physicalProjectPath = comparablePhysicalPath(projectPath, fsApi);
    if (!projectPaths.has(physicalProjectPath)) {
      projectPaths.set(physicalProjectPath, projectPath);
      inspectProjectMarkers(SQL, projectPath, fsApi);
    }
  }
}

const WINDOWS_ATOMIC_DIRECTORY_MOVE_SCRIPT = [
  '& {',
  '  param([string]$sourceBase64, [string]$targetBase64)',
  '  try {',
  '    $source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($sourceBase64))',
  '    $target = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($targetBase64))',
  '    [System.IO.Directory]::Move($source, $target)',
  '    exit 0',
  '  } catch {',
  '    [Console]::Error.WriteLine($_.Exception.Message)',
  '    exit 1',
  '  }',
  '}',
].join('\n');

function execFileResult(execFile, file, arguments_, options) {
  return new Promise((resolve) => {
    try {
      execFile(file, arguments_, options, (error, stdout, stderr) => {
        resolve({ error, stdout, stderr });
      });
    } catch (error) {
      resolve({ error, stdout: '', stderr: '' });
    }
  });
}

function resolveWindowsPowerShellPath(options = {}) {
  if (Object.hasOwn(options, 'powershellPath')) {
    if (
      typeof options.powershellPath !== 'string'
      || !path.win32.isAbsolute(options.powershellPath)
    ) {
      throw new Error('PowerShell 可执行文件必须使用绝对路径');
    }
    return path.win32.normalize(options.powershellPath);
  }
  const windowsRoot = Object.hasOwn(options, 'windowsRoot')
    ? options.windowsRoot
    : process.env.SystemRoot || process.env.WINDIR;
  if (typeof windowsRoot !== 'string' || windowsRoot.length === 0) {
    throw new Error('缺少 Windows 系统根目录，无法安全解析 PowerShell');
  }
  if (!path.win32.isAbsolute(windowsRoot)) {
    throw new Error(`Windows 系统根目录必须是绝对路径：${windowsRoot}`);
  }
  return path.win32.join(
    path.win32.normalize(windowsRoot),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function directoryIdentity(stats) {
  return {
    type: 'directory',
    dev: String(stats.dev),
    ino: String(stats.ino),
    birthtimeMs: stats.birthtimeMs,
  };
}

function identitiesMatch(left, right) {
  return left.type === right.type
    && left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function corroborateDirectoryMove(source, target, expectedIdentity, fsApi) {
  let sourceStats;
  try {
    sourceStats = fsApi.lstatSync(source);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return { committed: false, reason: `无法检查源目录：${error.message}` };
    }
  }
  if (sourceStats) {
    return { committed: false, reason: `源目录仍存在：${source}` };
  }

  let targetStats;
  try {
    targetStats = fsApi.lstatSync(target);
  } catch (error) {
    return { committed: false, reason: `无法检查目标目录：${error.message}` };
  }
  if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
    return { committed: false, reason: `目标不是非重解析真实目录：${target}` };
  }
  const actualIdentity = directoryIdentity(targetStats);
  if (!identitiesMatch(expectedIdentity, actualIdentity)) {
    return { committed: false, reason: `目标目录 identity 与 owned 源目录不一致：${target}` };
  }
  return { committed: true };
}

async function atomicMoveDirectoryNoReplace(source, target, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    throw new Error(`当前平台不支持安全的原子 no-replace 目录发布：${platform}`);
  }
  const powershellPath = resolveWindowsPowerShellPath(options);
  const fsApi = options.fsApi || fs;
  const sourceStats = fsApi.lstatSync(source);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
    throw new Error(`原子发布源必须是非重解析真实目录：${source}`);
  }
  const expectedIdentity = directoryIdentity(sourceStats);
  const execFile = options.execFile || nodeExecFile;
  const result = await execFileResult(
    execFile,
    powershellPath,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_ATOMIC_DIRECTORY_MOVE_SCRIPT,
      Buffer.from(source, 'utf16le').toString('base64'),
      Buffer.from(target, 'utf16le').toString('base64'),
    ],
    { windowsHide: true },
  );
  const corroboration = corroborateDirectoryMove(
    source,
    target,
    expectedIdentity,
    fsApi,
  );
  if (corroboration.committed) return;

  const processDetail = result.error
    ? String(result.stderr || result.error.message).trim()
    : 'execFile 返回成功但移动未完成';
  throw new Error(
    `Windows 原子发布失败：${source} -> ${target}`
    + `（${processDetail}；identity 佐证：${corroboration.reason}）`,
    { cause: result.error || undefined },
  );
}

function atomicMoveOptions(options, fsApi) {
  const moveOptions = {
    execFile: options.execFile,
    fsApi,
    platform: options.platform,
  };
  if (Object.hasOwn(options, 'powershellPath')) {
    moveOptions.powershellPath = options.powershellPath;
  }
  if (Object.hasOwn(options, 'windowsRoot')) {
    moveOptions.windowsRoot = options.windowsRoot;
  }
  return moveOptions;
}

function backupMoveError(target, backupContainer, backupChild, moveError, cleanupError) {
  const cleanup = cleanupError
    ? `；owned 备份容器未清理：${backupContainer}`
      + `；冲突子项：${backupChild}；清理失败：${cleanupError.message}`
    : '';
  return new Error(
    `无法安全备份原空目标：${target} -> ${backupChild}`
    + `（${moveError.message}）${cleanup}`,
    { cause: moveError },
  );
}

async function moveEmptyTargetToBackup(target, backupContainer, backupChild, options, fsApi) {
  try {
    await atomicMoveDirectoryNoReplace(
      target,
      backupChild,
      atomicMoveOptions(options, fsApi),
    );
  } catch (moveError) {
    let cleanupError = null;
    try {
      fsApi.rmdirSync(backupContainer);
    } catch (error) {
      cleanupError = error;
    }
    throw backupMoveError(
      target,
      backupContainer,
      backupChild,
      moveError,
      cleanupError,
    );
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function physicalPath(candidate, fsApi = fs) {
  const missing = [];
  let existing = path.resolve(candidate);
  while (!fsApi.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new Error(`无法解析路径：${candidate}`);
    }
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fsApi.realpathSync.native(existing), ...missing);
}

function assertNoReparsePoints(root, fsApi = fs) {
  function visit(absolute) {
    const stats = fsApi.lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      throw new Error(`迁移源目录不允许包含符号链接或重解析点：${absolute}`);
    }
    if (!stats.isDirectory()) return;
    for (const entry of fsApi.readdirSync(absolute, { withFileTypes: true })) {
      visit(path.join(absolute, entry.name));
    }
  }
  visit(root);
}

function validateMigrationPaths(sourceDir, targetDir, fsApi = fs) {
  const source = path.resolve(sourceDir);
  const target = path.resolve(targetDir);
  if (!fsApi.existsSync(source) || !fsApi.statSync(source).isDirectory()) {
    throw new Error(`源目录不存在：${source}`);
  }
  assertNoReparsePoints(source, fsApi);
  const physicalSource = physicalPath(source, fsApi);
  const physicalTarget = physicalPath(target, fsApi);
  if (source === target || physicalSource === physicalTarget) {
    throw new Error('源目录和目标目录相同');
  }
  if (isInside(physicalSource, physicalTarget) || isInside(physicalTarget, physicalSource)) {
    throw new Error('源目录和目标目录不能互相包含');
  }
  if (fsApi.existsSync(target)) {
    const targetStats = fsApi.lstatSync(target);
    if (targetStats.isSymbolicLink()) {
      throw new Error(`目标目录不能是符号链接或重解析点：${target}`);
    }
    if (!targetStats.isDirectory()) {
      throw new Error(`目标路径不是目录：${target}`);
    }
    if (fsApi.readdirSync(target).length > 0) {
      throw new Error(`目标目录必须为空：${target}`);
    }
  }
  return { source, target };
}

function fileManifest(root, fsApi = fs) {
  const files = [];
  function visit(dir) {
    for (const entry of fsApi.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`清单不允许符号链接、junction 或重解析点：${absolute}`);
      }
      if (entry.isDirectory()) {
        files.push({ relative: path.relative(root, absolute), type: 'directory' });
        visit(absolute);
      }
      else if (entry.isFile()) {
        const relative = path.relative(root, absolute);
        const bytes = fsApi.readFileSync(absolute);
        files.push({
          relative,
          type: 'file',
          size: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        });
      } else {
        throw new Error(`清单包含不支持的文件系统条目：${absolute}`);
      }
    }
  }
  visit(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

function copyDirectoryContents(source, target, fsApi = fs) {
  for (const entry of fsApi.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`迁移源目录不允许包含符号链接或重解析点：${sourcePath}`);
    }
    if (entry.isDirectory()) {
      fsApi.mkdirSync(targetPath);
      copyDirectoryContents(sourcePath, targetPath, fsApi);
    }
    else if (entry.isFile()) {
      fsApi.cpSync(sourcePath, targetPath, {
        force: false,
        errorOnExist: true,
      });
    }
    else {
      throw new Error(`迁移源目录包含不支持的文件系统条目：${sourcePath}`);
    }
  }
}

async function copyAndVerifyDirectory(sourceDir, targetDir, options = {}) {
  const fsApi = options.fsApi || fs;
  const { source, target } = validateMigrationPaths(sourceDir, targetDir, fsApi);
  const targetParent = path.dirname(target);
  fsApi.mkdirSync(targetParent, { recursive: true });
  const staging = fsApi.mkdtempSync(
    path.join(targetParent, `.${path.basename(target)}.mythpen-staging-`),
  );
  let published = false;
  let backupContainer = null;
  let backupChild = null;
  const cleanupWarnings = [];
  let stagingCleaned = false;

  try {
    copyDirectoryContents(source, staging, fsApi);
    const sourceManifest = fileManifest(source, fsApi);
    const stagingManifest = fileManifest(staging, fsApi);
    if (JSON.stringify(sourceManifest) !== JSON.stringify(stagingManifest)) {
      throw new Error('迁移校验失败：目标文件与源文件不一致');
    }

    if (fsApi.existsSync(target)) {
      backupContainer = fsApi.mkdtempSync(
        path.join(targetParent, `.${path.basename(target)}.mythpen-backup-`),
      );
      backupChild = path.join(backupContainer, 'original-target');
      await moveEmptyTargetToBackup(
        target,
        backupContainer,
        backupChild,
        options,
        fsApi,
      );
    }

    try {
      await atomicMoveDirectoryNoReplace(
        staging,
        target,
        atomicMoveOptions(options, fsApi),
      );
      published = true;
      stagingCleaned = true;
    } catch (error) {
      const recovery = backupChild
        ? `；原空目标安全保留在：${backupChild}`
        : '';
      throw new Error(
        `目标路径在发布时已被占用或发生冲突，迁移未提交：${target}${recovery}（${error.message}）`,
        { cause: error },
      );
    }

    if (backupChild) {
      try {
        fsApi.rmdirSync(backupChild);
        backupChild = null;
      } catch (error) {
        cleanupWarnings.push({ path: backupChild, error: error.message });
      }
      if (!backupChild) {
        try {
          fsApi.rmdirSync(backupContainer);
          backupContainer = null;
        } catch (error) {
          cleanupWarnings.push({ path: backupContainer, error: error.message });
        }
      }
    }

    return {
      source,
      target,
      fileCount: sourceManifest.filter((item) => item.type === 'file').length,
      totalBytes: sourceManifest.reduce((sum, item) => sum + (item.size || 0), 0),
      cleanupWarnings,
    };
  } finally {
    if (!published && !stagingCleaned) {
      fsApi.rmSync(staging, { recursive: true, force: true });
    }
  }
}

function isServerRunning(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = options.port || 3001;
  const timeoutMs = options.timeoutMs || 300;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (running) => {
      socket.destroy();
      resolve(running);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

module.exports = {
  assertDataRootMigrationSupported,
  atomicMoveDirectoryNoReplace,
  copyAndVerifyDirectory,
  fileManifest,
  isServerRunning,
  validateMigrationPaths,
};
