// ─── SQL.js-based database layer (replaces better-sqlite3) ───
// Uses sql.js (pure JS/WASM SQLite) instead of better-sqlite3 (native addon)
// so that bun build --compile can produce a standalone binary without native .node files.

const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { resolveStoragePaths } = require('./storage-paths');
const { repairRecentProjectPaths } = require('./recent-project-paths');
const { compareTimelineEvents } = require('./timeline-order');

const STORAGE_PATHS = resolveStoragePaths();
const DB_DIR = STORAGE_PATHS.dataDir;
const CONFIG_DB = STORAGE_PATHS.configDbPath;
const PROJECTS_DIR = STORAGE_PATHS.projectsDir;
const EXPORT_DIR = STORAGE_PATHS.exportDir;

// ─── Ensure directories ───
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

let SQL;         // set by initDatabase()
let configDb;    // wrapped config database

// ═══════════════════════════════════════════════════════════════
// Schema versioning — bump these when adding migrations
// ═══════════════════════════════════════════════════════════════

const CONFIG_SCHEMA_VERSION = 1;
const PROJECT_SCHEMA_VERSION = 10;

// ═══════════════════════════════════════════════════════════════
// sql.js wrapper — provides a better-sqlite3-compatible API
// ═══════════════════════════════════════════════════════════════

function _loadDb(filePath) {
  if (fs.existsSync(filePath)) {
    const buf = fs.readFileSync(filePath);
    return new SQL.Database(buf);
  }
  return new SQL.Database();
}

function attachSecondaryError(primaryError, property, secondaryError) {
  if ((typeof primaryError !== 'object' && typeof primaryError !== 'function') || primaryError === null) return;
  try {
    Object.defineProperty(primaryError, property, {
      value: secondaryError,
      configurable: true,
    });
  } catch {
    // A frozen/custom thrown value still keeps its original identity below.
  }
}

function _flushDb(db, filePath) {
  let data;
  let exportFailed = false;
  let exportError;
  try {
    data = db.export();
  } catch (error) {
    exportFailed = true;
    exportError = error;
  }

  let restoreFailed = false;
  let restoreError;
  try {
    // sql.js resets connection-local PRAGMAs when export() rebuilds the
    // underlying database. Every persistence path (scheduled writes,
    // transactions, migrations, and close) comes through here, so restore
    // referential-integrity enforcement before returning to callers.
    db.run('PRAGMA foreign_keys = ON');
  } catch (error) {
    restoreFailed = true;
    restoreError = error;
  }

  if (exportFailed) {
    if (restoreFailed) attachSecondaryError(exportError, 'foreignKeyRestoreError', restoreError);
    throw exportError;
  }
  if (restoreFailed) throw restoreError;
  fs.writeFileSync(filePath, Buffer.from(data));
}

// ─── Named-param helper ───
// sql.js 1.13+ has a bug where binding named params via object (e.g. {id:1})
// doesn't work — values come through as NULL.
// We work around it by converting @param / :param / $param → ? at the JS level.
const NAMED_PARAM_RE = /[$@:](\w+)/g;

function _normalizeParams(params) {
  if (params.length === 0) return null;
  // Single plain object = named params (e.g. {id: 1, name: 'test'})
  if (params.length === 1 && typeof params[0] === 'object' && params[0] !== null && !Array.isArray(params[0])) {
    return { named: true, values: params[0] };
  }
  return { named: false, values: params };
}

function _buildSql(sqlText, bindMeta) {
  if (!bindMeta) return { sql: sqlText, args: null };
  if (!bindMeta.named) {
    // Positional params — convert undefined → null for sql.js compatibility
    return { sql: sqlText, args: bindMeta.values.map(v => v === undefined ? null : v) };
  }
  // Named params — convert to positional ? and collect values in SQL order
  const args = [];
  const converted = sqlText.replace(NAMED_PARAM_RE, (_, name) => {
    if (bindMeta.values[name] !== undefined) {
      args.push(bindMeta.values[name]);
      return '?';
    }
    // Keep unknown named params as-is (unbound → SQLite treats as NULL)
    return '@' + name;
  });
  return { sql: converted, args };
}

/**
 * Wrap a raw sql.js Database instance so it quacks like better-sqlite3.
 * Supports: .pragma(), .prepare(sql).{all,get,run}(), .exec(), .run(), .transaction(), .flush(), .close()
 *
 * IMPORTANT: Each .run()/.all()/.get() creates its own fresh prepared statement
 * because sql.js's db.export() (called by _flushDb) invalidates ALL existing statements.
 * The statement is freed before _flushDb() so export() never hits a stale handle.
 */
const DB_FLUSH_DELAY = 250; // ms — batch writes up to this interval

function _wrapDb(db, filePath) {
  let dirty = false;
  let flushTimer = null;

  function _flushSync() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dirty) return;
    dirty = false;
    _flushDb(db, filePath);
  }

  function _scheduleFlush() {
    dirty = true;
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        _flushSync();
      }, DB_FLUSH_DELAY);
    }
  }

  return {
    _db: db,
    _path: filePath,

    pragma(sql) {
      db.run('PRAGMA ' + sql);
    },

    prepare(sql) {
      return {
        all(...params) {
          const { sql: sql2, args } = _buildSql(sql, _normalizeParams(params));
          const s = db.prepare(sql2);
          if (args) s.bind(args);
          const rows = [];
          while (s.step()) rows.push(s.getAsObject());
          s.free();
          return rows;
        },
        get(...params) {
          const { sql: sql2, args } = _buildSql(sql, _normalizeParams(params));
          const s = db.prepare(sql2);
          if (args) s.bind(args);
          let row = null;
          if (s.step()) row = s.getAsObject();
          s.free();
          return row;
        },
        run(...params) {
          const { sql: sql2, args } = _buildSql(sql, _normalizeParams(params));
          const s = db.prepare(sql2);
          if (args) s.bind(args);
          s.step();
          const changes = db.getRowsModified();
          s.free();
          _scheduleFlush();
          return { changes };
        },
      };
    },

    exec(sql) {
      const results = db.exec(sql);
      _scheduleFlush();
      return results;
    },

    run(sql, params) {
      db.run(sql, params || []);
      _scheduleFlush();
    },

    transaction(fn) {
      return (...args) => {
        db.run('BEGIN');
        let result;
        try {
          result = fn(...args);
          db.run('COMMIT');
        } catch (e) {
          try {
            db.run('ROLLBACK');
          } catch (rollbackError) {
            attachSecondaryError(e, 'rollbackError', rollbackError);
          }
          throw e;
        }
        // Keep persistence outside the transaction catch: once COMMIT succeeds,
        // a flush failure must not trigger an invalid ROLLBACK that hides the
        // original persistence error.
        _flushSync(); // flush immediately after commit for data safety
        return result;
      };
    },

    flush() {
      _flushSync();
    },

    close() {
      _flushSync();
      db.close();
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Initialisation (MUST be called before any other db function)
// ═══════════════════════════════════════════════════════════════

async function initDatabase() {
  console.log('[DB] Initialising database...');
  console.log('[DB] DB_DIR:', DB_DIR, '| CONFIG_DB:', CONFIG_DB);
  const t0 = Date.now();

  // ─── Load sql.js library ───
  const initSqlJs = require('sql.js');
  console.log('[DB] sql.js library loaded');

  // ─── Load sql-wasm.wasm ───
  // In bun --compile binaries there's no node_modules, so sql.js cannot
  // locate its WASM file via module resolution. We must provide the WASM
  // binary explicitly via initSqlJs({ wasmBinary }).
  //
  // Multiple strategies tried in order:
  //   1. base64-embedded module (works in both bun dev and --compile)
  //   2. fs.readFileSync relative to __dirname (dev mode)
  //   3. fs.readFileSync relative to CWD (fallback)
  let wasmBinary;

  // Strategy 1: base64-embedded WASM (prevents bun --assets bug in 1.3.14)
  try {
    const { getWasmBinary } = require('./wasm-binary');
    wasmBinary = getWasmBinary();
    console.log('[DB] WASM loaded via base64 embedded module');
  } catch (e) {
    console.log('[DB] Embedded WASM module not available:', e.message);
  }

  // Strategy 2: fs.readFileSync relative to this file (dev mode, file on disk)
  if (!wasmBinary) {
    try {
      const wasmPath = path.join(__dirname, 'sql-wasm.wasm');
      if (fs.existsSync(wasmPath)) {
        wasmBinary = fs.readFileSync(wasmPath);
        console.log('[DB] WASM loaded from:', wasmPath);
      }
    } catch {
      // strategy 2 failed
    }
  }

  // Strategy 3: fs.readFileSync from CWD (fallback for bun compiled binary)
  if (!wasmBinary) {
    try {
      const wasmPath = path.join(process.cwd(), 'server', 'sql-wasm.wasm');
      if (fs.existsSync(wasmPath)) {
        wasmBinary = fs.readFileSync(wasmPath);
        console.log('[DB] WASM loaded from:', wasmPath);
      }
    } catch {
      // strategy 3 failed
    }
  }

  if (!wasmBinary) {
    console.log('[DB] WASM not found via any strategy — initSqlJs will use its own loader');
  }

  // ─── Init sql.js runtime ───
  console.log('[DB] Calling initSqlJs()...');
  SQL = await initSqlJs({ wasmBinary });
  console.log('[DB] initSqlJs() OK');

  // ─── Open / create config database ───
  console.log('[DB] Opening config database...');
  configDb = _openConfig();
  console.log('[DB] Config database ready, schema version:', CONFIG_SCHEMA_VERSION);

  const t1 = Date.now();
  console.log(`[DB] Database initialised in ${t1 - t0}ms`);
  return true;
}

function _openConfig() {
  const db = _loadDb(CONFIG_DB);
  db.run('PRAGMA foreign_keys = ON');
  const wrapped = _wrapDb(db, CONFIG_DB);
  migrateConfig(wrapped);
  repairRecentProjectPaths(wrapped, PROJECTS_DIR);
  return wrapped;
}

// ═══════════════════════════════════════════════════════════════
// Config DB
// ═══════════════════════════════════════════════════════════════

function getConfigDb() {
  if (!configDb) throw new Error('Database not initialised – call initDatabase() first');
  return configDb;
}

// ═══════════════════════════════════════════════════════════════
// Generic migration runner
// ═══════════════════════════════════════════════════════════════

function runMigrations(db, migrations, targetVersion, getVersionFn, setVersionFn) {
  let currentVersion = getVersionFn(db);
  if (currentVersion >= targetVersion) return;
  for (let v = currentVersion; v < targetVersion; v++) {
    if (migrations[v]) migrations[v](db);
    setVersionFn(db, v + 1);
  }
}

// ═══════════════════════════════════════════════════════════════
// Config DB migrations
// ═══════════════════════════════════════════════════════════════

const configMigrations = [
  // v0 → v1: initial schema + defaults
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent_projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        file_path   TEXT NOT NULL UNIQUE,
        last_opened TEXT NOT NULL DEFAULT (datetime('now')),
        word_count  INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS editor_snapshots (
        project_path TEXT PRIMARY KEY,
        chapter_num  INTEGER NOT NULL,
        content      TEXT NOT NULL,
        cursor_pos   INTEGER,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Seed default settings if empty
    const count = db.prepare('SELECT COUNT(*) as c FROM app_settings').get().c;
    if (count === 0) {
      const insert = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
      const defaults = [
        ['api_key', ''],
        ['api_base_url', 'https://api.deepseek.com/v1'],
        ['api_model', 'deepseek-v4-flash'],
        ['ui_language', 'zh'],
        ['theme', 'dark'],
        ['editor_font_size', '17'],
        ['editor_font_family', "'Noto Serif SC', 'Source Han Serif SC', 'STSong', Georgia, serif"],
        ['auto_save_interval', '30'],
        ['backup_enabled', 'true'],
        ['accent_color', '#c9a96e'],
      ];
      const innerTx = db.transaction(() => {
        for (const [k, v] of defaults) insert.run(k, v);
      });
      innerTx();
    }
  },
];

function makeVersionGetter(tableName) {
  return (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${tableName} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    try {
      const row = db.prepare(`SELECT value FROM ${tableName} WHERE key = 'schema_version'`).get();
      return row ? parseInt(row.value, 10) || 0 : 0;
    } catch { return 0; }
  };
}

function makeVersionSetter(tableName) {
  return (db, version) => {
    db.prepare(`INSERT OR REPLACE INTO ${tableName} (key, value) VALUES ('schema_version', ?)`).run(String(version));
  };
}

const getConfigVersion = makeVersionGetter('app_settings');
const setConfigVersion = makeVersionSetter('app_settings');

function migrateConfig(db) {
  runMigrations(db, configMigrations, CONFIG_SCHEMA_VERSION, getConfigVersion, setConfigVersion);
}

// ═══════════════════════════════════════════════════════════════
// Project DB Management
// ═══════════════════════════════════════════════════════════════

const projectConnections = new Map();
const projectInstanceContext = new AsyncLocalStorage();

function projectInstanceMismatchError(name) {
  const error = new Error(`项目"${name}"已被删除并重建，请刷新后重试`);
  error.code = 'PROJECT_INSTANCE_MISMATCH';
  error.status = 409;
  error.recoverable = true;
  return error;
}

function readProjectInstanceId(projectDb) {
  return projectDb
    .prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'")
    .get()?.value || '';
}

function validateProjectInstance(projectDb, name, expectedInstanceId) {
  if (!expectedInstanceId) return;
  const actual = readProjectInstanceId(projectDb);
  if (!actual || actual !== expectedInstanceId) throw projectInstanceMismatchError(name);
}

function runWithProjectInstance(name, expectedInstanceId, callback) {
  return projectInstanceContext.run(
    { name, expectedInstanceId: typeof expectedInstanceId === 'string' ? expectedInstanceId : '' },
    callback,
  );
}

function getProjectDbPath(name) {
  return path.join(PROJECTS_DIR, `${name}.mythpen.db`);
}

function openProjectDb(filePath) {
  if (projectConnections.has(filePath)) {
    return projectConnections.get(filePath);
  }
  const db = _loadDb(filePath);
  db.run('PRAGMA foreign_keys = ON');
  const wrapped = _wrapDb(db, filePath);
  migrateProject(wrapped);
  projectConnections.set(filePath, wrapped);
  return wrapped;
}

function closeProjectDb(filePath) {
  if (projectConnections.has(filePath)) {
    projectConnections.get(filePath).close();
    projectConnections.delete(filePath);
  }
}

function createProjectDb(name) {
  return openProjectDb(getProjectDbPath(name));
}

function getProjectDb(name) {
  const filePath = getProjectDbPath(name);
  // A freshly created sql.js database is cached immediately but reaches disk
  // on its scheduled flush. That live connection is the intentional project
  // instance and must remain usable during this short window.
  if (projectConnections.has(filePath)) {
    const projectDb = projectConnections.get(filePath);
    const context = projectInstanceContext.getStore();
    if (context?.name === name) validateProjectInstance(projectDb, name, context.expectedInstanceId);
    return projectDb;
  }
  if (!fs.existsSync(filePath)) {
    // Ordinary reads and writes must never create a database as a side effect.
    // A delayed request after project deletion would otherwise resurrect a
    // blank file (or later target a same-name replacement).
    const error = new Error(`项目"${name}"不存在`);
    error.code = 'PROJECT_NOT_FOUND';
    error.status = 404;
    error.recoverable = true;
    throw error;
  }
  const projectDb = openProjectDb(filePath);
  const context = projectInstanceContext.getStore();
  if (context?.name === name) validateProjectInstance(projectDb, name, context.expectedInstanceId);
  return projectDb;
}

function assertProjectInstance(name, expectedInstanceId) {
  const projectDb = getProjectDb(name);
  validateProjectInstance(projectDb, name, expectedInstanceId);
  return projectDb;
}

// Capture the immutable incarnation at the start of a long-running request.
// Headerless legacy clients still receive the same protection: subsequent DB
// access runs under this captured token and cannot target a same-name project
// created after the request began.
function captureProjectInstance(name, expectedInstanceId = '') {
  const projectDb = getProjectDb(name);
  const actualInstanceId = readProjectInstanceId(projectDb);
  if (!actualInstanceId || (expectedInstanceId && actualInstanceId !== expectedInstanceId)) {
    throw projectInstanceMismatchError(name);
  }
  return actualInstanceId;
}

// ═══════════════════════════════════════════════════════════════
// Project DB migrations
// ═══════════════════════════════════════════════════════════════

const projectMigrations = [
  // v0 → v1: initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS volumes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_order INTEGER NOT NULL,
        title     TEXT NOT NULL,
        summary   TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chapters (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        volume_id   INTEGER REFERENCES volumes(id) ON DELETE CASCADE,
        num         INTEGER NOT NULL,
        title       TEXT NOT NULL,
        outline     TEXT DEFAULT '',
        content     TEXT DEFAULT '',
        summary     TEXT DEFAULT '',
        word_count  INTEGER DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','writing','review','accepted')),
        cognitive_frame   TEXT DEFAULT '',
        emotional_anchor  TEXT DEFAULT '',
        world_texture     TEXT DEFAULT '',
        concrete_mystery  TEXT DEFAULT '',
        interpersonal_tension TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(volume_id, num)
      );
      CREATE TABLE IF NOT EXISTS characters (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        age         TEXT DEFAULT '',
        gender      TEXT DEFAULT '',
        role        TEXT NOT NULL DEFAULT 'minor' CHECK (role IN ('major','minor','extra')),
        appearance  TEXT DEFAULT '',
        personality TEXT DEFAULT '',
        background  TEXT DEFAULT '',
        motivation  TEXT DEFAULT '',
        arc         TEXT DEFAULT '',
        ext_markers TEXT DEFAULT '',
        avatar      TEXT DEFAULT '',
        notes       TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chapter_characters (
        chapter_id  INTEGER REFERENCES chapters(id) ON DELETE CASCADE,
        character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        role        TEXT DEFAULT 'appears' CHECK (role IN ('appears','speaks','pov','mentioned')),
        PRIMARY KEY (chapter_id, character_id)
      );
      CREATE TABLE IF NOT EXISTS world_entries (
        id          TEXT PRIMARY KEY,
        category    TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags        TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS project_genres (
        genre TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS sidebar_items (
        id          TEXT PRIMARY KEY,
        label_key   TEXT NOT NULL,
        icon        TEXT NOT NULL,
        category    TEXT NOT NULL CHECK (category IN ('universal','genre','optional')),
        genres      TEXT DEFAULT '',
        sort_order  INTEGER NOT NULL,
        route       TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1
      );
      -- Seed default sidebar items
      INSERT OR IGNORE INTO sidebar_items (id, label_key, icon, category, genres, sort_order, route, enabled) VALUES
        ('dashboard',    'sidebar.dashboard',    'LayoutDashboard', 'universal', '',  1,  'page-dashboard',    1),
        ('characters',   'sidebar.characters',   'Users',           'universal', '',  2,  'page-characters',   1),
        ('world',        'sidebar.world',        'Globe',           'universal', '',  3,  'page-world',        1),
        ('science',      'sidebar.science',      'FlaskConical',    'genre', 'sci-fi',  4,  'page-science',      1),
        ('outline_page', 'sidebar.outline_page', 'ScrollText',      'universal', '',  5,  'page-outline',      1),
        ('foreshadow',   'sidebar.foreshadow',   'Link2',           'universal', '',  6,  'page-foreshadow',   1),
        ('memory',       'sidebar.memory',       'Brain',           'universal', '',  7,  'page-memory',       1),
        ('relations',    'sidebar.relations',    'HeartHandshake',  'universal', '',  8,  'page-relations',    1),
        ('timeline',     'sidebar.timeline',     'CalendarDays',    'universal', '',  9,  'page-timeline',     1),
        ('consistency',  'sidebar.consistency',  'ShieldCheck',     'universal', '',  10, 'page-consistency',  1),
        ('export',       'sidebar.export',       'Download',        'universal', '',  11, 'page-export',       1);
      CREATE TABLE IF NOT EXISTS foreshadows (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'planted' CHECK (status IN ('planted','progressing','resolved','abandoned')),
        planted_chapter_id    INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        expected_resolve_chapter INTEGER,
        resolved_chapter_id   INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        priority        TEXT DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        category    TEXT NOT NULL CHECK (category IN ('character','location','item','event','promise','other')),
        content     TEXT NOT NULL,
        source_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS character_relations (
        id              TEXT PRIMARY KEY,
        character_a_id  TEXT REFERENCES characters(id) ON DELETE CASCADE,
        character_b_id  TEXT REFERENCES characters(id) ON DELETE CASCADE,
        relation_type   TEXT NOT NULL,
        description     TEXT DEFAULT '',
        intensity       INTEGER DEFAULT 3,
        started_at      TEXT DEFAULT '',
        ended_at        TEXT DEFAULT '',
        layout_x        REAL,
        layout_y        REAL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS science_entries (
        id          TEXT PRIMARY KEY,
        label       TEXT NOT NULL CHECK (label IN ('known','extrapolation','hypothesis')),
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        "references"  TEXT DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS timeline_events (
        id          TEXT PRIMARY KEY,
        year        TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT DEFAULT '',
        importance  INTEGER DEFAULT 3,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS clue_board (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        description     TEXT DEFAULT '',
        kind            TEXT DEFAULT '' CHECK (kind IN ('clue','red-herring','deduction','question')),
        related_chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL,
        resolved        INTEGER NOT NULL DEFAULT 0,
        resolved_at     TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS token_usage (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name       TEXT NOT NULL,
        chapter_num     INTEGER,
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0,
        context_tokens  INTEGER,
        model           TEXT DEFAULT '',
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id          TEXT PRIMARY KEY,
        title       TEXT NOT NULL DEFAULT '新对话',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chat_messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL CHECK (role IN ('user', 'ai', 'system')),
        content     TEXT NOT NULL,
        tool_calls  TEXT DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_chapters_status ON chapters(status);
      CREATE INDEX IF NOT EXISTS idx_chapters_volume ON chapters(volume_id, num);
      CREATE INDEX IF NOT EXISTS idx_chapters_order ON chapters(num);
      CREATE INDEX IF NOT EXISTS idx_characters_name ON characters(name);
      CREATE INDEX IF NOT EXISTS idx_foreshadows_status ON foreshadows(status);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    `);
  },
  // v1 → v2: add session_id column to chat_messages (legacy DBs) + index
  (db) => {
    try {
      db.exec("ALTER TABLE chat_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT '' REFERENCES chat_sessions(id) ON DELETE CASCADE");
    } catch (e) {
      // column already exists — ignore
    }
    try {
      db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)");
    } catch (e) {
      console.warn("[DB] Migration v1→v2 (index) skipped:", e.message)
    }
  },
  // v2 → v3: persist each character's narrative role
  (db) => {
    let addedRoleColumn = false;
    try {
      db.exec("ALTER TABLE characters ADD COLUMN role TEXT NOT NULL DEFAULT 'minor' CHECK (role IN ('major','minor','extra'))");
      addedRoleColumn = true;
    } catch (e) {
      // A manually-upgraded database may already have the column. Keep its data.
      if (!/duplicate column name: role/i.test(String(e.message))) throw e;
    }

    if (!addedRoleColumn) return;

    // Preserve the previous UI's visible grouping for existing projects:
    // the first name was shown as protagonist, the next two as supporting,
    // and all remaining characters as extras.
    const characters = db.prepare('SELECT id FROM characters ORDER BY name').all();
    const updateRole = db.prepare('UPDATE characters SET role = ? WHERE id = ?');
    characters.forEach(({ id }, index) => {
      const role = index === 0 ? 'major' : index < 3 ? 'minor' : 'extra';
      updateRole.run(role, id);
    });
  },
  // v3 → v4: persist the user-controlled timeline event order
  (db) => {
    let addedSortOrderColumn = false;
    try {
      db.exec('ALTER TABLE timeline_events ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
      addedSortOrderColumn = true;
    } catch (e) {
      // A manually-upgraded database may already have the column. Keep its order.
      if (!/duplicate column name: sort_order/i.test(String(e.message))) throw e;
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_timeline_events_sort_order ON timeline_events(sort_order, id)');
    if (!addedSortOrderColumn) return;

    // Give existing projects a stable chronological baseline. Later migrations
    // decide whether it remains automatic or has been manually overridden.
    const events = db.prepare('SELECT id, year, title FROM timeline_events').all().sort(compareTimelineEvents);
    const updateSortOrder = db.prepare('UPDATE timeline_events SET sort_order = ? WHERE id = ?');
    db.transaction(() => {
      events.forEach(({ id }, index) => updateSortOrder.run(index + 1, id));
    })();
  },
  // v4 → v5: distinguish automatic date sorting from an author-set order
  (db) => {
    const existingMode = db.prepare("SELECT value FROM project_meta WHERE key = 'timeline_sort_mode'").get();
    if (existingMode) return;

    const currentOrder = db.prepare(
      'SELECT id, year, title FROM timeline_events ORDER BY sort_order ASC, created_at ASC, id ASC',
    ).all();
    const automaticOrder = [...currentOrder].sort(compareTimelineEvents);
    const mode = currentOrder.every((event, index) => event.id === automaticOrder[index]?.id) ? 'auto' : 'manual';
    db.prepare("INSERT INTO project_meta (key, value) VALUES ('timeline_sort_mode', ?)").run(mode);
  },
  // v5 → v6: keep AI polish proposals separate from confirmed chapter content
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chapter_revisions (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        chapter_id       INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        base_content     TEXT NOT NULL,
        proposed_content TEXT NOT NULL,
        decisions_json   TEXT NOT NULL DEFAULT '{}',
        status           TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'accepted', 'rejected', 'superseded')),
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_chapter_revisions_active
        ON chapter_revisions(chapter_id, status, id DESC);
    `);
  },
  // v6 → v7: remember the chapter state that a pending polish temporarily replaced
  (db) => {
    try {
      db.exec(`ALTER TABLE chapter_revisions ADD COLUMN previous_chapter_status TEXT
        CHECK (previous_chapter_status IN ('pending', 'writing', 'review', 'accepted'))`);
    } catch (error) {
      if (!/duplicate column name: previous_chapter_status/i.test(String(error.message))) throw error;
    }

    const chapterColumns = new Set(
      db.prepare('PRAGMA table_info(chapters)').all().map((column) => column.name),
    );
    const canReadChapterStatus = chapterColumns.has('status');
    const pendingRevisions = db
      .prepare("SELECT id, chapter_id, base_content FROM chapter_revisions WHERE status = 'pending' AND previous_chapter_status IS NULL")
      .all();

    db.transaction(() => {
      for (const revision of pendingRevisions) {
        const currentStatus = canReadChapterStatus
          ? db.prepare('SELECT status FROM chapters WHERE id = ?').get(revision.chapter_id)?.status
          : null;
        // v6 did not retain the original value. Preserve a non-review status
        // when one is available; otherwise use a conservative editable state.
        const previousStatus = currentStatus && currentStatus !== 'review'
          ? currentStatus
          : String(revision.base_content || '').trim() ? 'writing' : 'pending';
        db.prepare('UPDATE chapter_revisions SET previous_chapter_status = ? WHERE id = ?')
          .run(previousStatus, revision.id);
      }
    })();
  },
  // v7 → v8: assign every chapter update a database-ordered revision.
  // Client request/response arrival order is not a safe proxy for commit order:
  // a delayed response from an older write can arrive after a newer window has
  // already committed. The trigger keeps the revision correct for every writer
  // (REST, AI tools, continuation, and revision resolution) without requiring
  // each call site to remember to increment it.
  (db) => {
    const chapterColumns = new Set(
      db.prepare('PRAGMA table_info(chapters)').all().map((column) => column.name),
    );
    // Some legacy/imported databases contain only a subset of project tables.
    // Keep their migration path valid when there is no chapter data to version.
    if (chapterColumns.size === 0) return;
    if (!chapterColumns.has('data_version')) {
      db.exec('ALTER TABLE chapters ADD COLUMN data_version INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS chapters_data_version_after_update
      AFTER UPDATE ON chapters
      FOR EACH ROW
      WHEN NEW.data_version = OLD.data_version
      BEGIN
        UPDATE chapters SET data_version = OLD.data_version + 1 WHERE id = OLD.id;
      END;
    `);
  },
  // v8 → v9: assign an immutable project incarnation. A project name may be
  // reused after deletion; clients and long-running AI requests use this token
  // to prove that a mutation still targets the instance they loaded.
  (db) => {
    const existing = db.prepare("SELECT value FROM project_meta WHERE key = 'project_instance_id'").get();
    if (!existing?.value) {
      db.prepare("INSERT OR REPLACE INTO project_meta (key, value) VALUES ('project_instance_id', ?)")
        .run(randomUUID());
    }
  },
  // v9 → v10: legacy/imported chapters could contain SQL NULL despite the
  // schema default. Revisions use an empty string as the canonical blank text,
  // so normalize persisted data before optimistic compare-and-swap operations.
  (db) => {
    const chapterColumns = new Set(
      db.prepare('PRAGMA table_info(chapters)').all().map((column) => column.name),
    );
    if (chapterColumns.has('content')) {
      db.prepare("UPDATE chapters SET content = '' WHERE content IS NULL").run();
    }
  },
];

const getProjectVersion = makeVersionGetter('project_meta');
const setProjectVersion = makeVersionSetter('project_meta');

function migrateProject(db) {
  runMigrations(db, projectMigrations, PROJECT_SCHEMA_VERSION, getProjectVersion, setProjectVersion);
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// Config DB query wrappers
// ═══════════════════════════════════════════════════════════════

function dbQuery(sql, params = []) {
  const db = getConfigDb();
  return db.prepare(sql).all(...params);
}

function dbGet(sql, params = []) {
  const db = getConfigDb();
  return db.prepare(sql).get(...params) || null;
}

function dbExecute(sql, params = []) {
  const db = getConfigDb();
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

// ═══════════════════════════════════════════════════════════════
// Project-specific query wrappers
// ═══════════════════════════════════════════════════════════════

function projectQuery(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  return db.prepare(sql).all(...params);
}

function projectGet(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  return db.prepare(sql).get(...params) || null;
}

function projectExecute(projectName, sql, params = []) {
  const db = getProjectDb(projectName);
  const result = db.prepare(sql).run(...params);
  return result.changes;
}

function projectTransaction(projectName, fn) {
  const db = getProjectDb(projectName);
  return db.transaction(fn)();
}

// ═══════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════

function updateProjectWordCount(projectDb, updatedAt = new Date().toISOString()) {
  const total = projectDb.prepare('SELECT SUM(word_count) as total FROM chapters').get()?.total || 0;
  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('word_count', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(total));
  projectDb
    .prepare("INSERT INTO project_meta (key, value) VALUES ('updated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(updatedAt);
  return total;
}

function recalculateWordCount(projectName) {
  const projectDb = getProjectDb(projectName);
  return projectDb.transaction(() => updateProjectWordCount(projectDb))();
}

function flushAllDatabases() {
  configDb?.flush();
  for (const projectDb of projectConnections.values()) projectDb.flush();
}

function getCoverDir(projectName) {
  return path.join(PROJECTS_DIR, projectName);
}

function findCoverPath(projectName) {
  const coverDir = getCoverDir(projectName);
  const exts = ['png', 'jpg', 'webp', 'gif'];
  for (const ext of exts) {
    const p = path.join(coverDir, `cover.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const MIME_TO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

module.exports = {
  initDatabase,
  getConfigDb,
  createProjectDb,
  getProjectDb,
  getProjectDbPath,
  openProjectDb,
  closeProjectDb,
  assertProjectInstance,
  captureProjectInstance,
  runWithProjectInstance,
  dbQuery,
  dbGet,
  dbExecute,
  projectQuery,
  projectGet,
  projectExecute,
  projectTransaction,
  recalculateWordCount,
  updateProjectWordCount,
  flushAllDatabases,
  getDataDir: () => DB_DIR,
  getExportDir: () => EXPORT_DIR,
  getCoverDir,
  findCoverPath,
  MIME_TO_EXT,
  EXT_TO_MIME,
};
