const crypto = require('node:crypto');
const { execFile: nodeExecFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

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
  atomicMoveDirectoryNoReplace,
  copyAndVerifyDirectory,
  fileManifest,
  isServerRunning,
  validateMigrationPaths,
};
