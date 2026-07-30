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
