const path = require('node:path');

const RESULT_PREFIX = 'MYTHPEN_NATIVE_STAGE_B_FIXTURE=';

async function main() {
  const request = JSON.parse(process.argv[2] || '{}');
  const isolatedRoot = path.resolve(String(request.isolatedRoot || ''));
  const projectName = String(request.projectName || '');
  if (!isolatedRoot || !projectName) throw new Error('isolatedRoot and projectName are required');
  if (Object.keys(request).some((key) => (
    !['isolatedRoot', 'nativeResidue', 'projectName', 'sentinel'].includes(key)
  ))) {
    throw new TypeError('fixture request contains an unknown key');
  }
  for (const envName of [
    'USERPROFILE',
    'HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'MYTHPEN_DATA_DIR',
    'MYTHPEN_EXPORT_DIR',
  ]) {
    if (path.resolve(process.env[envName] || '') !== isolatedRoot) {
      throw new Error(`${envName} must be isolated before db.js loads`);
    }
  }

  // This require deliberately happens only after the child process environment
  // has been validated. db.js acquires its config lifecycle lease during init.
  const database = require('../../db');
  let primaryError;
  try {
    await database.initDatabase();
    const projectDb = database.createProjectDb(projectName);
    if (request.sentinel !== undefined) {
      const sentinel = request.sentinel;
      if (
        sentinel === null
        || typeof sentinel !== 'object'
        || Array.isArray(sentinel)
        || Object.keys(sentinel).sort().join(',') !== 'background,id,name'
        || typeof sentinel.id !== 'string'
        || typeof sentinel.name !== 'string'
        || typeof sentinel.background !== 'string'
      ) {
        throw new TypeError('sentinel must have exact id, name, and background strings');
      }
      projectDb.prepare(
        'INSERT INTO characters (id, name, background) VALUES (?, ?, ?)',
      ).run(sentinel.id, sentinel.name, sentinel.background);
    }
    if (request.nativeResidue !== undefined) {
      if (!['gate', 'trigger-prefix'].includes(request.nativeResidue)) {
        throw new TypeError('nativeResidue must be gate or trigger-prefix');
      }
      if (request.nativeResidue === 'gate') {
        projectDb.exec(
          'CREATE TABLE "_durability_write_gate" ('
          + '"gate_id" INTEGER NOT NULL PRIMARY KEY CHECK ("gate_id" = 1)) WITHOUT ROWID',
        );
      } else {
        projectDb.exec([
          'CREATE TRIGGER "_mythpen_downgrade_guard__residual_characters_insert"',
          'AFTER INSERT ON "characters"',
          'BEGIN',
          '  SELECT 1;',
          'END',
        ].join('\n'));
      }
    }
    const databasePath = database.getProjectDbPath(projectName);
    database.closeAllDatabases();
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify({ databasePath })}\n`);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (primaryError) {
      try {
        database.closeAllDatabases();
      } catch {
        // Preserve the fixture creation error; the child exits immediately.
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
