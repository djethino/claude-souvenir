import { createRequire as __souvenirCreateRequire } from 'module';
const require = __souvenirCreateRequire(import.meta.url);

// src/background-index.ts
import { existsSync as existsSync5, readFileSync as readFileSync4, writeSync, mkdirSync as mkdirSync2, unlinkSync, openSync as openSync2, closeSync as closeSync2 } from "fs";
import { join as join6 } from "path";

// src/utils/paths.ts
import { homedir } from "os";
import { join, sep } from "path";
function getClaudeDir() {
  return process.env.SOUVENIR_CLAUDE_DIR || join(homedir(), ".claude");
}
function getProjectsDir() {
  return join(getClaudeDir(), "projects");
}
function getSouvenirDir() {
  return join(getClaudeDir(), "ASymptOmatik", "souvenir");
}
function getDbPath() {
  return process.env.SOUVENIR_DB_PATH || join(getSouvenirDir(), "souvenir.db");
}
function cwdToProjectDir(cwd2) {
  const cleaned = cwd2.replace(/[\\/]+$/, "");
  return cleaned.replace(/:/g, "-").replace(/[\\/]/g, "-");
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
  const message = args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
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
  const cwd2 = process.env.CWD || process.cwd();
  const provider = process.env.SOUVENIR_PROVIDER || "ollama";
  const detectedProject = resolvePathToProject(cwd2);
  if (detectedProject) {
    logger.info(`Detected project from CWD: ${detectedProject}`);
  } else {
    logger.info(`CWD "${cwd2}" did not match any project. Waiting for MCP roots.`);
  }
  _config = {
    cwd: cwd2,
    currentProject: detectedProject,
    embeddingProvider: provider,
    openaiApiKey: process.env.SOUVENIR_OPENAI_API_KEY || null,
    embeddingDimensions: parseInt(process.env.SOUVENIR_EMBEDDING_DIMENSIONS || "768", 10),
    ollamaUrl: process.env.SOUVENIR_OLLAMA_URL || "http://localhost:11434",
    ollamaModel: process.env.SOUVENIR_OLLAMA_MODEL || "embeddinggemma"
  };
  return _config;
}

// src/embedding/ollama.ts
var DEFAULT_BASE_URL = "http://localhost:11434";
var DEFAULT_MODEL = "embeddinggemma";
var DIMENSIONS = 768;
var MAX_BATCH_SIZE = 64;
var REQUEST_TIMEOUT_MS = 12e4;
var DOCUMENT_PREFIX = "title: none | text: ";
var QUERY_PREFIX = "task: search result | query: ";
var OllamaEmbeddingProvider = class {
  name;
  dimensions = DIMENSIONS;
  baseUrl;
  model;
  ready = false;
  constructor(baseUrl, model) {
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = model || DEFAULT_MODEL;
    this.name = `ollama (${this.model})`;
  }
  isReady() {
    return this.ready;
  }
  async initialize() {
    if (this.ready) return;
    logger.info(`Connecting to Ollama at ${this.baseUrl}...`);
    const isRunning = await this.checkOllamaRunning();
    if (!isRunning) {
      throw new Error(
        `Ollama is not running at ${this.baseUrl}. Start it with "ollama serve" or install from https://ollama.com`
      );
    }
    const hasModel = await this.checkModelAvailable();
    if (!hasModel) {
      logger.info(`Model "${this.model}" not found. Pulling...`);
      await this.pullModel();
      logger.info(`Model "${this.model}" pulled successfully.`);
    }
    this.ready = true;
    logger.info(`Ollama embedding provider ready (model: ${this.model}, ${DIMENSIONS}d)`);
  }
  async embed(texts) {
    if (!this.ready) await this.initialize();
    const allResults = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);
      const prefixed = batch.map((t) => DOCUMENT_PREFIX + t);
      const embeddings = await this.callEmbed(prefixed);
      allResults.push(...embeddings);
    }
    return allResults;
  }
  async embedQuery(text) {
    if (!this.ready) await this.initialize();
    const prefixed = QUERY_PREFIX + text;
    const [result] = await this.callEmbed([prefixed]);
    return result;
  }
  async dispose() {
    this.ready = false;
  }
  // ── Private helpers ──────────────────────────────────────────────────────
  async checkOllamaRunning() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5e3)
      });
      return response.ok;
    } catch {
      return false;
    }
  }
  async checkModelAvailable() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5e3)
      });
      if (!response.ok) return false;
      const data = await response.json();
      if (!data.models) return false;
      return data.models.some(
        (m) => m.name === this.model || m.name === `${this.model}:latest`
      );
    } catch {
      return false;
    }
  }
  async pullModel() {
    try {
      const response = await fetch(`${this.baseUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.model, stream: false }),
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
        `Failed to pull model "${this.model}" from Ollama. Ensure Ollama is running and try manually: ollama pull ${this.model}
Error: ${err instanceof Error ? err.message : err}`
      );
    }
  }
  async callEmbed(texts, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            input: texts
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) {
          const errText = await response.text();
          if (response.status === 404 && attempt === 0) {
            logger.warn(`Model "${this.model}" not loaded. Attempting pull...`);
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
        return data.embeddings.map((emb) => new Float32Array(emb));
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
var MODEL = "text-embedding-3-small";
var DEFAULT_DIMENSIONS = 768;
var API_URL = "https://api.openai.com/v1/embeddings";
var MAX_BATCH_SIZE2 = 100;
var OpenAIEmbeddingProvider = class {
  name = `openai (${MODEL})`;
  dimensions;
  apiKey;
  ready = false;
  constructor(apiKey, dimensions) {
    this.apiKey = apiKey;
    this.dimensions = dimensions || DEFAULT_DIMENSIONS;
  }
  isReady() {
    return this.ready;
  }
  async initialize() {
    if (this.ready) return;
    if (!this.apiKey) {
      throw new Error(
        "OpenAI embedding provider requires SOUVENIR_OPENAI_API_KEY environment variable."
      );
    }
    logger.info("Validating OpenAI API key...");
    try {
      await this.callApi(["test"]);
      this.ready = true;
      logger.info("OpenAI embedding provider ready");
    } catch (err) {
      throw new Error(`OpenAI API validation failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  async embed(texts) {
    if (!this.ready) await this.initialize();
    const allResults = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE2) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE2);
      const embeddings = await this.callApi(batch);
      allResults.push(...embeddings);
    }
    return allResults;
  }
  async embedQuery(text) {
    const [result] = await this.embed([text]);
    return result;
  }
  async dispose() {
    this.ready = false;
  }
  async callApi(texts, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: MODEL,
            input: texts,
            dimensions: this.dimensions
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
          throw new Error(`OpenAI API error (${response.status}): ${error}`);
        }
        const data = await response.json();
        const sorted = data.data.sort((a, b) => a.index - b.index);
        return sorted.map((d) => new Float32Array(d.embedding));
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
  switch (config.embeddingProvider) {
    case "ollama":
      return new OllamaEmbeddingProvider(config.ollamaUrl, config.ollamaModel);
    case "openai":
      if (!config.openaiApiKey) {
        throw new Error(
          "OpenAI provider requires SOUVENIR_OPENAI_API_KEY environment variable. Set it in your .mcp.json env section or system environment."
        );
      }
      return new OpenAIEmbeddingProvider(config.openaiApiKey, config.embeddingDimensions);
    default:
      throw new Error(`Unknown embedding provider: "${config.embeddingProvider}". Use "ollama" or "openai".`);
  }
}

// src/db/indexer.ts
import { statSync as statSync2 } from "fs";
import { basename as basename2 } from "path";

// src/transcript/discovery.ts
import { readFileSync, readdirSync, existsSync as existsSync2, statSync, openSync, readSync, closeSync } from "fs";
import { join as join3, basename } from "path";
function listTranscriptFiles(projectDir, options = {}) {
  const dir = getProjectTranscriptDir(projectDir);
  if (!existsSync2(dir)) return [];
  const mainFiles = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join3(dir, f));
  if (!options.includeSubagents) return mainFiles;
  const subagentFiles = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.match(/^[0-9a-f]{8}-/)) continue;
    if (options.sessionId && entry.name !== options.sessionId) continue;
    const subagentDir = join3(dir, entry.name, "subagents");
    if (!existsSync2(subagentDir)) continue;
    try {
      const agentFiles = readdirSync(subagentDir).filter((f) => {
        if (!f.endsWith(".jsonl")) return false;
        if (f.includes("aprompt_suggestion")) return false;
        return true;
      }).map((f) => join3(subagentDir, f));
      subagentFiles.push(...agentFiles);
    } catch (err) {
      logger.debug(`Error reading subagents for ${entry.name}:`, err);
    }
  }
  return [...mainFiles, ...subagentFiles];
}

// src/transcript/parser.ts
import { createReadStream } from "fs";
import { createInterface } from "readline";
var SKIP_TYPE = '"file-history-snapshot"';
async function* parseTranscript(filePath, options = {}) {
  const {
    includeTypes = ["user", "assistant", "summary"],
    fromLine = 1,
    maxEntries,
    containsText,
    caseInsensitive = true
  } = options;
  const searchText = containsText && caseInsensitive ? containsText.toLowerCase() : containsText;
  let lineNumber = 0;
  let yielded = 0;
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      lineNumber++;
      if (lineNumber < fromLine) continue;
      if (maxEntries && yielded >= maxEntries) break;
      if (!line.trim()) continue;
      if (line.includes(SKIP_TYPE)) continue;
      if (searchText) {
        const haystack = caseInsensitive ? line.toLowerCase() : line;
        if (!haystack.includes(searchText)) continue;
      }
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        logger.debug(`Skipping corrupt line ${lineNumber} in ${filePath}`);
        continue;
      }
      if (!includeTypes.includes(entry.type)) continue;
      yielded++;
      yield { entry, lineNumber, rawLength: line.length };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
function extractText(entry) {
  switch (entry.type) {
    case "user": {
      const user = entry;
      if (typeof user.message.content === "string") {
        return user.message.content;
      }
      return user.message.content.map((block) => {
        if ("text" in block) return block.text;
        if ("content" in block) return block.content;
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

// src/embedding/chunker.ts
var MAX_EMBED_CHARS = 1600;
var MAX_CONTENT_CHARS = 2e3;
function truncateForEmbed(text, maxChars) {
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastSpace = truncated.lastIndexOf(" ");
  return lastSpace > maxChars * 0.7 ? truncated.slice(0, lastSpace) : truncated;
}
async function chunkTranscript(filePath, sessionId, projectDir, options = {}) {
  const chunks = [];
  let lastLine = 0;
  const entries = [];
  const stream = parseTranscript(filePath, {
    includeTypes: ["user", "assistant", "summary"],
    fromLine: options.fromLine
  });
  for await (const parsed of stream) {
    entries.push(parsed);
    lastLine = Math.max(lastLine, parsed.lineNumber);
  }
  let i = 0;
  while (i < entries.length) {
    const current = entries[i];
    const entry = current.entry;
    if (entry.type === "summary") {
      const text = entry.summary || "";
      if (text.trim()) {
        chunks.push({
          session_id: sessionId,
          project_dir: projectDir,
          entry_uuid: entry.uuid,
          role: "summary",
          content_text: truncateForEmbed(text, MAX_CONTENT_CHARS),
          embed_text: truncateForEmbed(text, MAX_EMBED_CHARS),
          timestamp: entry.timestamp,
          line_number: current.lineNumber
        });
      }
      i++;
      continue;
    }
    if (entry.type === "user") {
      const userText = extractText(entry);
      let turnText = userText;
      let contentParts = [`USER: ${userText}`];
      if (i + 1 < entries.length && entries[i + 1].entry.type === "assistant") {
        const assistantEntry = entries[i + 1].entry;
        const assistantText = extractText(assistantEntry);
        turnText += "\n" + assistantText;
        contentParts.push(`ASSISTANT: ${assistantText}`);
        i++;
      }
      if (turnText.trim()) {
        chunks.push({
          session_id: sessionId,
          project_dir: projectDir,
          entry_uuid: entry.uuid,
          role: "turn",
          content_text: truncateForEmbed(contentParts.join("\n"), MAX_CONTENT_CHARS),
          embed_text: truncateForEmbed(turnText, MAX_EMBED_CHARS),
          timestamp: entry.timestamp,
          line_number: current.lineNumber
        });
      }
      i++;
      continue;
    }
    if (entry.type === "assistant") {
      const text = extractText(entry);
      if (text.trim()) {
        chunks.push({
          session_id: sessionId,
          project_dir: projectDir,
          entry_uuid: entry.uuid,
          role: "assistant",
          content_text: truncateForEmbed(`ASSISTANT: ${text}`, MAX_CONTENT_CHARS),
          embed_text: truncateForEmbed(text, MAX_EMBED_CHARS),
          timestamp: entry.timestamp,
          line_number: current.lineNumber
        });
      }
      i++;
      continue;
    }
    i++;
  }
  logger.debug(`Chunked ${filePath}: ${entries.length} entries -> ${chunks.length} chunks`);
  return { chunks, lastLine };
}

// src/db/schema.ts
var SCHEMA_VERSION = 1;
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
    embed_text TEXT NOT NULL,
    timestamp TEXT,
    line_number INTEGER,
    UNIQUE(session_id, line_number)
  );

  CREATE TABLE IF NOT EXISTS index_state (
    file_path TEXT PRIMARY KEY,
    file_size INTEGER NOT NULL,
    last_line INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
  CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_dir);
  CREATE INDEX IF NOT EXISTS idx_chunks_role ON chunks(role);
  CREATE INDEX IF NOT EXISTS idx_chunks_timestamp ON chunks(timestamp);
`;
function createVecTable(dimensions) {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0 (
    chunk_id INTEGER PRIMARY KEY,
    embedding float[${dimensions}] distance_metric=cosine
  );`;
}

// src/db/sqlite.ts
import { createRequire } from "module";
import { existsSync as existsSync3, mkdirSync } from "fs";
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
      `claude-souvenir requires Node.js >= ${MIN_NODE.join(".")} (built-in node:sqlite), found ${process.versions.node}`
    );
  }
}
function sqliteVecPath() {
  const platform = `${process.platform}-${process.arch}`;
  const relative2 = VEC_BINARIES[platform];
  if (!relative2) {
    throw new Error(
      `claude-souvenir: no sqlite-vec binary for ${platform} (supported: ${Object.keys(VEC_BINARIES).join(", ")})`
    );
  }
  const path = fileURLToPath(new URL(`../vendor/sqlite-vec/bin/${relative2}`, import.meta.url));
  if (!existsSync3(path)) {
    throw new Error(`claude-souvenir: sqlite-vec binary missing at ${path}`);
  }
  return path;
}
function openDatabase(dbPath, label) {
  assertNodeVersion();
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const dir = dirname(dbPath);
  if (!existsSync3(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  logger.info(`Opening ${label} database at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.loadExtension(sqliteVecPath());
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
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
function vectorBlob(vector) {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

// src/db/store.ts
var _db = null;
var _dimensions = 768;
function getDb(dimensions) {
  if (_db) return _db;
  if (dimensions) _dimensions = dimensions;
  _db = openDatabase(getDbPath(), "transcripts");
  _db.exec(CREATE_TABLES);
  _db.exec(createVecTable(_dimensions));
  _db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(SCHEMA_VERSION)
  );
  logger.info("Database initialized");
  return _db;
}
function insertChunks(chunks, embeddings) {
  const db = getDb();
  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk count (${chunks.length}) doesn't match embedding count (${embeddings.length})`);
  }
  const insertChunk = db.prepare(`
    INSERT OR IGNORE INTO chunks (session_id, project_dir, entry_uuid, role, content_text, embed_text, timestamp, line_number)
    VALUES (@session_id, @project_dir, @entry_uuid, @role, @content_text, @embed_text, @timestamp, @line_number)
  `);
  const insertVec = db.prepare(`
    INSERT OR IGNORE INTO vec_chunks (chunk_id, embedding)
    VALUES (?, ?)
  `);
  let inserted = 0;
  inTransaction(db, () => {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = insertChunk.run({
        session_id: chunk.session_id,
        project_dir: chunk.project_dir,
        entry_uuid: chunk.entry_uuid || null,
        role: chunk.role || null,
        content_text: chunk.content_text,
        embed_text: chunk.embed_text,
        timestamp: chunk.timestamp || null,
        line_number: chunk.line_number ?? null
      });
      if (result.changes > 0) {
        insertVec.run(BigInt(result.lastInsertRowid), vectorBlob(embeddings[i]));
        inserted++;
      }
    }
  });
  return inserted;
}
function getIndexState(filePath) {
  const db = getDb();
  return getRow(db, "SELECT * FROM index_state WHERE file_path = ?", filePath);
}
function setIndexState(filePath, fileSize, lastLine) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO index_state (file_path, file_size, last_line, indexed_at)
    VALUES (?, ?, ?, ?)
  `).run(filePath, fileSize, lastLine, (/* @__PURE__ */ new Date()).toISOString());
}
function clearProject(projectDir) {
  const db = getDb();
  inTransaction(db, () => {
    const chunkIds = db.prepare("SELECT chunk_id FROM chunks WHERE project_dir = ?").all(projectDir);
    for (const { chunk_id } of chunkIds) {
      db.prepare("DELETE FROM vec_chunks WHERE chunk_id = ?").run(BigInt(chunk_id));
    }
    db.prepare("DELETE FROM chunks WHERE project_dir = ?").run(projectDir);
    db.prepare("DELETE FROM index_state WHERE file_path LIKE ?").run(`%${projectDir}%`);
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
function getStoredProvider() {
  const db = getDb();
  const name = db.prepare("SELECT value FROM metadata WHERE key = ?").get("embedding_provider");
  const dims = db.prepare("SELECT value FROM metadata WHERE key = ?").get("embedding_dimensions");
  if (!name || !dims) return null;
  return { name: name.value, dimensions: parseInt(dims.value, 10) };
}
function setStoredProvider(name, dimensions) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run("embedding_provider", name);
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run("embedding_dimensions", String(dimensions));
}

// src/db/indexer.ts
var EMBED_BATCH_SIZE = 32;
async function buildIndex(provider, projectDirs, options = {}) {
  const { sessionId, includeSubagents = true, rebuild = false, onProgress, signal } = options;
  getDb(provider.dimensions);
  const storedProvider = getStoredProvider();
  if (storedProvider && !rebuild) {
    if (storedProvider.dimensions !== provider.dimensions) {
      throw new Error(
        `Embedding dimensions mismatch: index was built with ${storedProvider.dimensions}d but current provider uses ${provider.dimensions}d. Use action="rebuild" to re-index with the new provider.`
      );
    }
  }
  if (!provider.isReady()) {
    onProgress?.({ phase: "Initializing embedding model", current: 0, total: 1 });
    await provider.initialize();
  }
  if (rebuild) {
    logger.info("Rebuilding index from scratch...");
    for (const dir of projectDirs) {
      clearProject(dir);
    }
  }
  setStoredProvider(provider.name, provider.dimensions);
  let totalChunks = 0;
  let totalEmbedded = 0;
  let filesProcessed = 0;
  let skipped = 0;
  const errors = [];
  for (const projectDir of projectDirs) {
    let files = listTranscriptFiles(projectDir, {
      includeSubagents,
      sessionId
    });
    if (sessionId && !includeSubagents) {
      files = files.filter((f) => basename2(f, ".jsonl") === sessionId);
    }
    const totalFiles = files.length;
    onProgress?.({ phase: `Processing ${projectDir}`, current: 0, total: totalFiles });
    for (let fi = 0; fi < files.length; fi++) {
      if (signal?.aborted) break;
      const filePath = files[fi];
      const fileSessionId = basename2(filePath, ".jsonl");
      onProgress?.({
        phase: `Processing ${projectDir}`,
        current: fi + 1,
        total: totalFiles,
        detail: `Session ${fileSessionId.slice(0, 8)}...`
      });
      try {
        const stat = statSync2(filePath);
        const indexState = getIndexState(filePath);
        if (indexState && !rebuild) {
          if (indexState.file_size === stat.size) {
            skipped++;
            continue;
          }
        }
        const fromLine = !rebuild && indexState ? indexState.last_line + 1 : 1;
        const { chunks, lastLine } = await chunkTranscript(
          filePath,
          fileSessionId,
          projectDir,
          { fromLine }
        );
        if (chunks.length === 0) {
          setIndexState(filePath, stat.size, lastLine || fromLine);
          skipped++;
          continue;
        }
        totalChunks += chunks.length;
        for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
          const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
          const texts = batch.map((c) => c.embed_text);
          const embeddings = await provider.embed(texts);
          const inserted = insertChunks(batch, embeddings);
          totalEmbedded += inserted;
        }
        setIndexState(filePath, stat.size, lastLine);
        filesProcessed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Error processing ${filePath}:`, msg);
        if (errors.length < 5) {
          errors.push(`${basename2(filePath, ".jsonl").slice(0, 8)}...: ${msg.slice(0, 200)}`);
        }
      }
    }
  }
  logger.info(`Indexing complete: ${totalChunks} chunks, ${totalEmbedded} embedded, ${filesProcessed} files, ${skipped} skipped`);
  return { totalChunks, totalEmbedded, filesProcessed, skipped, errors };
}

// src/docs/indexer.ts
import { statSync as statSync3, readdirSync as readdirSync2, readFileSync as readFileSync3 } from "fs";
import { join as join5, relative, resolve as resolve2 } from "path";
import { createHash } from "crypto";

// src/docs/chunker.ts
import { readFileSync as readFileSync2 } from "fs";
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
var MAX_EMBED_CHARS2 = 1600;
var MAX_CONTENT_CHARS2 = 2e3;
var MAX_CHUNK_LINES = 80;
var MIN_CHUNK_LINES = 5;
function truncateForEmbed2(text, maxChars) {
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
        content_text: truncateForEmbed2(content, MAX_CONTENT_CHARS2),
        embed_text: truncateForEmbed2(`[${relativePath}]
${content}`, MAX_EMBED_CHARS2),
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
        content_text: truncateForEmbed2(preContent, MAX_CONTENT_CHARS2),
        embed_text: truncateForEmbed2(`[${relativePath}]
${preContent}`, MAX_EMBED_CHARS2),
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
    if (sectionContent.length > MAX_CONTENT_CHARS2) {
      const subChunks = splitAtParagraphs(sectionLines, startLine, relativePath, "doc", sectionPath);
      chunks.push(...subChunks);
    } else {
      chunks.push({
        file_path: relativePath,
        category: "doc",
        content_text: truncateForEmbed2(sectionContent, MAX_CONTENT_CHARS2),
        embed_text: truncateForEmbed2(`[${sectionPath}]
${sectionContent}`, MAX_EMBED_CHARS2),
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
        content_text: truncateForEmbed2(content, MAX_CONTENT_CHARS2),
        embed_text: truncateForEmbed2(`[${relativePath}]
${content}`, MAX_EMBED_CHARS2),
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
        content_text: truncateForEmbed2(content, MAX_CONTENT_CHARS2),
        embed_text: truncateForEmbed2(`[${relativePath}:${chunkStart + 1}-${chunkEnd}]
${content}`, MAX_EMBED_CHARS2),
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
  if (content.length <= MAX_CONTENT_CHARS2) {
    chunks.push({
      file_path: relativePath,
      category: "config",
      content_text: truncateForEmbed2(content, MAX_CONTENT_CHARS2),
      embed_text: truncateForEmbed2(`[config: ${relativePath}]
${content}`, MAX_EMBED_CHARS2),
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
    if (blockContent.length >= MAX_CONTENT_CHARS2 * 0.8 && lines[i].trim() === "") {
      if (blockContent.trim()) {
        chunks.push({
          file_path: relativePath,
          category,
          content_text: truncateForEmbed2(blockContent, MAX_CONTENT_CHARS2),
          embed_text: truncateForEmbed2(
            sectionPath ? `[${sectionPath}]
${blockContent}` : `[${relativePath}]
${blockContent}`,
            MAX_EMBED_CHARS2
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
        content_text: truncateForEmbed2(remaining, MAX_CONTENT_CHARS2),
        embed_text: truncateForEmbed2(
          sectionPath ? `[${sectionPath}]
${remaining}` : `[${relativePath}]
${remaining}`,
          MAX_EMBED_CHARS2
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
  const content = readFileSync2(filePath, "utf-8");
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
var DOCS_SCHEMA_VERSION = 2;
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
function createDocsVecTable(dimensions) {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS vec_doc_chunks USING vec0 (
    chunk_id INTEGER PRIMARY KEY,
    embedding float[${dimensions}] distance_metric=cosine
  );`;
}

// src/docs/store.ts
var _docsDb = null;
var _docsDbPath = null;
var _docsDimensions = 768;
function getLocalDocsDbPath(projectRoot) {
  return join4(projectRoot, ".claude", "ASymptOmatik", "souvenir", "docs.db");
}
function getDocsDb(projectRoot, dimensions) {
  const dbPath = getLocalDocsDbPath(projectRoot);
  if (_docsDb && _docsDbPath === dbPath) return _docsDb;
  if (_docsDb) {
    _docsDb.close();
    _docsDb = null;
    _docsDbPath = null;
  }
  if (dimensions) _docsDimensions = dimensions;
  _docsDb = openDatabase(dbPath, "docs");
  _docsDbPath = dbPath;
  _docsDb.exec(DOCS_CREATE_TABLES);
  _docsDb.exec(createDocsVecTable(_docsDimensions));
  _docsDb.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(
    "schema_version",
    String(DOCS_SCHEMA_VERSION)
  );
  logger.info("Docs database initialized");
  return _docsDb;
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
    INSERT OR IGNORE INTO vec_doc_chunks (chunk_id, embedding)
    VALUES (?, ?)
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
        insertVec.run(BigInt(result.lastInsertRowid), vectorBlob(embeddings[i]));
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
    for (const { chunk_id } of chunkIds) {
      db.prepare("DELETE FROM vec_doc_chunks WHERE chunk_id = ?").run(BigInt(chunk_id));
    }
    db.prepare("DELETE FROM doc_chunks WHERE file_path = ?").run(filePath);
    db.prepare("DELETE FROM doc_sections WHERE file_path = ?").run(filePath);
    db.prepare("DELETE FROM doc_index_state WHERE file_path = ?").run(filePath);
  });
}
function clearAllDocs(projectRoot) {
  const db = getDocsDb(projectRoot);
  inTransaction(db, () => {
    db.prepare("DELETE FROM vec_doc_chunks").run();
    db.prepare("DELETE FROM doc_chunks").run();
    db.prepare("DELETE FROM doc_sections").run();
    db.prepare("DELETE FROM doc_index_state").run();
  });
  docsIncrementalVacuum(projectRoot);
}
function docsIncrementalVacuum(projectRoot) {
  try {
    const db = getDocsDb(projectRoot);
    db.exec("PRAGMA incremental_vacuum");
  } catch (err) {
    logger.error("Docs incremental vacuum error:", err);
  }
}
function getDocsStoredProvider(projectRoot) {
  const db = getDocsDb(projectRoot);
  const name = db.prepare("SELECT value FROM metadata WHERE key = ?").get("embedding_provider");
  const dims = db.prepare("SELECT value FROM metadata WHERE key = ?").get("embedding_dimensions");
  if (!name || !dims) return null;
  return { name: name.value, dimensions: parseInt(dims.value, 10) };
}
function setDocsStoredProvider(projectRoot, name, dimensions) {
  const db = getDocsDb(projectRoot);
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run("embedding_provider", name);
  db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run("embedding_dimensions", String(dimensions));
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
    const absoluteSource = resolve2(projectRoot, source.path);
    if (source.type === "file") {
      if (!isSupportedExtension(absoluteSource)) continue;
      const cat = source.category || detectCategory(absoluteSource);
      if (!cat) continue;
      const rel = relative(projectRoot, absoluteSource).replace(/\\/g, "/");
      fileSet.set(rel, { absolutePath: absoluteSource, relativePath: rel, category: cat });
    } else {
      const files = listFilesRecursive(absoluteSource, source.pattern, source.recursive !== 0);
      for (const filePath of files) {
        const cat = source.category || detectCategory(filePath);
        if (!cat) continue;
        const rel = relative(projectRoot, filePath).replace(/\\/g, "/");
        if (!fileSet.has(rel)) {
          fileSet.set(rel, { absolutePath: filePath, relativePath: rel, category: cat });
        }
      }
    }
  }
  return [...fileSet.values()];
}
async function buildDocsIndex(projectRoot, provider, options = {}) {
  const { rebuild = false, onProgress, signal } = options;
  getDocsDb(projectRoot, provider.dimensions);
  const storedProvider = getDocsStoredProvider(projectRoot);
  if (storedProvider && !rebuild) {
    if (storedProvider.dimensions !== provider.dimensions) {
      throw new Error(
        `Embedding dimensions mismatch: docs index was built with ${storedProvider.dimensions}d but current provider uses ${provider.dimensions}d. Rebuild the docs index.`
      );
    }
  }
  if (!provider.isReady()) {
    onProgress?.({ phase: "Initializing embedding model", current: 0, total: 1 });
    await provider.initialize();
  }
  if (rebuild) {
    logger.info("Rebuilding docs index from scratch...");
    clearAllDocs(projectRoot);
  }
  setDocsStoredProvider(projectRoot, provider.name, provider.dimensions);
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
        const content = readFileSync3(absolutePath, "utf-8");
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
var MIN_INTERVAL_MS = 3e4;
mkdirSync2(SOUVENIR_DIR, { recursive: true });
try {
  if (existsSync5(LOCK_FILE)) {
    const content = readFileSync4(LOCK_FILE, "utf-8").trim();
    const lastRun = parseInt(content, 10);
    if (!isNaN(lastRun) && Date.now() - lastRun < MIN_INTERVAL_MS) {
      process.exit(0);
    }
    try {
      unlinkSync(LOCK_FILE);
    } catch {
    }
  }
} catch {
}
try {
  const fd = openSync2(LOCK_FILE, "wx");
  writeSync(fd, String(Date.now()));
  closeSync2(fd);
} catch (err) {
  if (err.code === "EEXIST") {
    process.exit(0);
  }
}
var cwd;
try {
  const data = JSON.parse(readFileSync4(0, "utf-8"));
  cwd = data.cwd;
} catch {
  cwd = process.cwd();
}
if (!cwd) {
  process.exit(0);
}
process.env.CWD = cwd;
async function run() {
  const config = getConfig();
  if (!config.currentProject) {
    return;
  }
  const provider = createEmbeddingProvider(config);
  try {
    await provider.initialize();
    const result = await buildIndex(provider, [config.currentProject], { rebuild: false });
    if (result.totalEmbedded > 0) {
      process.stderr.write(`[claude-souvenir] Background index: ${result.totalEmbedded} new transcript chunks
`);
    }
    const projectRoot = config.cwd;
    if (projectRoot && docsDbExists(projectRoot)) {
      const sources = getDocSources(projectRoot);
      if (sources.length > 0) {
        const docsResult = await buildDocsIndex(projectRoot, provider, { rebuild: false });
        if (docsResult.totalEmbedded > 0) {
          process.stderr.write(`[claude-souvenir] Background index: ${docsResult.totalEmbedded} new doc chunks
`);
        }
      }
    }
  } finally {
    await provider.dispose();
  }
}
run().catch((err) => {
  process.stderr.write(`[claude-souvenir] Background index error: ${err?.message || err}
`);
}).finally(() => {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
  }
});
