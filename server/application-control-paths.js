const os = require('node:os');
const path = require('node:path');

function resolveStableApplicationControlRoot({ homeDir = os.homedir() } = {}) {
  return path.join(path.resolve(homeDir), '.mythpen-control');
}

module.exports = { resolveStableApplicationControlRoot };
