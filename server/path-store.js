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
          stdio: ['ignore', 'pipe', 'ignore'],
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
