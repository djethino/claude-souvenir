import { createRequire as __souvenirCreateRequire } from 'module';
const require = __souvenirCreateRequire(import.meta.url);

// src/background-index.ts
import { readFileSync as readFileSync5, writeFileSync, writeSync, mkdirSync as mkdirSync2, unlinkSync, openSync as openSync2, closeSync as closeSync2 } from "fs";
import { join as join6 } from "path";

// src/utils/paths.ts
import { homedir } from "os";
import { join } from "path";

// src/options.ts
import { isAbsolute } from "path";
var PROVIDERS = ["ollama", "openai"];
function option(key) {
  const value = process.env[`CLAUDE_PLUGIN_OPTION_${key}`]?.trim();
  return value ? value : void 0;
}
function readPluginOptions() {
  const provider = option("EMBEDDING_PROVIDER") ?? "ollama";
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Invalid embedding_provider "${provider}": use ${PROVIDERS.join(" or ")}`);
  }
  const dimensionsText = option("EMBEDDING_DIMENSIONS");
  let embeddingDimensions;
  if (dimensionsText !== void 0) {
    embeddingDimensions = Number(dimensionsText);
    if (!Number.isInteger(embeddingDimensions) || embeddingDimensions <= 0) {
      throw new Error(`Invalid embedding_dimensions "${dimensionsText}": expected a positive integer`);
    }
  }
  const dbPath = option("DB_PATH");
  if (dbPath !== void 0 && !isAbsolute(dbPath)) {
    throw new Error(`Invalid db_path "${dbPath}": it must be an absolute path`);
  }
  return {
    embeddingProvider: provider,
    embeddingUrl: option("EMBEDDING_URL"),
    embeddingModel: option("EMBEDDING_MODEL"),
    embeddingDimensions,
    embeddingApiKey: option("EMBEDDING_API_KEY"),
    dbPath
  };
}

// src/utils/paths.ts
function getClaudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
function getProjectsDir() {
  return join(getClaudeDir(), "projects");
}
function getSouvenirDir() {
  return join(getClaudeDir(), "ASymptOmatik", "souvenir");
}
function getDbPath() {
  return readPluginOptions().dbPath ?? join(getSouvenirDir(), "souvenir.db");
}
function cwdToProjectDir(cwd) {
  return cwd.replace(/[\\/]+$/, "").replace(/[^a-zA-Z0-9]/g, "-");
}
function isProjectPath(path, projectDir) {
  return cwdToProjectDir(path).toLowerCase() === projectDir.toLowerCase();
}
function getProjectTranscriptDir(projectDir) {
  return join(getProjectsDir(), projectDir);
}

// src/config.ts
import { existsSync } from "fs";
import { join as join2 } from "path";

// src/utils/logger.ts
var LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var currentLevel = process.env.SOUVENIR_LOG_LEVEL || "warn";
function shouldLog(level) {
  return LEVELS[level] >= LEVELS[currentLevel];
}
function formatMessage(level, ...args) {
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
  const prefix = `[souvenir${timestamp} ${level.toUpperCase()}]`;
  const message = args.map((a) => typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)).join(" ");
  return `${prefix} ${message}`;
}
var logger = {
  debug(...args) {
    if (shouldLog("debug")) console.error(formatMessage("debug", ...args));
  },
  info(...args) {
    if (shouldLog("info")) console.error(formatMessage("info", ...args));
  },
  warn(...args) {
    if (shouldLog("warn")) console.error(formatMessage("warn", ...args));
  },
  error(...args) {
    if (shouldLog("error")) console.error(formatMessage("error", ...args));
  },
  setLevel(level) {
    currentLevel = level;
  }
};

// src/config.ts
var PROVIDER_DEFAULTS = {
  ollama: { url: "http://localhost:11434", model: "embeddinggemma" },
  openai: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" }
};
var _config = null;
function resolvePathToProject(path) {
  const projectDir = cwdToProjectDir(path);
  const projectPath = join2(getProjectsDir(), projectDir);
  if (existsSync(projectPath)) {
    return projectDir;
  }
  return null;
}
function getConfig() {
  if (_config) return _config;
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  const cwd = fromEnv || process.cwd();
  const options = readPluginOptions();
  const defaults = PROVIDER_DEFAULTS[options.embeddingProvider];
  const detectedProject = resolvePathToProject(cwd);
  const source = fromEnv ? "CLAUDE_PROJECT_DIR" : "working directory (CLAUDE_PROJECT_DIR not set)";
  if (detectedProject) {
    logger.info(`Current project from ${source}: ${detectedProject}`);
  } else {
    logger.info(`${source} "${cwd}" has no Claude Code history: no current project.`);
  }
  _config = {
    cwd,
    currentProject: detectedProject,
    embedding: {
      provider: options.embeddingProvider,
      url: (options.embeddingUrl ?? defaults.url).replace(/\/+$/, ""),
      model: options.embeddingModel ?? defaults.model,
      dimensions: options.embeddingDimensions,
      apiKey: options.embeddingApiKey
    }
  };
  return _config;
}

// src/embedding/models.ts
var REPRESENT_QUERY = "Represent this sentence for searching relevant passages: ";
var RETRIEVAL_TASK = "Given a web search query, retrieve relevant passages that answer the query";
var KNOWN_MODELS = [
  // google/embeddinggemma-2 and google/embeddinggemma-300m
  { match: "embeddinggemma", documentPrefix: "title: none | text: ", queryPrefix: "task: search result | query: " },
  // nomic-ai/nomic-embed-text-v1.5 and -v2-moe
  { match: "nomic-embed-text", documentPrefix: "search_document: ", queryPrefix: "search_query: " },
  // Snowflake/snowflake-arctic-embed-l-v2.0 (Ollama: snowflake-arctic-embed2)
  { match: "snowflake-arctic-embed2", documentPrefix: "", queryPrefix: "query: " },
  { match: "snowflake-arctic-embed-l-v2", documentPrefix: "", queryPrefix: "query: " },
  { match: "snowflake-arctic-embed-m-v2", documentPrefix: "", queryPrefix: "query: " },
  // Snowflake/snowflake-arctic-embed (v1), mixedbread-ai/mxbai-embed-large-v1, BAAI/bge-large-en-v1.5
  { match: "snowflake-arctic-embed", documentPrefix: "", queryPrefix: REPRESENT_QUERY },
  { match: "mxbai-embed-large", documentPrefix: "", queryPrefix: REPRESENT_QUERY },
  { match: "bge-large", documentPrefix: "", queryPrefix: REPRESENT_QUERY },
  // intfloat/multilingual-e5-large-instruct (space after "Query:")
  { match: "e5-large-instruct", documentPrefix: "", queryPrefix: `Instruct: ${RETRIEVAL_TASK}
Query: ` },
  // intfloat/multilingual-e5-* and e5-*-v2
  { match: "multilingual-e5", documentPrefix: "passage: ", queryPrefix: "query: " },
  { match: "e5-small", documentPrefix: "passage: ", queryPrefix: "query: " },
  { match: "e5-base", documentPrefix: "passage: ", queryPrefix: "query: " },
  { match: "e5-large", documentPrefix: "passage: ", queryPrefix: "query: " },
  // Qwen/Qwen3-Embedding-* (official template: no space after "Query:")
  { match: "qwen3-embedding", documentPrefix: "", queryPrefix: `Instruct: ${RETRIEVAL_TASK}
Query:` },
  // No prefixes
  { match: "bge-m3", documentPrefix: "", queryPrefix: "" },
  { match: "all-minilm", documentPrefix: "", queryPrefix: "" },
  { match: "granite-embedding", documentPrefix: "", queryPrefix: "" },
  { match: "paraphrase-multilingual", documentPrefix: "", queryPrefix: "" },
  { match: "text-embedding-3", documentPrefix: "", queryPrefix: "" }
];
function normalizeModelName(model) {
  const withoutTag = model.trim().toLowerCase().replace(/:[^/]*$/, "");
  return withoutTag.slice(withoutTag.lastIndexOf("/") + 1);
}
function findModelPrompts(model) {
  const name = normalizeModelName(model);
  return KNOWN_MODELS.find((m) => name.includes(m.match)) ?? null;
}

// src/embedding/provider.ts
function sameIdentity(a, b) {
  return a.provider === b.provider && a.model === b.model && a.dimensions === b.dimensions && a.documentPrefix === b.documentPrefix && a.queryPrefix === b.queryPrefix;
}
function describeIdentity(identity) {
  return `${identity.provider} (${identity.model}, ${identity.dimensions} dimensions)`;
}
var BaseEmbeddingProvider = class {
  constructor(settings, maxBatchSize) {
    this.settings = settings;
    this.maxBatchSize = maxBatchSize;
    this.name = `${settings.provider} (${settings.model})`;
    const prompts = findModelPrompts(settings.model);
    if (!prompts) {
      logger.warn(`No known input prefixes for model "${settings.model}": texts are embedded as is`);
    }
    this.documentPrefix = prompts?.documentPrefix ?? "";
    this.queryPrefix = prompts?.queryPrefix ?? "";
  }
  settings;
  maxBatchSize;
  name;
  ready = false;
  _identity = null;
  documentPrefix;
  queryPrefix;
  get identity() {
    if (!this._identity) {
      throw new Error(`Embedding provider ${this.name} is not initialized`);
    }
    return this._identity;
  }
  isReady() {
    return this.ready;
  }
  async initialize() {
    if (this.ready) return;
    await this.prepare();
    const [probe] = await this.request([this.queryPrefix + "dimension probe"]);
    if (this.settings.dimensions !== void 0 && probe.length !== this.settings.dimensions) {
      throw new Error(
        `${this.name} returned ${probe.length}-dimension vectors although embedding_dimensions is ${this.settings.dimensions}: this model or server does not support shortened vectors. Clear the embedding_dimensions option to use the native size.`
      );
    }
    this._identity = {
      provider: this.settings.provider,
      model: this.settings.model,
      dimensions: probe.length,
      documentPrefix: this.documentPrefix,
      queryPrefix: this.queryPrefix
    };
    this.ready = true;
    logger.info(`Embedding provider ready: ${describeIdentity(this._identity)}`);
  }
  async embed(texts) {
    if (!this.ready) await this.initialize();
    const results = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize).map((t) => this.documentPrefix + t);
      results.push(...(await this.request(batch)).map((v) => new Float32Array(v)));
    }
    return results;
  }
  async embedQuery(text) {
    if (!this.ready) await this.initialize();
    const [vector] = await this.request([this.queryPrefix + text]);
    return new Float32Array(vector);
  }
  async dispose() {
    this.ready = false;
  }
};

// src/embedding/ollama.ts
var MAX_BATCH_SIZE = 64;
var REQUEST_TIMEOUT_MS = 12e4;
var OllamaEmbeddingProvider = class extends BaseEmbeddingProvider {
  constructor(settings) {
    super(settings, MAX_BATCH_SIZE);
  }
  async prepare() {
    logger.info(`Connecting to Ollama at ${this.settings.url}...`);
    const models = await this.listModels();
    if (models === null) {
      throw new Error(
        `Ollama is not running at ${this.settings.url}. Start it with "ollama serve" or install from https://ollama.com`
      );
    }
    const { model } = this.settings;
    if (!models.some((m) => m === model || m === `${model}:latest`)) {
      logger.info(`Model "${model}" not found. Pulling...`);
      await this.pullModel();
      logger.info(`Model "${model}" pulled successfully.`);
    }
  }
  /** Installed model names, or null when the server does not answer. */
  async listModels() {
    try {
      const response = await fetch(`${this.settings.url}/api/tags`, {
        signal: AbortSignal.timeout(5e3)
      });
      if (!response.ok) return null;
      const data = await response.json();
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return null;
    }
  }
  async pullModel() {
    const { model } = this.settings;
    try {
      const response = await fetch(`${this.settings.url}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model, stream: false }),
        signal: AbortSignal.timeout(6e5)
        // 10 min for pull
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Pull failed (${response.status}): ${errText}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Pull failed")) throw err;
      throw new Error(
        `Failed to pull model "${model}" from Ollama. Ensure Ollama is running and try manually: ollama pull ${model}
Error: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  async request(texts, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(`${this.settings.url}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.settings.model,
            input: texts,
            ...this.settings.dimensions !== void 0 && { dimensions: this.settings.dimensions }
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 404 && attempt === 0) {
            logger.warn(`Model "${this.settings.model}" not loaded. Attempting pull...`);
            await this.pullModel();
            continue;
          }
          throw new Error(`Ollama embed API error (${response.status}): ${errText}`);
        }
        const data = await response.json();
        if (!data.embeddings || data.embeddings.length !== texts.length) {
          throw new Error(
            `Unexpected Ollama response: expected ${texts.length} embeddings, got ${data.embeddings?.length ?? 0}`
          );
        }
        return data.embeddings;
      } catch (err) {
        if (attempt === retries - 1) throw err;
        const isRetryable = err instanceof Error && (err.message.includes("ECONNREFUSED") || err.message.includes("ECONNRESET") || err.message.includes("timeout"));
        if (!isRetryable) throw err;
        const delay = Math.pow(2, attempt) * 1e3;
        logger.warn(`Ollama request failed, retrying in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("All retries exhausted");
  }
};

// src/embedding/openai.ts
var MAX_BATCH_SIZE2 = 100;
var OpenAIEmbeddingProvider = class extends BaseEmbeddingProvider {
  constructor(settings) {
    super(settings, MAX_BATCH_SIZE2);
  }
  async prepare() {
    logger.info(`Using OpenAI-compatible embeddings at ${this.settings.url} (model ${this.settings.model})`);
  }
  async request(texts, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(`${this.settings.url}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.settings.apiKey && { Authorization: `Bearer ${this.settings.apiKey}` }
          },
          body: JSON.stringify({
            model: this.settings.model,
            input: texts,
            ...this.settings.dimensions !== void 0 && { dimensions: this.settings.dimensions }
          })
        });
        if (!response.ok) {
          const error = await response.text();
          if (response.status === 429 && attempt < retries - 1) {
            const delay = Math.pow(2, attempt) * 1e3;
            logger.warn(`Rate limited, retrying in ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          const hint = response.status === 401 || response.status === 403 ? " Check the embedding_api_key option." : "";
          throw new Error(`Embedding API error at ${this.settings.url} (${response.status}): ${error}${hint}`);
        }
        const data = await response.json();
        if (!Array.isArray(data.data) || data.data.length !== texts.length) {
          throw new Error(
            `Unexpected embedding API response: expected ${texts.length} embeddings, got ${data.data?.length ?? 0}`
          );
        }
        return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
      } catch (err) {
        if (attempt === retries - 1) throw err;
        const delay = Math.pow(2, attempt) * 1e3;
        logger.warn(`API error, retrying in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("All retries exhausted");
  }
};

// src/tools/helpers.ts
function createEmbeddingProvider(config) {
  switch (config.embedding.provider) {
    case "ollama":
      return new OllamaEmbeddingProvider(config.embedding);
    case "openai":
      return new OpenAIEmbeddingProvider(config.embedding);
  }
}

// src/utils/serial.ts
function serialized(fn) {
  let queue = Promise.resolve();
  return (...args) => {
    const run2 = queue.then(() => fn(...args));
    queue = run2.catch(() => {
    });
    return run2;
  };
}

// src/archive/store.ts
import { deflateRawSync, inflateRawSync } from "zlib";

// src/db/store.ts
import { isAbsolute as isAbsolute2, relative, sep } from "path";

// src/db/schema.ts
var SCHEMA_VERSION = 3;
var CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    project_dir TEXT NOT NULL,
    entry_uuid TEXT,
    role TEXT,
    content_text TEXT NOT NULL,
    timestamp TEXT,
    line_number INTEGER,
    part INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, line_number, part)
  );

  CREATE TABLE IF NOT EXISTS index_state (
    file_path TEXT PRIMARY KEY,
    file_size INTEGER NOT NULL,
    last_line INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transcript_files (
    file_key TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    archived_bytes INTEGER NOT NULL DEFAULT 0,
    line_count INTEGER NOT NULL DEFAULT 0,
    entry_count INTEGER NOT NULL DEFAULT 0,
    first_timestamp TEXT,
    last_timestamp TEXT,
    first_prompt TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    custom_title TEXT NOT NULL DEFAULT '',
    git_branch TEXT NOT NULL DEFAULT '',
    project_path TEXT NOT NULL DEFAULT '',
    source_gone_at TEXT,
    error TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transcript_lines (
    file_key TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (file_key, line_number)
  );

  CREATE TABLE IF NOT EXISTS transcript_attachments (
    file_key TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL,
    data BLOB NOT NULL,
    updated_at TEXT NOT NULL
  );
`;
var CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_dir);
  CREATE INDEX IF NOT EXISTS idx_chunks_role ON chunks(role);
  CREATE INDEX IF NOT EXISTS idx_chunks_timestamp ON chunks(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tfiles_session ON transcript_files(session_id);
  CREATE INDEX IF NOT EXISTS idx_tfiles_project ON transcript_files(project_dir);
  CREATE INDEX IF NOT EXISTS idx_tattach_session ON transcript_attachments(session_id);
`;
var LEGACY_VEC_TABLE = "vec_chunks";
var CHUNK_VECTORS = "chunk_vectors";
function createChunkVectorsTable(dimensions) {
  return `CREATE VIRTUAL TABLE ${CHUNK_VECTORS} USING vec0 (
    chunk_id INTEGER PRIMARY KEY,
    project_dir TEXT PARTITION KEY,
    session_id TEXT,
    role TEXT,
    has_user INTEGER,
    has_assistant INTEGER,
    timestamp TEXT,
    embedding float[${dimensions}] distance_metric=cosine
  );`;
}

// src/db/sqlite.ts
import { createRequire } from "module";
import { existsSync as existsSync2, mkdirSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
var MIN_NODE = [22, 13];
var VEC_BINARIES = {
  "win32-x64": "windows-x64/vec0.dll",
  "linux-x64": "linux-x64/vec0.so",
  "darwin-x64": "darwin-x64/vec0.dylib",
  "darwin-arm64": "darwin-arm64/vec0.dylib"
};
function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < MIN_NODE[0] || major === MIN_NODE[0] && minor < MIN_NODE[1]) {
    throw new Error(
      `souvenir requires Node.js >= ${MIN_NODE.join(".")} (built-in node:sqlite), found ${process.versions.node}`
    );
  }
}
function sqliteVecPath() {
  const platform = `${process.platform}-${process.arch}`;
  const relative4 = VEC_BINARIES[platform];
  if (!relative4) {
    throw new Error(
      `souvenir: no sqlite-vec binary for ${platform} (supported: ${Object.keys(VEC_BINARIES).join(", ")})`
    );
  }
  const path = fileURLToPath(new URL(`../vendor/sqlite-vec/bin/${relative4}`, import.meta.url));
  if (!existsSync2(path)) {
    throw new Error(`souvenir: sqlite-vec binary missing at ${path}`);
  }
  return path;
}
function openDatabase(dbPath, label) {
  assertNodeVersion();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const dir = dirname(dbPath);
  if (!existsSync2(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  logger.info(`Opening ${label} database at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.loadExtension(sqliteVecPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_size_limit = 67108864");
  const { auto_vacuum: autoVacuum } = db.prepare("PRAGMA auto_vacuum").get();
  if (autoVacuum !== 2) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec("VACUUM");
    logger.info(`${label} database: enabled incremental auto_vacuum (one-time migration)`);
  }
  return db;
}
function inTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
function getRow(db, sql, ...params) {
  return db.prepare(sql).get(...params) ?? null;
}
function allRows(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}
var statementsInUse = /* @__PURE__ */ new Set();
function* iterateRows(db, sql, ...params) {
  const statement = db.prepare(sql);
  statementsInUse.add(statement);
  try {
    for (const row of statement.iterate(...params)) yield row;
  } finally {
    statementsInUse.delete(statement);
  }
}
function vectorBlob(vector) {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

// src/db/identity.ts
var IDENTITY_KEY = "embedding_identity";
var LEGACY_PREFIXES = {
  ollama: { documentPrefix: "title: none | text: ", queryPrefix: "task: search result | query: " },
  openai: { documentPrefix: "", queryPrefix: "" }
};
var IndexMismatchError = class extends Error {
};
function getStoredIdentity(db) {
  const row = getRow(db, "SELECT value FROM metadata WHERE key = ?", IDENTITY_KEY);
  return row ? JSON.parse(row.value) : null;
}
function setStoredIdentity(db, identity) {
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(IDENTITY_KEY, JSON.stringify(identity));
}
function migrateLegacyIdentity(db) {
  if (!getStoredIdentity(db)) {
    const name = getRow(db, "SELECT value FROM metadata WHERE key = ?", "embedding_provider")?.value;
    const dims = getRow(db, "SELECT value FROM metadata WHERE key = ?", "embedding_dimensions")?.value;
    const match = name?.match(/^(ollama|openai) \((.+)\)$/);
    if (match && dims) {
      const provider = match[1];
      setStoredIdentity(db, { provider, model: match[2], dimensions: Number(dims), ...LEGACY_PREFIXES[provider] });
    }
  }
  db.prepare("DELETE FROM metadata WHERE key IN ('embedding_provider', 'embedding_dimensions')").run();
}
function assertSameIdentity(stored, current, label, rebuildHint) {
  if (!stored || sameIdentity(stored, current)) return;
  throw new IndexMismatchError(
    `The ${label} index was built with ${describeIdentity(stored)}, but the current embedding settings give ${describeIdentity(current)}. Vectors from different models cannot be compared. Either restore the previous embedding settings (/plugin configure asymptomatik-souvenir), or ${rebuildHint}.`
  );
}
function tableExists(db, table) {
  return getRow(db, "SELECT 1 AS found FROM sqlite_master WHERE name = ? AND type = 'table'", table) !== null;
}
function deleteOrphanVectors(db, vectorTable, chunkTable) {
  const ids = db.prepare(`SELECT chunk_id FROM ${vectorTable}`).all();
  const chunkExists = db.prepare(`SELECT 1 FROM ${chunkTable} WHERE chunk_id = ?`);
  const remove = db.prepare(`DELETE FROM ${vectorTable} WHERE chunk_id = ?`);
  let removed = 0;
  for (const { chunk_id } of ids) {
    if (!chunkExists.get(chunk_id)) {
      remove.run(BigInt(chunk_id));
      removed++;
    }
  }
  return removed;
}
function vectorTableDimensions(db, table) {
  const sql = getRow(db, "SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'", table)?.sql;
  const match = sql?.match(/float\[(\d+)\]/i);
  if (!match) {
    throw new Error(`Cannot read the vector size of table ${table}`);
  }
  return Number(match[1]);
}

// src/db/store.ts
var _db = null;
var REBUILD_HINT = 'rebuild it with souvenir_index action="rebuild" project="all" (re-embeds every indexed chunk)';
var PENDING_VECTORS_KEY = "pending_vectors:";
function getDb() {
  if (_db) return _db;
  const db = openDatabase(getDbPath(), "transcripts");
  try {
    db.exec(CREATE_TABLES);
    migrateLegacyIdentity(db);
    migrateLegacyVectors(db);
    migrateChunksTable(db);
    migrateIndexStateKeys(db);
    db.exec(CREATE_INDEXES);
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(SCHEMA_VERSION)
    );
  } catch (err) {
    db.close();
    throw err;
  }
  _db = db;
  logger.info("Database initialized");
  return db;
}
function legacyChunkSpeakers(role, contentText) {
  if (role === "turn") return { hasUser: 1n, hasAssistant: contentText.includes("\nASSISTANT: ") ? 1n : 0n };
  if (role === "assistant") return { hasUser: 0n, hasAssistant: 1n };
  return { hasUser: 0n, hasAssistant: 0n };
}
function migrateLegacyVectors(db) {
  if (!tableExists(db, LEGACY_VEC_TABLE)) return;
  const legacyDims = vectorTableDimensions(db, LEGACY_VEC_TABLE);
  const currentDims = tableExists(db, CHUNK_VECTORS) ? vectorTableDimensions(db, CHUNK_VECTORS) : null;
  const started = Date.now();
  let moved = 0;
  inTransaction(db, () => {
    if (currentDims !== null && currentDims !== legacyDims) {
      logger.warn(`Dropping ${LEGACY_VEC_TABLE} (${legacyDims}d): incompatible with ${CHUNK_VECTORS} (${currentDims}d)`);
    } else {
      if (currentDims === null) db.exec(createChunkVectorsTable(legacyDims));
      const page = db.prepare("SELECT chunk_id, project_dir, session_id, role, timestamp, content_text FROM chunks WHERE chunk_id > ? ORDER BY chunk_id LIMIT 5000");
      const legacyVector = db.prepare(`SELECT embedding FROM ${LEGACY_VEC_TABLE} WHERE chunk_id = ?`);
      const alreadyMoved = db.prepare(`SELECT chunk_id FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`);
      const insert = db.prepare(`INSERT INTO ${CHUNK_VECTORS} (chunk_id, project_dir, session_id, role, has_user, has_assistant, timestamp, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (let last = 0; ; ) {
        const rows = page.all(last);
        if (rows.length === 0) break;
        for (const r of rows) {
          const id = BigInt(r.chunk_id);
          const vector = legacyVector.get(id);
          if (!vector || alreadyMoved.get(id)) continue;
          const { hasUser, hasAssistant } = legacyChunkSpeakers(r.role, r.content_text);
          insert.run(id, r.project_dir, r.session_id, r.role ?? "", hasUser, hasAssistant, r.timestamp ?? "", vector.embedding);
          moved++;
        }
        last = rows[rows.length - 1].chunk_id;
      }
      const orphans = deleteOrphanVectors(db, CHUNK_VECTORS, "chunks");
      if (orphans > 0) logger.info(`Deleted ${orphans} vectors of chunks that no longer exist`);
    }
    db.exec(`DROP TABLE ${LEGACY_VEC_TABLE}`);
  });
  db.exec("PRAGMA incremental_vacuum");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  logger.info(`Moved ${moved} vectors from ${LEGACY_VEC_TABLE} to ${CHUNK_VECTORS} in ${Date.now() - started} ms`);
}
function migrateChunksTable(db) {
  const columns = allRows(db, "PRAGMA table_info(chunks)").map((c) => c.name);
  if (!columns.includes("embed_text")) return;
  const started = Date.now();
  inTransaction(db, () => {
    db.exec(`
      CREATE TABLE chunks_v3 (
        chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_dir TEXT NOT NULL,
        entry_uuid TEXT,
        role TEXT,
        content_text TEXT NOT NULL,
        timestamp TEXT,
        line_number INTEGER,
        part INTEGER NOT NULL DEFAULT 0,
        UNIQUE(session_id, line_number, part)
      );
      INSERT INTO chunks_v3 (chunk_id, session_id, project_dir, entry_uuid, role, content_text, timestamp, line_number, part)
        SELECT chunk_id, session_id, project_dir, entry_uuid, role, content_text, timestamp, line_number, 0 FROM chunks;
      DROP TABLE chunks;
      ALTER TABLE chunks_v3 RENAME TO chunks;
    `);
    if (tableExists(db, CHUNK_VECTORS)) {
      const orphans = deleteOrphanVectors(db, CHUNK_VECTORS, "chunks");
      if (orphans > 0) logger.info(`Deleted ${orphans} vectors of chunks that no longer exist`);
    }
  });
  db.exec("PRAGMA incremental_vacuum");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  logger.info(`Chunks table migrated to schema 3 in ${Date.now() - started} ms`);
}
function migrateIndexStateKeys(db) {
  const rows = allRows(db, "SELECT file_path FROM index_state").filter((r) => isAbsolute2(r.file_path));
  if (rows.length === 0) return;
  const projectsDir = getProjectsDir();
  const rename = db.prepare("UPDATE OR REPLACE index_state SET file_path = ? WHERE file_path = ?");
  inTransaction(db, () => {
    for (const { file_path } of rows) {
      rename.run(relative(projectsDir, file_path).split(sep).join("/"), file_path);
    }
  });
  logger.info(`Index progress of ${rows.length} transcripts keyed by archive path`);
}
function prepareVectorIndex(identity, options = {}) {
  const db = getDb();
  const stored = getStoredIdentity(db);
  if (!options.resetAll) {
    assertSameIdentity(stored, identity, "transcript", REBUILD_HINT);
  }
  inTransaction(db, () => {
    if (options.resetAll) {
      if (tableExists(db, CHUNK_VECTORS)) db.exec(`DROP TABLE ${CHUNK_VECTORS}`);
      db.exec("DELETE FROM chunks WHERE session_id IN (SELECT session_id FROM transcript_files)");
      db.exec("DELETE FROM index_state");
      const markPending = db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)");
      for (const { project_dir } of allRows(db, "SELECT DISTINCT project_dir FROM chunks")) {
        markPending.run(PENDING_VECTORS_KEY + project_dir, (/* @__PURE__ */ new Date()).toISOString());
      }
    }
    if (!tableExists(db, CHUNK_VECTORS)) db.exec(createChunkVectorsTable(identity.dimensions));
    setStoredIdentity(db, identity);
  });
}
function getIndexIdentity() {
  return getStoredIdentity(getDb());
}
function insertChunks(chunks, embeddings) {
  const db = getDb();
  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk count (${chunks.length}) doesn't match embedding count (${embeddings.length})`);
  }
  const insertChunk = db.prepare(`
    INSERT OR IGNORE INTO chunks (session_id, project_dir, entry_uuid, role, content_text, timestamp, line_number, part)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  inTransaction(db, () => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = insertChunk.run(
        chunk.session_id,
        chunk.project_dir,
        chunk.entry_uuid || null,
        chunk.role,
        chunk.content_text,
        chunk.timestamp || null,
        chunk.line_number,
        chunk.part
      );
      if (result.changes > 0) {
        insertVector(db, BigInt(result.lastInsertRowid), chunk, chunk.hasUser, chunk.hasAssistant, embeddings[i]);
        inserted++;
      }
    }
  });
  return inserted;
}
function insertVector(db, chunkId, chunk, hasUser, hasAssistant, embedding) {
  db.prepare(`
    INSERT INTO ${CHUNK_VECTORS} (chunk_id, project_dir, session_id, role, has_user, has_assistant, timestamp, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunkId,
    chunk.project_dir,
    chunk.session_id,
    chunk.role ?? "",
    hasUser ? 1n : 0n,
    hasAssistant ? 1n : 0n,
    chunk.timestamp ?? "",
    vectorBlob(embedding)
  );
}
function hasPendingVectors(projectDir) {
  return getRow(getDb(), "SELECT 1 AS pending FROM metadata WHERE key = ?", PENDING_VECTORS_KEY + projectDir) !== null;
}
function getChunksWithoutVectors(projectDir, afterChunkId, limit) {
  const db = getDb();
  const page = allRows(db, "SELECT * FROM chunks WHERE project_dir = ? AND chunk_id > ? ORDER BY chunk_id LIMIT ?", projectDir, afterChunkId, limit);
  if (page.length === 0) return { missing: [], lastChunkId: null };
  const hasVector = db.prepare(`SELECT 1 FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`);
  return { missing: page.filter((c) => !hasVector.get(BigInt(c.chunk_id))), lastChunkId: page[page.length - 1].chunk_id };
}
function insertVectors(chunks, embeddings) {
  const db = getDb();
  inTransaction(db, () => {
    chunks.forEach((c, i) => {
      const { hasUser, hasAssistant } = legacyChunkSpeakers(c.role, c.content_text);
      insertVector(db, BigInt(c.chunk_id), c, hasUser === 1n, hasAssistant === 1n, embeddings[i]);
    });
  });
}
function clearPendingVectors(projectDir) {
  getDb().prepare("DELETE FROM metadata WHERE key = ?").run(PENDING_VECTORS_KEY + projectDir);
}
function getIndexState(fileKey) {
  const db = getDb();
  return getRow(db, "SELECT * FROM index_state WHERE file_path = ?", fileKey);
}
function setIndexState(fileKey, archivedBytes, lastLine) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO index_state (file_path, file_size, last_line, indexed_at)
    VALUES (?, ?, ?, ?)
  `).run(fileKey, archivedBytes, lastLine, (/* @__PURE__ */ new Date()).toISOString());
}
function clearArchivedChunks(projectDir, sessionId) {
  const db = getDb();
  const sessionFilter = sessionId ? "AND session_id = ?" : "";
  const params = sessionId ? [projectDir, projectDir, sessionId] : [projectDir, projectDir];
  inTransaction(db, () => {
    const chunkIds = allRows(db, `
      SELECT chunk_id FROM chunks
      WHERE project_dir = ? AND session_id IN (SELECT session_id FROM transcript_files WHERE project_dir = ?) ${sessionFilter}`, ...params);
    if (tableExists(db, CHUNK_VECTORS)) {
      const deleteVector = db.prepare(`DELETE FROM ${CHUNK_VECTORS} WHERE chunk_id = ?`);
      for (const { chunk_id } of chunkIds) deleteVector.run(BigInt(chunk_id));
    }
    const deleteChunk = db.prepare("DELETE FROM chunks WHERE chunk_id = ?");
    for (const { chunk_id } of chunkIds) deleteChunk.run(chunk_id);
    if (sessionId) {
      db.prepare("DELETE FROM index_state WHERE file_path IN (SELECT file_key FROM transcript_files WHERE project_dir = ? AND (session_id = ? OR parent_session_id = ?))").run(projectDir, sessionId, sessionId);
    } else {
      db.prepare("DELETE FROM index_state WHERE file_path IN (SELECT file_key FROM transcript_files WHERE project_dir = ?)").run(projectDir);
    }
  });
  incrementalVacuum();
}
function incrementalVacuum() {
  try {
    const db = getDb();
    db.exec("PRAGMA incremental_vacuum");
  } catch (err) {
    logger.error("Incremental vacuum error:", err);
  }
}

// src/archive/store.ts
function compress(text) {
  return deflateRawSync(typeof text === "string" ? Buffer.from(text, "utf8") : text);
}
function decompress(data) {
  return inflateRawSync(data);
}
function getArchivedFile(fileKey) {
  return getRow(getDb(), "SELECT * FROM transcript_files WHERE file_key = ?", fileKey);
}
function getArchivedFiles(projectDir) {
  return allRows(getDb(), "SELECT * FROM transcript_files WHERE project_dir = ?", projectDir);
}
function* archivedLines(fileKey, fromLine = 1) {
  const rows = iterateRows(
    getDb(),
    "SELECT line_number, data FROM transcript_lines WHERE file_key = ? AND line_number >= ? ORDER BY line_number",
    fileKey,
    fromLine
  );
  for (const row of rows) {
    yield { lineNumber: row.line_number, text: decompress(row.data).toString("utf8") };
  }
}

// src/transcript/parser.ts
var SKIPPED_LINE_MARKER = '"file-history-snapshot"';
var DEFAULT_ENTRY_TYPES = ["user", "assistant", "summary"];
async function* parseTranscript(fileKey, options = {}) {
  const {
    includeTypes = DEFAULT_ENTRY_TYPES,
    fromLine = 1,
    toLine,
    maxEntries,
    containsText,
    caseInsensitive = true
  } = options;
  const searchText = containsText && caseInsensitive ? containsText.toLowerCase() : containsText;
  let yielded = 0;
  for (const { lineNumber, text: line } of archivedLines(fileKey, fromLine)) {
    if (toLine !== void 0 && lineNumber > toLine) break;
    if (maxEntries && yielded >= maxEntries) break;
    if (!line.trim()) continue;
    if (line.includes(SKIPPED_LINE_MARKER)) continue;
    if (searchText) {
      const haystack = caseInsensitive ? line.toLowerCase() : line;
      if (!haystack.includes(searchText)) continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      logger.debug(`Skipping corrupt line ${lineNumber} in ${fileKey}`);
      continue;
    }
    if (!includeTypes.includes(entry.type)) continue;
    yielded++;
    yield { entry, lineNumber, rawLength: line.length };
  }
}
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => b?.type === "text" && typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n");
  }
  return "";
}
function extractText(entry) {
  switch (entry.type) {
    case "user": {
      const user = entry;
      if (typeof user.message.content === "string") {
        return user.message.content;
      }
      return user.message.content.map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "tool_result") return toolResultText(block.content);
        return "";
      }).filter(Boolean).join("\n");
    }
    case "assistant": {
      const asst = entry;
      return asst.message.content.map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "tool_use") {
          const tool = block;
          return `[Tool: ${tool.name}]`;
        }
        return "";
      }).filter(Boolean).join("\n");
    }
    case "summary":
      return entry.summary || "";
    default:
      return "";
  }
}
function isToolResultEntry(entry) {
  if (entry.type !== "user") return false;
  const content = entry.message.content;
  return Array.isArray(content) && content.length > 0 && content.every((b) => b.type === "tool_result");
}

// src/embedding/chunker.ts
var EMBED_WINDOW_CHARS = 1600;
var WINDOW_OVERLAP_CHARS = 200;
function windows(text) {
  if (text.length <= EMBED_WINDOW_CHARS) return [{ start: 0, end: text.length }];
  const parts = [];
  let start = 0;
  for (; ; ) {
    let end = Math.min(start + EMBED_WINDOW_CHARS, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + EMBED_WINDOW_CHARS * 0.7) end = space;
    }
    parts.push({ start, end });
    if (end >= text.length) return parts;
    start = Math.max(end - WINDOW_OVERLAP_CHARS, start + 1);
  }
}
async function chunkTranscript(file, fromLine) {
  const toLine = file.line_count;
  const entries = [];
  for await (const parsed of parseTranscript(file.file_key, { includeTypes: ["user", "assistant", "summary"], fromLine, toLine })) {
    entries.push(parsed);
  }
  const chunks = [];
  const base = { session_id: file.session_id, project_dir: file.project_dir };
  const addText = (text, start, role, userEnd, hasAssistant, firstPartOnly = false) => {
    const parts = windows(text);
    (firstPartOnly ? parts.slice(0, 1) : parts).forEach(({ start: s, end: e }, part) => {
      chunks.push({
        ...base,
        entry_uuid: start.entry.uuid,
        role,
        content_text: text.slice(s, e),
        timestamp: start.entry.timestamp,
        line_number: start.lineNumber,
        part,
        hasUser: s < userEnd,
        hasAssistant: hasAssistant && e > userEnd
      });
    });
  };
  let i = 0;
  while (i < entries.length) {
    const current = entries[i];
    const { entry } = current;
    if (entry.type === "summary") {
      const text2 = extractText(entry);
      if (text2.trim()) addText(text2, current, "summary", 0, false);
      i++;
      continue;
    }
    if (entry.type === "user" && isToolResultEntry(entry)) {
      const text2 = extractText(entry);
      if (text2.trim()) addText(`TOOL RESULT: ${text2}`, current, "tool_result", 0, false, true);
      i++;
      continue;
    }
    if (entry.type === "user") {
      const userPart = `USER: ${extractText(entry)}`;
      const replies = [];
      i++;
      while (i < entries.length) {
        const next = entries[i];
        if (next.entry.type === "assistant") {
          const text3 = extractText(next.entry);
          if (text3.trim()) replies.push(text3);
        } else if (next.entry.type === "user" && isToolResultEntry(next.entry)) {
          const text3 = extractText(next.entry);
          if (text3.trim()) addText(`TOOL RESULT: ${text3}`, next, "tool_result", 0, false, true);
        } else if (next.entry.type === "summary") {
          const text3 = extractText(next.entry);
          if (text3.trim()) addText(text3, next, "summary", 0, false);
        } else {
          break;
        }
        i++;
      }
      const text2 = replies.length > 0 ? `${userPart}
ASSISTANT: ${replies.join("\n")}` : userPart;
      if (text2.trim() !== "USER:") addText(text2, current, "turn", userPart.length, replies.length > 0);
      continue;
    }
    const text = extractText(entry);
    if (text.trim()) addText(`ASSISTANT: ${text}`, current, "assistant", 0, true);
    i++;
  }
  logger.debug(`Chunked ${file.file_key} from line ${fromLine}: ${entries.length} entries -> ${chunks.length} chunks`);
  return { chunks, lastLine: toLine };
}

// src/archive/archiver.ts
import { closeSync, openSync, readFileSync as readFileSync2, readSync, statSync as statSync2 } from "fs";
import { setImmediate as nextTick } from "timers/promises";

// src/transcript/discovery.ts
import { readFileSync, readdirSync, existsSync as existsSync3, statSync } from "fs";
import { join as join3, basename, relative as relative2, sep as sep2 } from "path";
var SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function listProjectDirsOnDisk() {
  const projectsDir = getProjectsDir();
  if (!existsSync3(projectsDir)) return [];
  return readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}
function listSourceFiles(projectDir) {
  const dir = getProjectTranscriptDir(projectDir);
  const transcripts = [];
  const attachments = [];
  if (!existsSync3(dir)) return { transcripts, attachments };
  const keyOf = (path) => relative2(getProjectsDir(), path).split(sep2).join("/");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join3(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      transcripts.push({ path, fileKey: keyOf(path), sessionId: basename(entry.name, ".jsonl"), parentSessionId: null });
      continue;
    }
    if (!entry.isDirectory() || !SESSION_DIR.test(entry.name)) continue;
    const sessionId = entry.name;
    for (const file of walkFiles(path)) {
      const inSubagents = relative2(path, file).split(sep2)[0] === "subagents";
      if (inSubagents && file.endsWith(".jsonl")) {
        if (basename(file).includes("aprompt_suggestion")) continue;
        transcripts.push({ path: file, fileKey: keyOf(file), sessionId: basename(file, ".jsonl"), parentSessionId: sessionId });
      } else if (!(inSubagents && basename(file).includes("aprompt_suggestion"))) {
        attachments.push({ path: file, fileKey: keyOf(file), sessionId });
      }
    }
  }
  return { transcripts, attachments };
}
function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join3(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// src/archive/archiver.ts
var BATCH_BYTES = 8 * 1024 * 1024;
var FIRST_PROMPT_LABEL_CHARS = 1e3;
var COUNTED_TYPES = /* @__PURE__ */ new Set(["user", "assistant", "summary"]);
var NEWLINE = 10;
var archiveProjects = serialized(runArchive);
async function runArchive(projectDirs, options = {}) {
  const report = { filesUpdated: 0, linesAdded: 0, attachmentsUpdated: 0, sourcesGone: 0, errors: [] };
  for (const projectDir of projectDirs) {
    if (options.signal?.aborted) break;
    const { transcripts, attachments } = listSourceFiles(projectDir);
    const total = transcripts.length + attachments.length;
    let current = 0;
    for (const source of transcripts) {
      if (options.signal?.aborted) break;
      options.onProgress?.({ phase: `Archiving ${projectDir}`, current: ++current, total, detail: source.fileKey });
      try {
        const added = await archiveTranscript(projectDir, source, options.signal);
        if (added > 0) {
          report.filesUpdated++;
          report.linesAdded += added;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Could not archive ${source.path}:`, msg);
        report.errors.push(`${source.fileKey}: ${msg}`);
      }
    }
    for (const attachment of attachments) {
      if (options.signal?.aborted) break;
      options.onProgress?.({ phase: `Archiving ${projectDir}`, current: ++current, total, detail: attachment.fileKey });
      try {
        if (await archiveAttachment(projectDir, attachment)) report.attachmentsUpdated++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Could not archive ${attachment.path}:`, msg);
        report.errors.push(`${attachment.fileKey}: ${msg}`);
      }
      await nextTick();
    }
    if (!options.signal?.aborted) {
      report.sourcesGone += await markSourcesGone(projectDir, new Set(transcripts.map((t) => t.fileKey)));
    }
  }
  if (report.linesAdded > 0 || report.attachmentsUpdated > 0) {
    logger.info(`Archived ${report.linesAdded} lines in ${report.filesUpdated} transcripts, ${report.attachmentsUpdated} attached files`);
  }
  return report;
}
async function archiveTranscript(projectDir, source, signal) {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO transcript_files (file_key, project_dir, session_id, parent_session_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(source.fileKey, projectDir, source.sessionId, source.parentSessionId, (/* @__PURE__ */ new Date()).toISOString());
  let added = 0;
  for (; ; ) {
    if (signal?.aborted) return added;
    const state = getArchivedFile(source.fileKey);
    let size;
    try {
      size = statSync2(source.path).size;
    } catch {
      return added;
    }
    if (size < state.archived_bytes) {
      const reason = `the transcript is now ${size} bytes, smaller than the ${state.archived_bytes} bytes already archived: it was rewritten, the archived copy is kept unchanged and new lines are not archived`;
      if (state.error !== reason) {
        db.prepare("UPDATE transcript_files SET error = ?, updated_at = ? WHERE file_key = ?").run(reason, (/* @__PURE__ */ new Date()).toISOString(), source.fileKey);
      }
      throw new Error(reason);
    }
    if (size === state.archived_bytes) {
      if (state.error) db.prepare("UPDATE transcript_files SET error = NULL WHERE file_key = ?").run(source.fileKey);
      return added;
    }
    const batch = readCompleteLines(source.path, state.archived_bytes, size);
    if (!batch) return added;
    const written = await writeBatchWhenFree(projectDir, state, batch.lines, batch.bytes);
    if (written === null) continue;
    added += written;
    await nextTick();
  }
}
function readCompleteLines(path, offset, size) {
  const fd = openSync(path, "r");
  try {
    let length = Math.min(BATCH_BYTES, size - offset);
    for (; ; ) {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, offset);
      const data = buf.subarray(0, read);
      const lastNewline = data.lastIndexOf(NEWLINE);
      if (lastNewline === -1) {
        if (offset + read >= size) return null;
        length = Math.min(length * 2, size - offset);
        continue;
      }
      const lines = [];
      let start = 0;
      for (let nl = data.indexOf(NEWLINE); nl !== -1 && nl <= lastNewline; nl = data.indexOf(NEWLINE, start)) {
        const end = nl > start && data[nl - 1] === 13 ? nl - 1 : nl;
        lines.push(data.subarray(start, end));
        start = nl + 1;
      }
      return { lines, bytes: lastNewline + 1 };
    }
  } finally {
    closeSync(fd);
  }
}
var WRITE_ATTEMPTS = 6;
async function writeBatchWhenFree(projectDir, state, lines, bytes) {
  const compressed = lines.map((line) => compress(line));
  const meta = readMetadata(projectDir, state, lines);
  return whenWriteLockFree(state.file_key, () => writeBatch(state, compressed, meta, bytes));
}
async function whenWriteLockFree(fileKey, write) {
  for (let attempt = 1; ; attempt++) {
    try {
      return write();
    } catch (err) {
      const busy = err instanceof Error && /database is locked|SQLITE_BUSY/i.test(err.message);
      if (!busy || attempt >= WRITE_ATTEMPTS) throw err;
      logger.debug(`Archive write of ${fileKey} waiting for another process (attempt ${attempt})`);
      await nextTick();
    }
  }
}
function writeBatch(state, lines, meta, bytes) {
  const db = getDb();
  const insertLine = db.prepare("INSERT INTO transcript_lines (file_key, line_number, data) VALUES (?, ?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getArchivedFile(state.file_key);
    if (current.archived_bytes !== state.archived_bytes || current.line_count !== state.line_count) {
      db.exec("ROLLBACK");
      return null;
    }
    for (let i = 0; i < lines.length; i++) {
      insertLine.run(state.file_key, state.line_count + i + 1, lines[i]);
    }
    db.prepare(`
      UPDATE transcript_files SET
        archived_bytes = ?, line_count = ?, entry_count = entry_count + ?,
        first_timestamp = COALESCE(first_timestamp, ?),
        last_timestamp = CASE WHEN ? IS NOT NULL AND (last_timestamp IS NULL OR ? > last_timestamp) THEN ? ELSE last_timestamp END,
        first_prompt = CASE WHEN first_prompt = '' THEN ? ELSE first_prompt END,
        title = CASE WHEN ? != '' THEN ? ELSE title END,
        custom_title = CASE WHEN ? != '' THEN ? ELSE custom_title END,
        git_branch = CASE WHEN git_branch = '' THEN ? ELSE git_branch END,
        project_path = CASE WHEN project_path = '' THEN ? ELSE project_path END,
        parent_session_id = COALESCE(parent_session_id, ?),
        source_gone_at = NULL, error = NULL, updated_at = ?
      WHERE file_key = ?
    `).run(
      state.archived_bytes + bytes,
      state.line_count + lines.length,
      meta.entries,
      meta.firstTimestamp,
      meta.lastTimestamp,
      meta.lastTimestamp,
      meta.lastTimestamp,
      meta.firstPrompt,
      meta.title,
      meta.title,
      meta.customTitle,
      meta.customTitle,
      meta.gitBranch,
      meta.projectPath,
      meta.parentSessionId,
      (/* @__PURE__ */ new Date()).toISOString(),
      state.file_key
    );
    db.exec("COMMIT");
    return lines.length;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
function readMetadata(projectDir, state, lines) {
  const meta = {
    entries: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    firstPrompt: "",
    title: "",
    customTitle: "",
    gitBranch: "",
    projectPath: "",
    parentSessionId: null
  };
  const needsParent = state.parent_session_id === null && state.session_id.startsWith("agent-");
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line.toString("utf8"));
    } catch {
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "";
    if (COUNTED_TYPES.has(type)) meta.entries++;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : null;
    if (ts) {
      if (!meta.firstTimestamp) meta.firstTimestamp = ts;
      if (!meta.lastTimestamp || ts > meta.lastTimestamp) meta.lastTimestamp = ts;
    }
    if (type === "summary" && typeof entry.summary === "string" && entry.summary) meta.title = entry.summary;
    if (type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle) meta.title = entry.aiTitle;
    if (type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle) meta.customTitle = entry.customTitle;
    if (!meta.gitBranch && typeof entry.gitBranch === "string") meta.gitBranch = entry.gitBranch;
    if (!meta.projectPath && typeof entry.cwd === "string" && isProjectPath(entry.cwd, projectDir)) meta.projectPath = entry.cwd;
    if (needsParent && !meta.parentSessionId && typeof entry.sessionId === "string" && entry.sessionId !== state.session_id) {
      meta.parentSessionId = entry.sessionId;
    }
    if (!state.first_prompt && !meta.firstPrompt && type === "user" && !entry.isMeta) {
      meta.firstPrompt = promptText(entry).slice(0, FIRST_PROMPT_LABEL_CHARS);
    }
  }
  return meta;
}
function promptText(entry) {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.find((b) => b?.type === "text" && typeof b.text === "string");
    return text ? text.text : "";
  }
  return "";
}
async function archiveAttachment(projectDir, source) {
  const stat = statSync2(source.path);
  const db = getDb();
  const existing = db.prepare("SELECT size, mtime_ms FROM transcript_attachments WHERE file_key = ?").get(source.fileKey);
  if (existing && existing.size === stat.size && existing.mtime_ms === stat.mtimeMs) return false;
  const data = compress(readFileSync2(source.path));
  await whenWriteLockFree(source.fileKey, () => db.prepare(`
    INSERT OR REPLACE INTO transcript_attachments (file_key, project_dir, session_id, size, mtime_ms, data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(source.fileKey, projectDir, source.sessionId, stat.size, stat.mtimeMs, data, (/* @__PURE__ */ new Date()).toISOString()));
  return true;
}
async function markSourcesGone(projectDir, present) {
  const gone = getArchivedFiles(projectDir).filter((f) => f.source_gone_at === null && !present.has(f.file_key));
  if (gone.length === 0) return 0;
  const db = getDb();
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const mark = db.prepare("UPDATE transcript_files SET source_gone_at = ? WHERE file_key = ? AND source_gone_at IS NULL");
  await whenWriteLockFree(projectDir, () => inTransaction(db, () => {
    for (const f of gone) mark.run(now, f.file_key);
  }));
  logger.info(`${gone.length} transcript(s) of ${projectDir} deleted by Claude Code: the archived copies are kept`);
  return gone.length;
}

// src/db/indexer.ts
var EMBED_BATCH_SIZE = 32;
var PENDING_PAGE_SIZE = 2e3;
var buildIndex = serialized(runBuildIndex);
async function runBuildIndex(provider, projectDirs, options = {}) {
  const { sessionId, includeSubagents = true, rebuild = false, onProgress, signal } = options;
  const archive = await archiveProjects(projectDirs, { onProgress, signal });
  if (!provider.isReady()) {
    onProgress?.({ phase: "Initializing embedding model", current: 0, total: 1 });
    await provider.initialize();
  }
  const stored = getIndexIdentity();
  const resetAll = rebuild && stored !== null && !sameIdentity(stored, provider.identity);
  if (resetAll) {
    logger.info("Embedding model changed: resetting the vectors of every project");
  }
  prepareVectorIndex(provider.identity, { resetAll });
  if (rebuild && !resetAll) {
    logger.info("Rebuilding index from the archive...");
    for (const dir of projectDirs) {
      clearArchivedChunks(dir, sessionId);
    }
  }
  let totalChunks = 0;
  let totalEmbedded = 0;
  let filesProcessed = 0;
  let skipped = 0;
  const errors = [];
  for (const projectDir of projectDirs) {
    const files = getArchivedFiles(projectDir).filter((f) => {
      if (f.parent_session_id !== null && !includeSubagents) return false;
      return !sessionId || f.session_id === sessionId || f.parent_session_id === sessionId;
    });
    const totalFiles = files.length;
    onProgress?.({ phase: `Indexing ${projectDir}`, current: 0, total: totalFiles });
    for (let fi = 0; fi < files.length; fi++) {
      if (signal?.aborted) break;
      const file = files[fi];
      onProgress?.({
        phase: `Indexing ${projectDir}`,
        current: fi + 1,
        total: totalFiles,
        detail: `Session ${file.session_id.slice(0, 8)}...`
      });
      try {
        const indexState = getIndexState(file.file_key);
        if (indexState && indexState.last_line >= file.line_count) {
          skipped++;
          continue;
        }
        const fromLine = indexState ? indexState.last_line + 1 : 1;
        const { chunks, lastLine } = await chunkTranscript(file, fromLine);
        for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
          const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
          const embeddings = await provider.embed(batch.map((c) => c.content_text));
          totalEmbedded += insertChunks(batch, embeddings);
        }
        totalChunks += chunks.length;
        setIndexState(file.file_key, file.archived_bytes, lastLine);
        if (chunks.length > 0) filesProcessed++;
        else skipped++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error indexing ${file.file_key}:`, msg);
        if (errors.length < 5) {
          errors.push(`${file.session_id.slice(0, 8)}...: ${msg.slice(0, 200)}`);
        }
      }
    }
    if (!signal?.aborted && hasPendingVectors(projectDir)) {
      try {
        totalEmbedded += await embedPendingChunks(provider, projectDir, onProgress, signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error re-embedding the kept chunks of ${projectDir}:`, msg);
        if (errors.length < 5) errors.push(`${projectDir} (kept chunks): ${msg.slice(0, 200)}`);
      }
    }
  }
  logger.info(`Indexing complete: ${totalChunks} chunks, ${totalEmbedded} embedded, ${filesProcessed} files, ${skipped} skipped`);
  return { totalChunks, totalEmbedded, filesProcessed, skipped, errors, resetAll, archive };
}
async function embedPendingChunks(provider, projectDir, onProgress, signal) {
  let embedded = 0;
  for (let after = 0; ; ) {
    if (signal?.aborted) return embedded;
    const { missing, lastChunkId } = getChunksWithoutVectors(projectDir, after, PENDING_PAGE_SIZE);
    if (lastChunkId === null) break;
    for (let i = 0; i < missing.length; i += EMBED_BATCH_SIZE) {
      const batch = missing.slice(i, i + EMBED_BATCH_SIZE);
      insertVectors(batch, await provider.embed(batch.map((c) => c.content_text)));
      embedded += batch.length;
    }
    onProgress?.({ phase: `Re-embedding kept excerpts of ${projectDir}`, current: embedded, total: 0 });
    after = lastChunkId;
  }
  clearPendingVectors(projectDir);
  return embedded;
}

// src/docs/indexer.ts
import { statSync as statSync3, readdirSync as readdirSync2, readFileSync as readFileSync4 } from "fs";
import { join as join5, relative as relative3, resolve } from "path";
import { createHash } from "crypto";

// src/docs/chunker.ts
import { readFileSync as readFileSync3 } from "fs";
import { extname } from "path";
var CATEGORY_MAP = {
  // doc
  ".md": "doc",
  ".txt": "doc",
  ".rst": "doc",
  ".adoc": "doc",
  // code
  ".ts": "code",
  ".tsx": "code",
  ".js": "code",
  ".jsx": "code",
  ".mjs": "code",
  ".cjs": "code",
  ".py": "code",
  ".go": "code",
  ".rs": "code",
  ".java": "code",
  ".cs": "code",
  ".c": "code",
  ".cpp": "code",
  ".h": "code",
  ".hpp": "code",
  ".rb": "code",
  ".php": "code",
  ".swift": "code",
  ".kt": "code",
  ".lua": "code",
  ".sh": "code",
  ".bash": "code",
  ".ps1": "code",
  ".bat": "code",
  ".vue": "code",
  ".svelte": "code",
  ".css": "code",
  ".scss": "code",
  ".less": "code",
  ".html": "code",
  ".xml": "code",
  ".sql": "code",
  ".graphql": "code",
  ".gql": "code",
  ".gd": "code",
  ".gdshader": "code",
  // config
  ".json": "config",
  ".yaml": "config",
  ".yml": "config",
  ".toml": "config",
  ".ini": "config",
  ".editorconfig": "config"
};
function detectCategory(filePath) {
  const ext = extname(filePath).toLowerCase();
  return CATEGORY_MAP[ext] ?? null;
}
function isSupportedExtension(filePath) {
  return detectCategory(filePath) !== null;
}
var MAX_EMBED_CHARS = 1600;
var MAX_CONTENT_CHARS = 2e3;
var MAX_CHUNK_LINES = 80;
var MIN_CHUNK_LINES = 5;
function truncateForEmbed(text, maxChars) {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxChars * 0.7 ? truncated.slice(0, lastSpace) : truncated;
}
function parseMarkdownHeaders(lines) {
  const headers = [];
  let inCodeBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headers.push({
        level: match[1].length,
        text: match[2].replace(/\s+#+\s*$/, "").trim(),
        // Remove trailing # markers
        lineIndex: i
      });
    }
  }
  return headers;
}
function buildSectionPath(headers, currentIndex) {
  const current = headers[currentIndex];
  const parts = [];
  let targetLevel = current.level - 1;
  for (let i = currentIndex - 1; i >= 0 && targetLevel >= 1; i--) {
    if (headers[i].level === targetLevel) {
      parts.unshift(`${"#".repeat(headers[i].level)} ${headers[i].text}`);
      targetLevel--;
    }
  }
  parts.push(`${"#".repeat(current.level)} ${current.text}`);
  return parts.join(" > ");
}
function chunkMarkdown(lines, relativePath) {
  const headers = parseMarkdownHeaders(lines);
  const chunks = [];
  const sections = [];
  if (headers.length === 0) {
    const content = lines.join("\n");
    if (content.trim()) {
      chunks.push({
        file_path: relativePath,
        category: "doc",
        content_text: truncateForEmbed(content, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${relativePath}]
${content}`, MAX_EMBED_CHARS),
        start_line: 1,
        end_line: lines.length,
        section_path: null
      });
    }
    return { chunks, sections };
  }
  if (headers[0].lineIndex > 0) {
    const preContent = lines.slice(0, headers[0].lineIndex).join("\n");
    if (preContent.trim()) {
      chunks.push({
        file_path: relativePath,
        category: "doc",
        content_text: truncateForEmbed(preContent, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${relativePath}]
${preContent}`, MAX_EMBED_CHARS),
        start_line: 1,
        end_line: headers[0].lineIndex,
        section_path: null
      });
    }
  }
  for (let hi = 0; hi < headers.length; hi++) {
    const header = headers[hi];
    const startLine = header.lineIndex;
    const endLine = hi + 1 < headers.length ? headers[hi + 1].lineIndex : lines.length;
    const sectionLines = lines.slice(startLine, endLine);
    const sectionContent = sectionLines.join("\n");
    const sectionPath = buildSectionPath(headers, hi);
    sections.push({
      file_path: relativePath,
      heading: header.text,
      level: header.level,
      start_line: startLine + 1,
      // 1-based for user display
      end_line: endLine < lines.length ? endLine : null,
      section_path: sectionPath
    });
    if (!sectionContent.trim()) continue;
    if (sectionContent.length > MAX_CONTENT_CHARS) {
      const subChunks = splitAtParagraphs(sectionLines, startLine, relativePath, "doc", sectionPath);
      chunks.push(...subChunks);
    } else {
      chunks.push({
        file_path: relativePath,
        category: "doc",
        content_text: truncateForEmbed(sectionContent, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${sectionPath}]
${sectionContent}`, MAX_EMBED_CHARS),
        start_line: startLine + 1,
        end_line: endLine,
        section_path: sectionPath
      });
    }
  }
  return { chunks, sections };
}
function chunkCode(lines, relativePath) {
  const chunks = [];
  if (lines.length <= MAX_CHUNK_LINES) {
    const content = lines.join("\n");
    if (content.trim()) {
      chunks.push({
        file_path: relativePath,
        category: "code",
        content_text: truncateForEmbed(content, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${relativePath}]
${content}`, MAX_EMBED_CHARS),
        start_line: 1,
        end_line: lines.length,
        section_path: null
      });
    }
    return { chunks, sections: [] };
  }
  const splitPoints = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      splitPoints.push(i);
    }
  }
  let chunkStart = 0;
  while (chunkStart < lines.length) {
    let chunkEnd = Math.min(chunkStart + MAX_CHUNK_LINES, lines.length);
    if (chunkEnd < lines.length) {
      const nearestBlank = splitPoints.find(
        (p) => p >= chunkStart + MIN_CHUNK_LINES && p <= chunkEnd
      );
      const candidates = splitPoints.filter(
        (p) => p >= chunkStart + MIN_CHUNK_LINES && p <= chunkEnd
      );
      if (candidates.length > 0) {
        chunkEnd = candidates[candidates.length - 1] + 1;
      }
    }
    const chunkLines = lines.slice(chunkStart, chunkEnd);
    const content = chunkLines.join("\n");
    if (content.trim()) {
      chunks.push({
        file_path: relativePath,
        category: "code",
        content_text: truncateForEmbed(content, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(`[${relativePath}:${chunkStart + 1}-${chunkEnd}]
${content}`, MAX_EMBED_CHARS),
        start_line: chunkStart + 1,
        end_line: chunkEnd,
        section_path: null
      });
    }
    chunkStart = chunkEnd;
  }
  return { chunks, sections: [] };
}
function chunkConfig(lines, relativePath) {
  const content = lines.join("\n");
  const chunks = [];
  if (!content.trim()) return { chunks, sections: [] };
  if (content.length <= MAX_CONTENT_CHARS) {
    chunks.push({
      file_path: relativePath,
      category: "config",
      content_text: truncateForEmbed(content, MAX_CONTENT_CHARS),
      embed_text: truncateForEmbed(`[config: ${relativePath}]
${content}`, MAX_EMBED_CHARS),
      start_line: 1,
      end_line: lines.length,
      section_path: null
    });
  } else {
    const codeResult = chunkCode(lines, relativePath);
    for (const chunk of codeResult.chunks) {
      chunk.category = "config";
    }
    chunks.push(...codeResult.chunks);
  }
  return { chunks, sections: [] };
}
function splitAtParagraphs(lines, baseLineIndex, relativePath, category, sectionPath) {
  const chunks = [];
  let blockStart = 0;
  let currentBlock = [];
  for (let i = 0; i < lines.length; i++) {
    currentBlock.push(lines[i]);
    const blockContent = currentBlock.join("\n");
    if (blockContent.length >= MAX_CONTENT_CHARS * 0.8 && lines[i].trim() === "") {
      if (blockContent.trim()) {
        chunks.push({
          file_path: relativePath,
          category,
          content_text: truncateForEmbed(blockContent, MAX_CONTENT_CHARS),
          embed_text: truncateForEmbed(
            sectionPath ? `[${sectionPath}]
${blockContent}` : `[${relativePath}]
${blockContent}`,
            MAX_EMBED_CHARS
          ),
          start_line: baseLineIndex + blockStart + 1,
          end_line: baseLineIndex + i + 1,
          section_path: sectionPath
        });
      }
      blockStart = i + 1;
      currentBlock = [];
    }
  }
  if (currentBlock.length > 0) {
    const remaining = currentBlock.join("\n");
    if (remaining.trim()) {
      chunks.push({
        file_path: relativePath,
        category,
        content_text: truncateForEmbed(remaining, MAX_CONTENT_CHARS),
        embed_text: truncateForEmbed(
          sectionPath ? `[${sectionPath}]
${remaining}` : `[${relativePath}]
${remaining}`,
          MAX_EMBED_CHARS
        ),
        start_line: baseLineIndex + blockStart + 1,
        end_line: baseLineIndex + lines.length,
        section_path: sectionPath
      });
    }
  }
  return chunks;
}
function chunkFile(filePath, relativePath, category) {
  const resolvedCategory = category || detectCategory(filePath);
  if (!resolvedCategory) {
    return { chunks: [], sections: [] };
  }
  const content = readFileSync3(filePath, "utf-8");
  const lines = content.split("\n");
  switch (resolvedCategory) {
    case "doc":
      return chunkMarkdown(lines, relativePath);
    case "code":
      return chunkCode(lines, relativePath);
    case "config":
      return chunkConfig(lines, relativePath);
    default:
      return { chunks: [], sections: [] };
  }
}

// src/docs/store.ts
import { existsSync as existsSync4, statSync as fsStatSync } from "fs";
import { join as join4 } from "path";

// src/docs/schema.ts
var DOCS_SCHEMA_VERSION = 3;
var DOCS_CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_sources (
    source_id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK(type IN ('file', 'directory')),
    pattern TEXT,
    category TEXT CHECK(category IS NULL OR category IN ('doc', 'code', 'config')),
    recursive INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_chunks (
    chunk_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('doc', 'code', 'config')),
    content_text TEXT NOT NULL,
    embed_text TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    section_path TEXT,
    file_modified TEXT NOT NULL,
    UNIQUE(file_path, start_line)
  );

  CREATE TABLE IF NOT EXISTS doc_sections (
    section_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    heading TEXT NOT NULL,
    level INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER,
    section_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_index_state (
    file_path TEXT PRIMARY KEY,
    file_size INTEGER NOT NULL,
    file_mtime TEXT NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS doc_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_doc_chunks_file ON doc_chunks(file_path);
  CREATE INDEX IF NOT EXISTS idx_doc_chunks_category ON doc_chunks(category);
  CREATE INDEX IF NOT EXISTS idx_doc_sections_file ON doc_sections(file_path);
  CREATE INDEX IF NOT EXISTS idx_snapshots_path ON doc_snapshots(file_path);
  CREATE INDEX IF NOT EXISTS idx_snapshots_created ON doc_snapshots(created_at);
`;
var LEGACY_DOCS_VEC_TABLE = "vec_doc_chunks";
var DOC_CHUNK_VECTORS = "doc_chunk_vectors";
function createDocChunkVectorsTable(dimensions) {
  return `CREATE VIRTUAL TABLE ${DOC_CHUNK_VECTORS} USING vec0 (
    chunk_id INTEGER PRIMARY KEY,
    category TEXT,
    file_path TEXT,
    embedding float[${dimensions}] distance_metric=cosine
  );`;
}

// src/docs/store.ts
var _docsDb = null;
var _docsDbPath = null;
var DOCS_REBUILD_HINT = 'rebuild it with souvenir_docs action="build" rebuild=true (re-embeds every indexed file)';
function getLocalDocsDbPath(projectRoot) {
  return join4(projectRoot, ".claude", "ASymptOmatik", "souvenir", "docs.db");
}
function getDocsDb(projectRoot) {
  const dbPath = getLocalDocsDbPath(projectRoot);
  if (_docsDb && _docsDbPath === dbPath) return _docsDb;
  if (_docsDb) {
    _docsDb.close();
    _docsDb = null;
    _docsDbPath = null;
  }
  const db = openDatabase(dbPath, "docs");
  try {
    db.exec(DOCS_CREATE_TABLES);
    migrateLegacyIdentity(db);
    migrateLegacyDocVectors(db);
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(DOCS_SCHEMA_VERSION)
    );
  } catch (err) {
    db.close();
    throw err;
  }
  _docsDb = db;
  _docsDbPath = dbPath;
  logger.info("Docs database initialized");
  return db;
}
function migrateLegacyDocVectors(db) {
  if (!tableExists(db, LEGACY_DOCS_VEC_TABLE)) return;
  const legacyDims = vectorTableDimensions(db, LEGACY_DOCS_VEC_TABLE);
  const currentDims = tableExists(db, DOC_CHUNK_VECTORS) ? vectorTableDimensions(db, DOC_CHUNK_VECTORS) : null;
  let moved = 0;
  inTransaction(db, () => {
    if (currentDims !== null && currentDims !== legacyDims) {
      logger.warn(`Dropping ${LEGACY_DOCS_VEC_TABLE} (${legacyDims}d): incompatible with ${DOC_CHUNK_VECTORS} (${currentDims}d)`);
    } else {
      if (currentDims === null) db.exec(createDocChunkVectorsTable(legacyDims));
      const legacyVector = db.prepare(`SELECT embedding FROM ${LEGACY_DOCS_VEC_TABLE} WHERE chunk_id = ?`);
      const alreadyMoved = db.prepare(`SELECT chunk_id FROM ${DOC_CHUNK_VECTORS} WHERE chunk_id = ?`);
      const insert = db.prepare(`INSERT INTO ${DOC_CHUNK_VECTORS} (chunk_id, category, file_path, embedding) VALUES (?, ?, ?, ?)`);
      const chunks = allRows(
        db,
        "SELECT chunk_id, category, file_path FROM doc_chunks ORDER BY chunk_id"
      );
      for (const c of chunks) {
        const id = BigInt(c.chunk_id);
        const vector = legacyVector.get(id);
        if (!vector || alreadyMoved.get(id)) continue;
        insert.run(id, c.category, c.file_path, vector.embedding);
        moved++;
      }
      const orphans = deleteOrphanVectors(db, DOC_CHUNK_VECTORS, "doc_chunks");
      if (orphans > 0) logger.info(`Deleted ${orphans} doc vectors of chunks that no longer exist`);
    }
    db.exec(`DROP TABLE ${LEGACY_DOCS_VEC_TABLE}`);
  });
  db.exec("PRAGMA incremental_vacuum");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  logger.info(`Moved ${moved} doc vectors from ${LEGACY_DOCS_VEC_TABLE} to ${DOC_CHUNK_VECTORS}`);
}
function prepareDocsVectorIndex(projectRoot, identity, options = {}) {
  const db = getDocsDb(projectRoot);
  if (!options.resetAll) {
    assertSameIdentity(getStoredIdentity(db), identity, "docs", DOCS_REBUILD_HINT);
  }
  inTransaction(db, () => {
    if (options.resetAll) {
      if (tableExists(db, DOC_CHUNK_VECTORS)) db.exec(`DROP TABLE ${DOC_CHUNK_VECTORS}`);
      db.prepare("DELETE FROM doc_chunks").run();
      db.prepare("DELETE FROM doc_sections").run();
      db.prepare("DELETE FROM doc_index_state").run();
    }
    if (!tableExists(db, DOC_CHUNK_VECTORS)) db.exec(createDocChunkVectorsTable(identity.dimensions));
    setStoredIdentity(db, identity);
  });
}
function docsDbExists(projectRoot) {
  return existsSync4(getLocalDocsDbPath(projectRoot));
}
function getDocSources(projectRoot) {
  const db = getDocsDb(projectRoot);
  return allRows(db, "SELECT * FROM doc_sources ORDER BY added_at");
}
function insertDocChunks(projectRoot, chunks, embeddings) {
  const db = getDocsDb(projectRoot);
  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk count (${chunks.length}) doesn't match embedding count (${embeddings.length})`);
  }
  const insertChunk = db.prepare(`
    INSERT OR IGNORE INTO doc_chunks (file_path, category, content_text, embed_text, start_line, end_line, section_path, file_modified)
    VALUES (@file_path, @category, @content_text, @embed_text, @start_line, @end_line, @section_path, @file_modified)
  `);
  const insertVec = db.prepare(`
    INSERT INTO ${DOC_CHUNK_VECTORS} (chunk_id, category, file_path, embedding)
    VALUES (?, ?, ?, ?)
  `);
  let inserted = 0;
  inTransaction(db, () => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = insertChunk.run({
        file_path: chunk.file_path,
        category: chunk.category,
        content_text: chunk.content_text,
        embed_text: chunk.embed_text,
        start_line: chunk.start_line,
        end_line: chunk.end_line,
        section_path: chunk.section_path,
        file_modified: chunk.file_modified
      });
      if (result.changes > 0) {
        insertVec.run(BigInt(result.lastInsertRowid), chunk.category, chunk.file_path, vectorBlob(embeddings[i]));
        inserted++;
      }
    }
  });
  return inserted;
}
function insertDocSections(projectRoot, sections) {
  const db = getDocsDb(projectRoot);
  const insert = db.prepare(`
    INSERT INTO doc_sections (file_path, heading, level, start_line, end_line, section_path)
    VALUES (@file_path, @heading, @level, @start_line, @end_line, @section_path)
  `);
  inTransaction(db, () => {
    for (const section of sections) {
      insert.run({
        file_path: section.file_path,
        heading: section.heading,
        level: section.level,
        start_line: section.start_line,
        end_line: section.end_line,
        section_path: section.section_path
      });
    }
  });
}
function getDocIndexState(projectRoot, filePath) {
  const db = getDocsDb(projectRoot);
  return getRow(db, "SELECT * FROM doc_index_state WHERE file_path = ?", filePath);
}
function setDocIndexState(projectRoot, filePath, fileSize, fileMtime) {
  const db = getDocsDb(projectRoot);
  db.prepare(`
    INSERT OR REPLACE INTO doc_index_state (file_path, file_size, file_mtime, indexed_at)
    VALUES (?, ?, ?, ?)
  `).run(filePath, fileSize, fileMtime, (/* @__PURE__ */ new Date()).toISOString());
}
function clearDocFile(projectRoot, filePath) {
  const db = getDocsDb(projectRoot);
  inTransaction(db, () => {
    const chunkIds = db.prepare("SELECT chunk_id FROM doc_chunks WHERE file_path = ?").all(filePath);
    if (tableExists(db, DOC_CHUNK_VECTORS)) {
      const deleteVector = db.prepare(`DELETE FROM ${DOC_CHUNK_VECTORS} WHERE chunk_id = ?`);
      for (const { chunk_id } of chunkIds) {
        deleteVector.run(BigInt(chunk_id));
      }
    }
    db.prepare("DELETE FROM doc_chunks WHERE file_path = ?").run(filePath);
    db.prepare("DELETE FROM doc_sections WHERE file_path = ?").run(filePath);
    db.prepare("DELETE FROM doc_index_state WHERE file_path = ?").run(filePath);
  });
}
function docsIncrementalVacuum(projectRoot) {
  try {
    const db = getDocsDb(projectRoot);
    db.exec("PRAGMA incremental_vacuum");
  } catch (err) {
    logger.error("Docs incremental vacuum error:", err);
  }
}
function insertSnapshot(projectRoot, filePath, content, contentHash, fileSize) {
  const db = getDocsDb(projectRoot);
  const latest = db.prepare(
    "SELECT content_hash FROM doc_snapshots WHERE file_path = ? ORDER BY created_at DESC LIMIT 1"
  ).get(filePath);
  if (latest && latest.content_hash === contentHash) {
    return false;
  }
  db.prepare(
    "INSERT INTO doc_snapshots (file_path, content, content_hash, file_size, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(filePath, content, contentHash, fileSize, (/* @__PURE__ */ new Date()).toISOString());
  return true;
}
function cleanupOldSnapshots(projectRoot, maxAgeDays) {
  const db = getDocsDb(projectRoot);
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1e3).toISOString();
  const result = db.prepare("DELETE FROM doc_snapshots WHERE created_at < ?").run(cutoff);
  const deleted = Number(result.changes);
  if (deleted > 0) {
    docsIncrementalVacuum(projectRoot);
  }
  return deleted;
}

// src/docs/indexer.ts
var EMBED_BATCH_SIZE2 = 32;
var MAX_FILE_SIZE = 10 * 1024 * 1024;
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".venv",
  "venv",
  ".claude",
  ".godot",
  ".import",
  "addons"
]);
var VISIBLE_DOT_DIRS = /* @__PURE__ */ new Set([
  ".claude-plugin",
  ".github",
  ".vscode",
  ".husky",
  ".circleci",
  ".devcontainer",
  ".docker"
]);
var SKIP_FILES = /* @__PURE__ */ new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml"
]);
function listFilesRecursive(dirPath, pattern, recursive) {
  const results = [];
  let entries;
  try {
    entries = readdirSync2(dirPath, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join5(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (!recursive) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && !VISIBLE_DOT_DIRS.has(entry.name)) continue;
      results.push(...listFilesRecursive(fullPath, pattern, recursive));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      if (pattern) {
        if (!matchSimplePattern(entry.name, pattern)) continue;
      }
      if (isSupportedExtension(entry.name)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}
function matchSimplePattern(filename, pattern) {
  const braceMatch = pattern.match(/^\*\.\{(.+)\}$/);
  if (braceMatch) {
    const extensions = braceMatch[1].split(",").map((e) => `.${e.trim()}`);
    return extensions.some((ext) => filename.endsWith(ext));
  }
  const starMatch = pattern.match(/^\*(\..+)$/);
  if (starMatch) {
    return filename.endsWith(starMatch[1]);
  }
  return filename === pattern;
}
function resolveSourceFiles(projectRoot) {
  const sources = getDocSources(projectRoot);
  const fileSet = /* @__PURE__ */ new Map();
  for (const source of sources) {
    const absoluteSource = resolve(projectRoot, source.path);
    if (source.type === "file") {
      if (!isSupportedExtension(absoluteSource)) continue;
      const cat = source.category || detectCategory(absoluteSource);
      if (!cat) continue;
      const rel = relative3(projectRoot, absoluteSource).replace(/\\/g, "/");
      fileSet.set(rel, { absolutePath: absoluteSource, relativePath: rel, category: cat });
    } else {
      const files = listFilesRecursive(absoluteSource, source.pattern, source.recursive !== 0);
      for (const filePath of files) {
        const cat = source.category || detectCategory(filePath);
        if (!cat) continue;
        const rel = relative3(projectRoot, filePath).replace(/\\/g, "/");
        if (!fileSet.has(rel)) {
          fileSet.set(rel, { absolutePath: filePath, relativePath: rel, category: cat });
        }
      }
    }
  }
  return [...fileSet.values()];
}
var buildDocsIndex = serialized(runBuildDocsIndex);
async function runBuildDocsIndex(projectRoot, provider, options = {}) {
  const { rebuild = false, onProgress, signal } = options;
  if (!provider.isReady()) {
    onProgress?.({ phase: "Initializing embedding model", current: 0, total: 1 });
    await provider.initialize();
  }
  if (rebuild) {
    logger.info("Rebuilding docs index from scratch...");
  }
  prepareDocsVectorIndex(projectRoot, provider.identity, { resetAll: rebuild });
  const files = resolveSourceFiles(projectRoot);
  const totalFiles = files.length;
  onProgress?.({ phase: "Scanning sources", current: 0, total: totalFiles });
  let totalChunks = 0;
  let totalEmbedded = 0;
  let filesProcessed = 0;
  let skipped = 0;
  const errors = [];
  for (let fi = 0; fi < files.length; fi++) {
    if (signal?.aborted) break;
    const { absolutePath, relativePath, category } = files[fi];
    onProgress?.({
      phase: "Indexing docs",
      current: fi + 1,
      total: totalFiles,
      detail: relativePath
    });
    try {
      const stat = statSync3(absolutePath);
      if (stat.size > MAX_FILE_SIZE) {
        skipped++;
        continue;
      }
      const fileMtime = stat.mtime.toISOString();
      if (!rebuild) {
        const indexState = getDocIndexState(projectRoot, relativePath);
        if (indexState && indexState.file_size === stat.size && indexState.file_mtime === fileMtime) {
          skipped++;
          continue;
        }
      }
      try {
        const content = readFileSync4(absolutePath, "utf-8");
        const contentHash = createHash("sha256").update(content).digest("hex");
        insertSnapshot(projectRoot, relativePath, content, contentHash, stat.size);
      } catch (snapErr) {
        logger.error(`Snapshot error for ${relativePath}:`, snapErr);
      }
      clearDocFile(projectRoot, relativePath);
      const { chunks, sections } = chunkFile(absolutePath, relativePath, category);
      if (chunks.length === 0) {
        setDocIndexState(projectRoot, relativePath, stat.size, fileMtime);
        skipped++;
        continue;
      }
      totalChunks += chunks.length;
      if (sections.length > 0) {
        insertDocSections(projectRoot, sections);
      }
      const chunkData = chunks.map((c) => ({
        ...c,
        file_modified: fileMtime
      }));
      for (let i = 0; i < chunkData.length; i += EMBED_BATCH_SIZE2) {
        const batch = chunkData.slice(i, i + EMBED_BATCH_SIZE2);
        const texts = batch.map((c) => c.embed_text);
        const embeddings = await provider.embed(texts);
        const inserted = insertDocChunks(projectRoot, batch, embeddings);
        totalEmbedded += inserted;
      }
      setDocIndexState(projectRoot, relativePath, stat.size, fileMtime);
      filesProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Error processing doc ${relativePath}:`, msg);
      if (errors.length < 5) {
        errors.push(`${relativePath}: ${msg.slice(0, 200)}`);
      }
    }
  }
  try {
    const cleaned = cleanupOldSnapshots(projectRoot, 3);
    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} old snapshot(s)`);
    }
  } catch (cleanErr) {
    logger.error("Snapshot cleanup error:", cleanErr);
  }
  logger.info(
    `Docs indexing complete: ${totalChunks} chunks, ${totalEmbedded} embedded, ${filesProcessed} files, ${skipped} skipped`
  );
  return { totalChunks, totalEmbedded, filesProcessed, skipped, errors };
}

// src/background-index.ts
var SOUVENIR_DIR = getSouvenirDir();
var LOCK_FILE = join6(SOUVENIR_DIR, "bg-index.lock");
var LAST_RUN_FILE = join6(SOUVENIR_DIR, "bg-index.last");
var MIN_INTERVAL_MS = 3e4;
mkdirSync2(SOUVENIR_DIR, { recursive: true });
try {
  const lastRun = parseInt(readFileSync5(LAST_RUN_FILE, "utf-8"), 10);
  if (!isNaN(lastRun) && Date.now() - lastRun < MIN_INTERVAL_MS) {
    process.exit(0);
  }
} catch {
}
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync2(LOCK_FILE, "wx");
      writeSync(fd, String(process.pid));
      closeSync2(fd);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const holder = parseInt(readFileSync5(LOCK_FILE, "utf-8"), 10);
      if (!isNaN(holder) && isRunning(holder)) return false;
      try {
        unlinkSync(LOCK_FILE);
      } catch {
      }
    }
  }
  return false;
}
if (!acquireLock()) {
  process.exit(0);
}
async function run() {
  const archive = await archiveProjects(listProjectDirsOnDisk());
  for (const err of archive.errors) {
    process.stderr.write(`[souvenir] Archive error: ${err}
`);
  }
  if (archive.errors.length > 0) process.exitCode = 1;
  const config = getConfig();
  if (!config.currentProject) {
    return;
  }
  const provider = createEmbeddingProvider(config);
  try {
    await provider.initialize();
    const result = await buildIndex(provider, [config.currentProject], { rebuild: false });
    if (result.totalEmbedded > 0) {
      process.stderr.write(`[souvenir] Background index: ${result.totalEmbedded} new transcript chunks
`);
    }
    const projectRoot = config.cwd;
    if (docsDbExists(projectRoot)) {
      const sources = getDocSources(projectRoot);
      if (sources.length > 0) {
        const docsResult = await buildDocsIndex(projectRoot, provider, { rebuild: false });
        if (docsResult.totalEmbedded > 0) {
          process.stderr.write(`[souvenir] Background index: ${docsResult.totalEmbedded} new doc chunks
`);
        }
      }
    }
  } finally {
    await provider.dispose();
  }
}
run().catch((err) => {
  process.stderr.write(`[souvenir] Background index error: ${err?.message || err}
`);
  process.exitCode = 1;
}).finally(() => {
  writeFileSync(LAST_RUN_FILE, String(Date.now()));
  try {
    unlinkSync(LOCK_FILE);
  } catch {
  }
});
