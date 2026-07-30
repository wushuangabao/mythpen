const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile: realExecFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../cli');
const { copyAndVerifyDirectory } = require('../storage-migration');

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

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mythpen-cli-${name}-`));
}

async function inTemporaryWorkingDirectory(callback) {
  const previous = process.cwd();
  const directory = tempDir('cwd');
  process.chdir(directory);
  try {
    return await callback(directory);
  } finally {
    process.chdir(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

test('get rejects every extra argument without output or configuration changes', async () => {
  for (const argv of [
    ['data-dir', 'get', 'unexpected'],
    ['export-dir', 'get', '--migrate'],
  ]) {
    const store = memoryStore({ DataDir: 'C:\\OldData', ExportDir: 'C:\\OldExports' });
    const stdout = output();
    const stderr = output();

    const code = await runCli(argv, {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      stdout,
      stderr,
    });

    assert.equal(code, 2, argv.join(' '));
    assert.deepEqual(stdout.lines, [], argv.join(' '));
    assert.deepEqual(store.values, { DataDir: 'C:\\OldData', ExportDir: 'C:\\OldExports' });
    assert.match(stderr.lines.join('\n'), /mythpen-cli data-dir get/);
  }
});

test('set rejects malformed argument shapes without creating directories or changing configuration', async () => {
  await inTemporaryWorkingDirectory(async (workingDirectory) => {
    const target = path.join(workingDirectory, 'target');
    const malformedArgv = [
      ['data-dir', 'set', '--migrate'],
      ['data-dir', 'set', target, '--migrate', '--migrate'],
      ['data-dir', 'set', target, '--force'],
      ['data-dir', 'set', '--migrate', target],
      ['data-dir', 'set', target, 'extra'],
    ];

    for (const argv of malformedArgv) {
      const store = memoryStore({ DataDir: 'C:\\OldData' });
      const stderr = output();
      const code = await runCli(argv, {
        store,
        env: {},
        homeDir: 'C:\\Users\\author',
        stdout: output(),
        stderr,
      });

      assert.equal(code, 2, argv.join(' '));
      assert.deepEqual(store.values, { DataDir: 'C:\\OldData' }, argv.join(' '));
      assert.match(stderr.lines.join('\n'), /mythpen-cli data-dir get/);
    }

    assert.equal(fs.existsSync(path.join(workingDirectory, '--migrate')), false);
    assert.equal(fs.existsSync(target), false);
  });
});

test('data-dir set --migrate switches only after a successful verified copy', async () => {
  const source = tempDir('data-source');
  const target = path.join(tempDir('data-target'), 'data');
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

test('a failed verified copy leaves the existing data-dir configuration unchanged', async () => {
  const source = tempDir('failed-copy-source');
  const target = path.join(tempDir('failed-copy-target'), 'occupied-target');
  fs.writeFileSync(path.join(source, 'config.db'), 'database');
  fs.writeFileSync(target, 'not a directory');
  const store = memoryStore({ DataDir: source });
  const stderr = output();

  const code = await runCli(['data-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false,
    stdout: output(),
    stderr,
  });

  assert.equal(code, 1);
  assert.equal(store.values.DataDir, source);
  assert.match(stderr.lines.join('\n'), /目标路径不是目录/);
});

test('copy and manifest failures leave configuration unchanged and the same target retryable', async () => {
  for (const failure of ['copy', 'manifest']) {
    const source = tempDir(`${failure}-fault-source`);
    const parent = tempDir(`${failure}-fault-target-parent`);
    const target = path.join(parent, 'data');
    fs.writeFileSync(path.join(source, 'config.db'), 'source database');
    const store = memoryStore({ DataDir: source });
    const fsApi = new Proxy(fs, {
      get(realFs, property) {
        if (failure === 'copy' && property === 'cpSync') {
          return (...arguments_) => {
            realFs.cpSync(...arguments_);
            throw new Error('injected copy failure');
          };
        }
        if (failure === 'manifest' && property === 'readFileSync') {
          return (filePath, ...arguments_) => {
            const bytes = realFs.readFileSync(filePath, ...arguments_);
            return String(filePath).includes('.mythpen-staging-')
              ? Buffer.concat([bytes, Buffer.from('corrupted')])
              : bytes;
          };
        }
        return realFs[property];
      },
    });

    const code = await runCli(['data-dir', 'set', target, '--migrate'], {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      isServerRunning: async () => false,
      copyAndVerifyDirectory: (from, to) => copyAndVerifyDirectory(from, to, { fsApi }),
      stdout: output(),
      stderr: output(),
    });

    assert.equal(code, 1, failure);
    assert.equal(store.values.DataDir, source, failure);
    assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'source database', failure);
    assert.equal(fs.existsSync(target), false, failure);
    assert.deepEqual(
      fs.readdirSync(parent).filter((entry) => entry.includes('.mythpen-staging-')),
      [],
      failure,
    );
  }
});

test('cleanup warnings are printed after the verified path is persisted', async () => {
  for (const cleanupFailure of ['child', 'container']) {
    const source = tempDir(`${cleanupFailure}-cleanup-cli-source`);
    const parent = tempDir(`${cleanupFailure}-cleanup-cli-target-parent`);
    const target = path.join(parent, 'data');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'config.db'), 'complete new data');
    const events = [];
    const store = memoryStore({ DataDir: source });
    const storeSet = store.set;
    store.set = (name, value) => {
      events.push('store.set');
      storeSet(name, value);
    };
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
    const stdout = {
      write(line) {
        events.push(String(line));
      },
    };

    const code = await runCli(['data-dir', 'set', target, '--migrate'], {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      isServerRunning: async () => false,
      copyAndVerifyDirectory: (from, to) => copyAndVerifyDirectory(from, to, { fsApi }),
      stdout,
      stderr: output(),
    });

    const warningIndex = events.findIndex((event) => (
      event.includes('迁移已完成，但临时备份清理失败')
    ));
    assert.equal(code, 0, cleanupFailure);
    assert.equal(store.values.DataDir, path.resolve(target), cleanupFailure);
    assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'complete new data');
    assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'complete new data');
    assert.ok(warningIndex > events.indexOf('store.set'), cleanupFailure);
    assert.match(events[warningIndex], new RegExp(
      failedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ));
    assert.match(events[warningIndex], new RegExp(`injected ${cleanupFailure} cleanup failure`));
  }
});

test('stdout failures after a committed migration cannot prevent configuration persistence', async () => {
  for (const throwOnWrite of [1, 2, 3]) {
    const source = tempDir(`stdout-${throwOnWrite}-source`);
    const target = path.join(tempDir(`stdout-${throwOnWrite}-target-parent`), 'data');
    fs.writeFileSync(path.join(source, 'config.db'), 'committed data');
    const store = memoryStore({ DataDir: source });
    const stderr = output();
    let writes = 0;

    const code = await runCli(['data-dir', 'set', target, '--migrate'], {
      store,
      env: {},
      homeDir: 'C:\\Users\\author',
      isServerRunning: async () => false,
      stdout: {
        write() {
          writes += 1;
          if (writes === throwOnWrite) {
            throw new Error(`injected stdout failure ${throwOnWrite}`);
          }
        },
      },
      stderr,
    });

    assert.equal(code, 1, throwOnWrite);
    assert.equal(store.values.DataDir, path.resolve(target), throwOnWrite);
    assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'committed data');
    assert.match(stderr.lines.join('\n'), new RegExp(`injected stdout failure ${throwOnWrite}`));
  }
});

test('migration publishes through the Windows atomic helper boundary', async () => {
  for (const externalType of ['file', 'directory', 'junction']) {
    const source = tempDir(`${externalType}-atomic-boundary-source`);
    const parent = tempDir(`${externalType}-atomic-boundary-parent`);
    const target = path.join(parent, 'data');
    const external = tempDir(`${externalType}-atomic-boundary-external`);
    fs.writeFileSync(path.join(source, 'story.md'), 'source story');
    fs.writeFileSync(path.join(external, 'external.txt'), 'external');
    const externalIdentity = fs.statSync(external).ino;
    const store = memoryStore({ DataDir: source });
    let helperCalls = 0;
    let targetIdentity;
    const execFile = (file, arguments_, options, callback) => {
      helperCalls += 1;
      if (externalType === 'file') {
        fs.writeFileSync(target, 'external file');
      } else if (externalType === 'directory') {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'external.txt'), 'external directory');
      } else {
        fs.symlinkSync(external, target, 'junction');
      }
      targetIdentity = fs.lstatSync(target).ino;
      return realExecFile(file, arguments_, options, callback);
    };
    const stderr = output();

    const code = await runCli(['data-dir', 'set', target, '--migrate'], {
      store, env: {}, homeDir: 'C:\\Users\\author',
      isServerRunning: async () => false,
      copyAndVerifyDirectory: (from, to) => copyAndVerifyDirectory(from, to, {
        execFile,
        platform: 'win32',
      }),
      stdout: output(), stderr,
    });

    assert.equal(helperCalls, 1, externalType);
    assert.equal(code, 1, externalType);
    assert.equal(store.values.DataDir, source, externalType);
    assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'source story');
    assert.equal(fs.lstatSync(target).ino, targetIdentity, externalType);
    assert.equal(fs.statSync(external).ino, externalIdentity, externalType);
    assert.equal(fs.readFileSync(path.join(external, 'external.txt'), 'utf8'), 'external');
    if (externalType === 'file') {
      assert.equal(fs.readFileSync(target, 'utf8'), 'external file');
    } else if (externalType === 'directory') {
      assert.equal(fs.readFileSync(path.join(target, 'external.txt'), 'utf8'), 'external directory');
    }
    assert.match(stderr.lines.join('\n'), /原子发布失败|发布时已被占用/);
  }
});

test('persists a corroborated commit when execFile reports an error after moving', async () => {
  const source = tempDir('callback-error-source');
  const target = path.join(tempDir('callback-error-parent'), 'new data');
  fs.writeFileSync(path.join(source, 'story.md'), 'committed story');
  const store = memoryStore({ DataDir: source });
  let syntheticErrors = 0;
  const execFile = (file, arguments_, options, callback) => (
    realExecFile(file, arguments_, options, (error, stdout, stderr) => {
      if (error) {
        callback(error, stdout, stderr);
        return;
      }
      syntheticErrors += 1;
      callback(
        Object.assign(new Error('synthetic signal after committed move'), {
          signal: 'SIGTERM',
        }),
        stdout,
        'synthetic transport failure',
      );
    })
  );

  const code = await runCli(['data-dir', 'set', target, '--migrate'], {
    store, env: {}, homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false,
    copyAndVerifyDirectory: (from, to) => copyAndVerifyDirectory(from, to, {
      execFile,
      platform: 'win32',
    }),
    stdout: output(), stderr: output(),
  });

  assert.equal(syntheticErrors, 1);
  assert.equal(code, 0);
  assert.equal(store.values.DataDir, path.resolve(target));
  assert.equal(fs.readFileSync(path.join(target, 'story.md'), 'utf8'), 'committed story');
  assert.equal(fs.readFileSync(path.join(source, 'story.md'), 'utf8'), 'committed story');
});

test('committed migration reports an actionable recovery command when store.set fails', async () => {
  const source = tempDir('store-failure-source');
  const target = path.join(tempDir('store-failure-target-parent'), 'new data');
  fs.writeFileSync(path.join(source, 'config.db'), 'complete data');
  const store = memoryStore({ DataDir: source });
  store.set = () => { throw new Error('registry access denied'); };
  const stderr = output();
  const code = await runCli(['data-dir', 'set', target, '--migrate'], {
    store, env: {}, homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false, stdout: output(), stderr,
  });
  const message = stderr.lines.join('\n');
  assert.equal(code, 1);
  assert.equal(store.values.DataDir, source);
  assert.equal(fs.readFileSync(path.join(target, 'config.db'), 'utf8'), 'complete data');
  assert.equal(fs.readFileSync(path.join(source, 'config.db'), 'utf8'), 'complete data');
  assert.match(message, /迁移数据已提交/);
  assert.match(message, new RegExp(path.resolve(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(message, /配置保存失败/);
  assert.match(message, /源目录仍保留/);
  assert.match(message, /mythpen-cli data-dir set ".*new data"/);
  assert.match(message, /registry access denied/);
});

test('store failure diagnostic includes every committed cleanup residual', async () => {
  const target = path.resolve(tempDir('warning-store-target'));
  const store = memoryStore({ DataDir: 'C:\\Old' });
  store.set = () => { throw new Error('registry denied'); };
  const stderr = output();
  const warnings = [
    { path: 'C:\\residual\\marker-a', error: 'marker locked' },
    { path: 'C:\\residual\\backup-b', error: 'backup locked' },
  ];
  const code = await runCli(['data-dir', 'set', target, '--migrate'], {
    store, env: {}, homeDir: 'C:\\Users\\author', isServerRunning: async () => false,
    copyAndVerifyDirectory: () => ({
      source: 'C:\\Old', target, fileCount: 1, totalBytes: 1, cleanupWarnings: warnings,
    }),
    stdout: output(), stderr,
  });
  assert.equal(code, 1);
  for (const warning of warnings) {
    assert.match(stderr.lines[0], new RegExp(warning.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(stderr.lines[0], new RegExp(warning.error));
  }
});

test('export-dir get and set --migrate mirror data-dir behavior', async () => {
  const source = tempDir('export-source');
  const target = path.join(tempDir('export-target'), 'exports');
  fs.writeFileSync(path.join(source, 'chapter.docx'), 'document');
  const store = memoryStore({ ExportDir: source });
  const stdout = output();

  const getCode = await runCli(['export-dir', 'get'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    stdout,
    stderr: output(),
  });
  const setCode = await runCli(['export-dir', 'set', target, '--migrate'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    isServerRunning: async () => false,
    stdout,
    stderr: output(),
  });

  assert.equal(getCode, 0);
  assert.equal(stdout.lines[0], path.resolve(source));
  assert.equal(setCode, 0);
  assert.equal(store.values.ExportDir, path.resolve(target));
  assert.equal(fs.readFileSync(path.join(target, 'chapter.docx'), 'utf8'), 'document');
  assert.equal(fs.readFileSync(path.join(source, 'chapter.docx'), 'utf8'), 'document');
});

test('set records persistent paths but reports environment overrides for both storage scopes', async () => {
  for (const scenario of [
    { scope: 'data-dir', key: 'DataDir', envName: 'MYTHPEN_DATA_DIR' },
    { scope: 'export-dir', key: 'ExportDir', envName: 'MYTHPEN_EXPORT_DIR' },
  ]) {
    const target = path.join(tempDir(`${scenario.scope}-persistent`), 'configured');
    const effective = path.join(tempDir(`${scenario.scope}-environment`), 'effective');
    const store = memoryStore();
    const stdout = output();

    const code = await runCli([scenario.scope, 'set', target], {
      store,
      env: { [scenario.envName]: effective },
      homeDir: 'C:\\Users\\author',
      stdout,
      stderr: output(),
    });

    const text = stdout.lines.join('\n');
    assert.equal(code, 0, scenario.scope);
    assert.equal(store.values[scenario.key], path.resolve(target), scenario.scope);
    assert.match(text, /持久设置已保存/, scenario.scope);
    assert.match(text, new RegExp(scenario.envName), scenario.scope);
    assert.match(text, new RegExp(path.resolve(effective).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), scenario.scope);
    assert.doesNotMatch(text, /重新启动 Mythpen 使设置生效/, scenario.scope);
  }
});

test('invalid commands and flags return usage exit code without changing configuration', async () => {
  const store = memoryStore({ DataDir: 'C:\\OldData' });
  const stderr = output();

  const unknownCode = await runCli(['unknown', 'get'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    stdout: output(),
    stderr,
  });
  const invalidFlagCode = await runCli(['data-dir', 'set', 'D:\\NewData', '--force'], {
    store,
    env: {},
    homeDir: 'C:\\Users\\author',
    stdout: output(),
    stderr,
  });

  assert.equal(unknownCode, 2);
  assert.equal(invalidFlagCode, 2);
  assert.equal(store.values.DataDir, 'C:\\OldData');
  assert.match(stderr.lines.join('\n'), /mythpen-cli data-dir get/);
});
