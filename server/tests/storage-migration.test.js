const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile: realExecFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {
  assertDataRootMigrationSupported,
  atomicMoveDirectoryNoReplace,
  copyAndVerifyDirectory,
  fileManifest,
  isServerRunning,
  validateMigrationPaths,
} = require('../storage-migration');

const WINDOWS_MULTI_MOVE_TIMEOUT_MS = 15_000;

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-${name}-`));
}

function stagingEntries(parent, targetName) {
  return fs.readdirSync(parent).filter((entry) => (
    entry.startsWith(`.${targetName}.mythpen-staging-`)
  ));
}

function internalMigrationEntries(parent, targetName) {
  return fs.readdirSync(parent).filter((entry) => (
    entry.startsWith(`.${targetName}.mythpen-`)
  ));
}

function decodedMovePaths(arguments_) {
  return {
    source: Buffer.from(arguments_[4], 'base64').toString('utf16le'),
    target: Buffer.from(arguments_[5], 'base64').toString('utf16le'),
  };
}

test('Task14 policy rejection happens before the legacy SQLite root inspector', async () => {
  const source = tempDir('task14-policy-before-scan');
  const target = path.resolve(tempDir('task14-policy-target'), 'new-data-root');
  const unsupported = Object.assign(new Error('files authority is present'), {
    code: 'NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED',
  });
  let policyCalls = 0;
  let fsTouches = 0;
  const policyAuthority = Object.freeze({
    assertChangeAllowed(request) {
      policyCalls += 1;
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(request, {
        sourceRoot: path.resolve(source),
        targetRoot: target,
        migrate: true,
      });
      throw unsupported;
    },
  });
  const fsApi = new Proxy(fs, {
    get(realFs, property) {
      if (['existsSync', 'lstatSync', 'readFileSync', 'readdirSync', 'realpathSync'].includes(property)) {
        return (...arguments_) => {
          fsTouches += 1;
          return Reflect.apply(realFs[property], realFs, arguments_);
        };
      }
      return Reflect.get(realFs, property);
    },
  });

  await assert.rejects(
    assertDataRootMigrationSupported(source, {
      fsApi,
      migrate: true,
      policyAuthority,
      targetRoot: target,
    }),
    (error) => error === unsupported,
  );
  assert.equal(policyCalls, 1);
  assert.equal(fsTouches, 0);
});

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

test('rejects a target physically nested in the source through a junction before creating it', () => {
  const source = tempDir('source');
  const alias = path.join(tempDir('alias-parent'), 'source-alias');
  const target = path.join(alias, 'nested');
  fs.symlinkSync(source, alias, 'junction');

  assert.throws(() => validateMigrationPaths(source, target), /不能互相包含/);
  assert.equal(fs.existsSync(target), false);
});

test('rejects symbolic links or junctions in the source tree before copying', async () => {
  const source = tempDir('source');
  const linkedDirectory = tempDir('linked-directory');
  const target = path.join(tempDir('target-parent'), 'data');
  const link = path.join(source, 'linked');
  fs.writeFileSync(path.join(source, 'config.db'), 'source');
  fs.symlinkSync(linkedDirectory, link, 'junction');

  await assert.rejects(
    () => copyAndVerifyDirectory(source, target),
    /不允许包含符号链接/,
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'source');
});

test('manifest rejects unsupported filesystem entries instead of silently omitting them', () => {
  const root = tempDir('unsupported-manifest-entry');
  const unsupported = {
    name: 'device-entry',
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => false,
  };
  const fsApi = new Proxy(fs, {
    get(realFs, property) {
      if (property !== 'readdirSync') return realFs[property];
      return (directory, options) => (
        directory === root ? [unsupported] : realFs.readdirSync(directory, options)
      );
    },
  });

  assert.throws(() => fileManifest(root, fsApi), /不支持的文件系统条目.*device-entry/);
});

test('rejects an unsupported staging entry before atomic publication', async () => {
  const source = tempDir('unsupported-staging-source');
  const parent = tempDir('unsupported-staging-parent');
  const target = path.join(parent, 'data');
  fs.writeFileSync(path.join(source, 'story.md'), 'source');
  const unsupported = {
    name: 'device-entry',
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => false,
  };
  const fsApi = new Proxy(fs, {
    get(realFs, property) {
      if (property !== 'readdirSync') return realFs[property];
      return (directory, options) => {
        const entries = realFs.readdirSync(directory, options);
        return String(directory).includes('.mythpen-staging-')
          && options?.withFileTypes
          ? [...entries, unsupported]
          : entries;
      };
    },
  });

  await assert.rejects(
    () => copyAndVerifyDirectory(source, target, { fsApi }),
    /不支持的文件系统条目.*device-entry/,
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'source');
  assert.deepEqual(stagingEntries(parent, 'data'), []);
});

test('atomically publishes a missing Windows directory with Unicode and spaces', async () => {
  const parent = tempDir('atomic-move-success');
  const source = path.join(parent, '暂存 目录');
  const target = path.join(parent, '最终 目录');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, '故事.txt'), 'complete');

  await atomicMoveDirectoryNoReplace(source, target, { platform: 'win32' });

  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(target, '故事.txt'), 'utf8'), 'complete');
});

test('uses an absolute system PowerShell path and never a CWD or PATH executable', async () => {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  const fakeDirectory = tempDir('fake-powershell');
  const fakePowerShell = path.join(fakeDirectory, 'powershell.exe');
  const source = path.join(fakeDirectory, "源 目录 '; exit 0; #");
  const target = path.join(fakeDirectory, '目标 目录 $(remove-item)');
  fs.mkdirSync(source);
  fs.writeFileSync(fakePowerShell, 'fake executable');
  let invocation;
  const execFile = (file, arguments_, options, callback) => {
    invocation = { file, arguments_, options };
    fs.renameSync(source, target);
    callback(null, '', '');
  };
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  process.chdir(fakeDirectory);
  process.env.PATH = `${fakeDirectory};${previousPath || ''}`;

  try {
    await atomicMoveDirectoryNoReplace(source, target, {
      execFile,
      platform: 'win32',
      windowsRoot,
    });
  } finally {
    process.chdir(previousCwd);
    process.env.PATH = previousPath;
  }

  assert.equal(
    invocation.file,
    path.win32.join(
      windowsRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
  );
  assert.equal(path.win32.isAbsolute(invocation.file), true);
  assert.notEqual(path.resolve(invocation.file), fakePowerShell);
  assert.deepEqual(invocation.arguments_.slice(0, 3), [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
  ]);
  assert.equal(invocation.arguments_[3].includes(source), false);
  assert.equal(invocation.arguments_[3].includes(target), false);
  assert.equal(
    Buffer.from(invocation.arguments_[4], 'base64').toString('utf16le'),
    source,
  );
  assert.equal(
    Buffer.from(invocation.arguments_[5], 'base64').toString('utf16le'),
    target,
  );
  assert.deepEqual(invocation.options, { windowsHide: true });
});

test('rejects missing or relative Windows roots and PowerShell overrides', async () => {
  const execFile = () => assert.fail('invalid paths must fail before execFile');
  for (const options of [
    { windowsRoot: '' },
    { windowsRoot: 'Windows' },
    { powershellPath: 'powershell.exe' },
  ]) {
    await assert.rejects(
      () => atomicMoveDirectoryNoReplace('C:\\source', 'C:\\target', {
        execFile,
        platform: 'win32',
        ...options,
      }),
      /Windows.*绝对路径|PowerShell.*绝对路径|系统根目录/,
    );
  }

  await assert.rejects(
    () => atomicMoveDirectoryNoReplace('C:\\source', 'C:\\target', {
      execFile: () => assert.fail('non-Windows must not invoke a weaker fallback'),
      platform: 'linux',
    }),
    /不支持安全的原子 no-replace 目录发布：linux/,
  );
});

test('corroborates a completed move when execFile reports a synthetic signal', async () => {
  const parent = tempDir('atomic-move-signal');
  const source = path.join(parent, 'staging');
  const target = path.join(parent, 'final');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'story.md'), 'committed');
  const execFile = (file, arguments_, options, callback) => (
    realExecFile(file, arguments_, options, (error, stdout, stderr) => {
      if (error) {
        callback(error, stdout, stderr);
        return;
      }
      callback(
        Object.assign(new Error('synthetic signal after move'), { signal: 'SIGTERM' }),
        stdout,
        'synthetic transport failure',
      );
    })
  );

  await atomicMoveDirectoryNoReplace(source, target, {
    execFile,
    platform: 'win32',
  });

  assert.equal(fs.existsSync(source), false);
  assert.equal(fs.readFileSync(path.join(target, 'story.md'), 'utf8'), 'committed');
});

test('rejects a success callback when filesystem identity proves no move occurred', async () => {
  const parent = tempDir('atomic-move-false-success');
  const source = path.join(parent, 'staging');
  const target = path.join(parent, 'final');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'story.md'), 'staged');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'external.txt'), 'external');
  const targetIdentity = fs.statSync(target).ino;

  await assert.rejects(
    () => atomicMoveDirectoryNoReplace(source, target, {
      execFile: (file, arguments_, options, callback) => callback(null, '', ''),
      platform: 'win32',
    }),
    /身份|未完成|佐证/,
  );

  assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'staged');
  assert.equal(fs.statSync(target).ino, targetIdentity);
  assert.equal(fs.readFileSync(path.join(target, 'external.txt'), 'utf8'), 'external');
});

for (const targetType of ['file', 'directory', 'junction']) {
  test(`Windows atomic publication never replaces an existing ${targetType}`, async () => {
    const parent = tempDir(`atomic-move-${targetType}`);
    const source = path.join(parent, 'staging');
    const target = path.join(parent, 'final');
    const external = tempDir(`atomic-move-${targetType}-external`);
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'story.md'), 'staged');
    fs.writeFileSync(path.join(external, 'external.txt'), 'external');
    if (targetType === 'file') {
      fs.writeFileSync(target, 'external file');
    } else if (targetType === 'directory') {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'external.txt'), 'external directory');
    } else {
      fs.symlinkSync(external, target, 'junction');
    }
    const targetIdentity = fs.lstatSync(target).ino;
    const externalIdentity = fs.statSync(external).ino;

    await assert.rejects(
      () => atomicMoveDirectoryNoReplace(source, target, { platform: 'win32' }),
      /原子发布失败/,
    );

    assert.equal(fs.lstatSync(target).ino, targetIdentity);
    assert.equal(fs.statSync(external).ino, externalIdentity);
    assert.equal(fs.readFileSync(path.join(external, 'external.txt'), 'utf8'), 'external');
    assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'staged');
    if (targetType === 'file') {
      assert.equal(fs.readFileSync(target, 'utf8'), 'external file');
    } else if (targetType === 'directory') {
      assert.equal(fs.readFileSync(path.join(target, 'external.txt'), 'utf8'), 'external directory');
    }
  });
}

test('rejects an existing target that is not a directory', () => {
  const source = tempDir('source');
  const target = path.join(tempDir('target-parent'), 'target-file');
  fs.writeFileSync(target, 'occupied');

  assert.throws(() => validateMigrationPaths(source, target), /目标路径不是目录/);
});

test('cleans staging and leaves the final target retryable when copying fails', async () => {
  const source = tempDir('copy-failure-source');
  const parent = tempDir('copy-failure-target-parent');
  const target = path.join(parent, 'data');
  fs.writeFileSync(path.join(source, 'config.db'), 'source database');
  const fsApi = new Proxy(fs, {
    get(realFs, property) {
      if (property !== 'cpSync') return realFs[property];
      return (...arguments_) => {
        realFs.cpSync(...arguments_);
        throw new Error('injected copy failure');
      };
    },
  });

  await assert.rejects(
    () => copyAndVerifyDirectory(source, target, { fsApi }),
    /injected copy failure/,
  );
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'source database');
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(stagingEntries(parent, 'data'), []);

  const retry = await copyAndVerifyDirectory(source, target);
  assert.equal(retry.fileCount, 1);
});

test('cleans staging and preserves an existing empty final target when manifest verification fails', async () => {
  const source = tempDir('hash-failure-source');
  const parent = tempDir('hash-failure-target-parent');
  const target = path.join(parent, 'data');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'config.db'), 'source database');
  const fsApi = new Proxy(fs, {
    get(realFs, property) {
      if (property !== 'readFileSync') return realFs[property];
      return (filePath, ...arguments_) => {
        const bytes = realFs.readFileSync(filePath, ...arguments_);
        return String(filePath).includes('.mythpen-staging-')
          ? Buffer.concat([bytes, Buffer.from('corrupted')])
          : bytes;
      };
    },
  });

  await assert.rejects(
    () => copyAndVerifyDirectory(source, target, { fsApi }),
    /迁移校验失败/,
  );
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'source database');
  assert.equal(fs.existsSync(target), true);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.deepEqual(stagingEntries(parent, 'data'), []);

  const retry = await copyAndVerifyDirectory(source, target);
  assert.equal(retry.fileCount, 1);
});

test('successful no-clobber publication replaces an empty placeholder only after verification', {
  timeout: WINDOWS_MULTI_MOVE_TIMEOUT_MS,
}, async () => {
  const source = tempDir('placeholder-success-source');
  const parent = tempDir('placeholder-success-target-parent');
  const target = path.join(parent, 'data');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'config.db'), 'source database');
  const originalIdentity = fs.statSync(target).ino;

  const result = await copyAndVerifyDirectory(source, target);

  assert.equal(result.fileCount, 1);
  assert.notEqual(fs.statSync(target).ino, originalIdentity);
  assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'source database');
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'source database');
  assert.deepEqual(internalMigrationEntries(parent, 'data'), []);
});

test('preserves real external file and directory siblings with the backup prefix', {
  timeout: WINDOWS_MULTI_MOVE_TIMEOUT_MS,
}, async () => {
  const source = tempDir('backup-sibling-source');
  const parent = tempDir('backup-sibling-target-parent');
  const target = path.join(parent, 'data');
  const externalFile = path.join(parent, '.data.mythpen-backup-external-file');
  const externalEmptyDirectory = path.join(parent, '.data.mythpen-backup-external-empty');
  const externalNonEmptyDirectory = path.join(parent, '.data.mythpen-backup-external-nonempty');
  fs.mkdirSync(target);
  fs.writeFileSync(externalFile, 'not ours');
  fs.mkdirSync(externalEmptyDirectory);
  fs.mkdirSync(externalNonEmptyDirectory);
  fs.writeFileSync(path.join(externalNonEmptyDirectory, 'external.txt'), 'also not ours');
  fs.writeFileSync(path.join(source, 'config.db'), 'source database');
  const originalIdentities = {
    file: fs.statSync(externalFile).ino,
    empty: fs.statSync(externalEmptyDirectory).ino,
    nonempty: fs.statSync(externalNonEmptyDirectory).ino,
  };

  const result = await copyAndVerifyDirectory(source, target, {
    // This legacy seam points the old naked-rename implementation at the real
    // external file. The owned-container implementation intentionally ignores it.
    backupNameGenerator: () => 'external-file',
  });

  assert.equal(result.fileCount, 1);
  assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'source database');
  assert.equal(fs.statSync(externalFile).ino, originalIdentities.file);
  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'not ours');
  assert.equal(fs.statSync(externalEmptyDirectory).ino, originalIdentities.empty);
  assert.deepEqual(fs.readdirSync(externalEmptyDirectory), []);
  assert.equal(fs.statSync(externalNonEmptyDirectory).ino, originalIdentities.nonempty);
  assert.equal(
    fs.readFileSync(path.join(externalNonEmptyDirectory, 'external.txt'), 'utf8'),
    'also not ours',
  );
  assert.deepEqual(internalMigrationEntries(parent, 'data').sort(), [
    path.basename(externalEmptyDirectory),
    path.basename(externalFile),
    path.basename(externalNonEmptyDirectory),
  ].sort());
});

test('publication conflict preserves both the external target and original placeholder', async () => {
  const source = tempDir('placeholder-conflict-source');
  const parent = tempDir('placeholder-conflict-target-parent');
  const target = path.join(parent, 'data');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'config.db'), 'source database');
  const originalIdentity = fs.statSync(target).ino;
  let externalIdentity;
  const execFile = (file, arguments_, options, callback) => {
    const move = decodedMovePaths(arguments_);
    if (move.target === target) {
      fs.writeFileSync(target, 'external target');
      externalIdentity = fs.statSync(target).ino;
    }
    return realExecFile(file, arguments_, options, callback);
  };
  let thrown;

  await assert.rejects(
    () => copyAndVerifyDirectory(source, target, { execFile, platform: 'win32' }),
    (error) => {
      thrown = error;
      return /发布时已被占用.*原空目标安全保留在/.test(error.message);
    },
  );

  assert.equal(fs.statSync(target).ino, externalIdentity);
  assert.equal(fs.readFileSync(target, 'utf8'), 'external target');
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'source database');
  assert.deepEqual(stagingEntries(parent, 'data'), []);
  const containers = fs.readdirSync(parent)
    .filter((entry) => entry.startsWith('.data.mythpen-backup-'));
  assert.equal(containers.length, 1);
  const preservedTarget = path.join(parent, containers[0], 'original-target');
  assert.equal(fs.statSync(preservedTarget).ino, originalIdentity);
  assert.deepEqual(fs.readdirSync(preservedTarget), []);
  assert.match(thrown.message, new RegExp(
    preservedTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ));
});

for (const childType of ['file', 'directory', 'junction']) {
  test(`backup publication never replaces an existing ${childType} child`, async () => {
    const source = tempDir(`backup-${childType}-source`);
    const parent = tempDir(`backup-${childType}-parent`);
    const target = path.join(parent, 'data');
    const external = tempDir(`backup-${childType}-external`);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'story.md'), 'source story');
    fs.writeFileSync(path.join(external, 'external.txt'), 'external');
    const originalTargetIdentity = fs.statSync(target).ino;
    const externalIdentity = fs.statSync(external).ino;
    let backupChild;
    let backupContainer;
    let childIdentity;
    const execFile = (file, arguments_, options, callback) => {
      const move = decodedMovePaths(arguments_);
      if (path.basename(move.target) !== 'original-target') {
        callback(new Error('backup atomic helper was not invoked first'), '', '');
        return;
      }
      backupChild = move.target;
      backupContainer = path.dirname(backupChild);
      if (childType === 'file') {
        fs.writeFileSync(backupChild, 'external file');
      } else if (childType === 'directory') {
        fs.mkdirSync(backupChild);
        fs.writeFileSync(path.join(backupChild, 'external.txt'), 'external directory');
      } else {
        fs.symlinkSync(external, backupChild, 'junction');
      }
      childIdentity = fs.lstatSync(backupChild).ino;
      return realExecFile(file, arguments_, options, callback);
    };
    let thrown;

    await assert.rejects(
      () => copyAndVerifyDirectory(source, target, {
        execFile,
        platform: 'win32',
      }),
      (error) => {
        thrown = error;
        return /备份|original-target|原空目标/.test(error.message);
      },
    );

    assert.equal(fs.statSync(target).ino, originalTargetIdentity, childType);
    assert.deepEqual(fs.readdirSync(target), [], childType);
    assert.equal(fs.lstatSync(backupChild).ino, childIdentity, childType);
    assert.equal(fs.statSync(external).ino, externalIdentity, childType);
    assert.equal(fs.readFileSync(path.join(external, 'external.txt'), 'utf8'), 'external');
    if (childType === 'file') {
      assert.equal(fs.readFileSync(backupChild, 'utf8'), 'external file');
    } else if (childType === 'directory') {
      assert.equal(
        fs.readFileSync(path.join(backupChild, 'external.txt'), 'utf8'),
        'external directory',
      );
    }
    assert.equal(fs.existsSync(backupContainer), true);
    assert.match(thrown.message, new RegExp(
      backupContainer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));
    assert.match(thrown.message, new RegExp(
      backupChild.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));
    assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'source story');
    assert.deepEqual(stagingEntries(parent, 'data'), []);
  });
}

test('corroborates a completed placeholder backup after a synthetic callback error', async () => {
  const source = tempDir('backup-signal-source');
  const parent = tempDir('backup-signal-parent');
  const target = path.join(parent, 'data');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, 'story.md'), 'source story');
  let backupMoveCalls = 0;
  const execFile = (file, arguments_, options, callback) => {
    const move = decodedMovePaths(arguments_);
    return realExecFile(file, arguments_, options, (error, stdout, stderr) => {
      if (error || path.basename(move.target) !== 'original-target') {
        callback(error, stdout, stderr);
        return;
      }
      backupMoveCalls += 1;
      callback(
        Object.assign(new Error('synthetic backup signal'), { signal: 'SIGTERM' }),
        stdout,
        'synthetic backup transport failure',
      );
    });
  };

  const result = await copyAndVerifyDirectory(source, target, {
    execFile,
    platform: 'win32',
  });

  assert.equal(backupMoveCalls, 1);
  assert.equal(result.fileCount, 1);
  assert.equal(fs.readFileSync(path.join(target, 'story.md'), 'utf8'), 'source story');
  assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'source story');
  assert.deepEqual(internalMigrationEntries(parent, 'data'), []);
});

for (const cleanupFailure of ['child', 'container']) {
  test(`commits published data and reports an exact ${cleanupFailure} cleanup warning`, async () => {
    const source = tempDir(`${cleanupFailure}-cleanup-source`);
    const parent = tempDir(`${cleanupFailure}-cleanup-target-parent`);
    const target = path.join(parent, 'data');
    const externalFile = path.join(parent, '.data.mythpen-backup-external');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'config.db'), 'complete new data');
    fs.writeFileSync(externalFile, 'external content');
    let failedPath;
    const fsApi = new Proxy(fs, {
      get(realFs, property) {
        if (property !== 'rmdirSync') return realFs[property];
        return (directory) => {
          const isChild = path.basename(directory) === 'original-target';
          const shouldFail = cleanupFailure === 'child'
            ? isChild
            : !isChild && path.basename(directory).startsWith('.data.mythpen-backup-');
          if (shouldFail) {
            failedPath = directory;
            throw new Error(`injected ${cleanupFailure} cleanup failure`);
          }
          return realFs.rmdirSync(directory);
        };
      },
    });

    const result = await copyAndVerifyDirectory(source, target, { fsApi });

    assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'complete new data');
    assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'complete new data');
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external content');
    assert.deepEqual(result.cleanupWarnings, [{
      path: failedPath,
      error: `injected ${cleanupFailure} cleanup failure`,
    }]);
    assert.equal(fs.existsSync(failedPath), true);
    if (cleanupFailure === 'child') {
      assert.deepEqual(fs.readdirSync(failedPath), []);
    } else {
      assert.deepEqual(fs.readdirSync(failedPath), []);
    }
  });
}

test('reports a listening loopback server as running', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    assert.equal(await isServerRunning({ port, timeoutMs: 100 }), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('reports a refused loopback connection as not running', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  assert.equal(await isServerRunning({ port, timeoutMs: 100 }), false);
});
