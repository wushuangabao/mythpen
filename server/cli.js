#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createPathStore } = require('./path-store');
const {
  DATA_DIR_VALUE,
  EXPORT_DIR_VALUE,
  resolveStoragePaths,
} = require('./storage-paths');
const {
  assertDataRootMigrationSupported: inspectDataRootMigrationSupport,
  copyAndVerifyDirectory,
} = require('./storage-migration');
const { acquireConfigLifecycleLeaseSet } = require('./config-lifecycle-lease');
const {
  createProductionDataRootPolicyAuthority,
} = require('./manuscript/production-data-root-policy');

const HELP = `Mythpen storage CLI

Usage:
  mythpen-cli data-dir get
  mythpen-cli data-dir set <path> [--migrate]
  mythpen-cli export-dir get
  mythpen-cli export-dir set <path> [--migrate]
`;

async function runCli(argv, dependencies = {}) {
  const stdout = dependencies.stdout || { write: (line) => console.log(line) };
  const stderr = dependencies.stderr || { write: (line) => console.error(line) };
  const store = dependencies.store || createPathStore();
  const env = dependencies.env || process.env;
  const homeDir = dependencies.homeDir;
  const migrateDirectory = dependencies.copyAndVerifyDirectory || copyAndVerifyDirectory;
  const assertMigrationSupported = dependencies.assertDataRootMigrationSupported
    || inspectDataRootMigrationSupport;
  const dataRootPolicyAuthority = Object.hasOwn(dependencies, 'dataRootPolicyAuthority')
    ? dependencies.dataRootPolicyAuthority
    : createProductionDataRootPolicyAuthority();
  const acquireConfigLeases = dependencies.acquireConfigLifecycleLeaseSet
    || acquireConfigLifecycleLeaseSet;
  const [scope, action, ...arguments_] = argv;
  const definitions = {
    'data-dir': { key: DATA_DIR_VALUE, field: 'dataDir', envKey: 'MYTHPEN_DATA_DIR' },
    'export-dir': { key: EXPORT_DIR_VALUE, field: 'exportDir', envKey: 'MYTHPEN_EXPORT_DIR' },
  };
  const definition = definitions[scope];

  if (!definition || !['get', 'set'].includes(action)) {
    stderr.write(HELP.trimEnd());
    return 2;
  }

  if (action === 'get') {
    if (arguments_.length !== 0) {
      stderr.write(HELP.trimEnd());
      return 2;
    }
    const before = resolveStoragePaths({ store, env, homeDir });
    stdout.write(before[definition.field]);
    return 0;
  }

  const [rawTarget, ...flags] = arguments_;
  const migrate = arguments_.length === 2 && flags[0] === '--migrate';
  const hasTargetOnly = arguments_.length === 1;
  if (!rawTarget || rawTarget.startsWith('--') || (!hasTargetOnly && !migrate)) {
    stderr.write(HELP.trimEnd());
    return 2;
  }

  const before = resolveStoragePaths({ store, env, homeDir });
  const target = path.resolve(rawTarget);
  let migrationResult = null;
  let configLeases = null;
  let resultCode = 0;
  const migrationGuardOptions = Object.freeze({
    migrate,
    policyAuthority: dataRootPolicyAuthority,
    requirePolicyAuthority: true,
    targetRoot: target,
  });
  try {
    if (scope === 'data-dir') {
      await assertMigrationSupported(before.dataDir, migrationGuardOptions);
    }
    const configPaths = [before.configDbPath];
    if (scope === 'data-dir') configPaths.push(path.join(target, 'config.db'));
    configLeases = acquireConfigLeases(configPaths, {
      ...(dependencies.applicationControlRoot
        ? { controlRoot: dependencies.applicationControlRoot }
        : {}),
    });
    if (scope === 'data-dir') {
      await assertMigrationSupported(before.dataDir, migrationGuardOptions);
    }

    if (migrate) {
      migrationResult = await migrateDirectory(before[definition.field], target);
    } else {
      fs.mkdirSync(target, { recursive: true });
    }

    try {
      store.set(definition.key, target);
    } catch (error) {
      if (migrationResult) {
        const residuals = (migrationResult.cleanupWarnings || [])
          .map((warning) => `${warning.path}（${warning.error}）`)
          .join('；');
        stderr.write(
          `迁移数据已提交：${target}；配置保存失败；源目录仍保留：${migrationResult.source}；`
          + `请恢复执行：mythpen-cli ${scope} set "${target}"；底层原因：${error.message}`
          + (residuals ? `；待清理残留：${residuals}` : ''),
        );
      } else {
        stderr.write(`目录已准备但配置保存失败：${target}；底层原因：${error.message}`);
      }
      resultCode = 1;
    }
    if (resultCode === 0 && migrationResult) {
      stdout.write(`已复制并校验 ${migrationResult.fileCount} 个文件；源目录仍保留：${migrationResult.source}`);
    }
    for (const warning of resultCode === 0 ? migrationResult?.cleanupWarnings || [] : []) {
      stdout.write(
        `迁移已完成，但临时备份清理失败：${warning.path}（${warning.error}）`,
      );
    }
    if (resultCode === 0 && env[definition.envKey]) {
      stdout.write(`持久设置已保存：${scope}：${target}`);
      stdout.write(`当前有效路径仍由环境变量 ${definition.envKey} 覆盖：${before[definition.field]}`);
    } else if (resultCode === 0) {
      stdout.write(`已设置 ${scope}：${target}`);
      stdout.write('请重新启动 Mythpen 使设置生效。');
    }
  } catch (error) {
    stderr.write(error.message);
    resultCode = 1;
  } finally {
    if (configLeases) {
      try {
        configLeases.release();
      } catch (error) {
        stderr.write(error.message);
        resultCode = 1;
      }
    }
  }
  return resultCode;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { HELP, runCli };
