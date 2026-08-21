// Raw SQL for table creation and virtual tables.
// These are idempotent (IF NOT EXISTS) and run on every DB init.

export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_personal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'admin')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS drives (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drive_members (
  drive_id TEXT NOT NULL REFERENCES drives(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('viewer', 'editor', 'admin')),
  PRIMARY KEY (drive_id, user_id)
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT NOT NULL,
  drive_id TEXT NOT NULL REFERENCES drives(id),
  size INTEGER NOT NULL,
  content_type TEXT,
  author TEXT NOT NULL,
  current_version_id TEXT,
  created_at INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  embedding_status TEXT DEFAULT 'pending' CHECK(embedding_status IN ('pending', 'indexed', 'failed')),
  PRIMARY KEY (path, drive_id)
);

CREATE TABLE IF NOT EXISTS file_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  s3_version_id TEXT NOT NULL,
  author TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('write', 'edit', 'append', 'delete', 'revert')),
  message TEXT,
  diff_summary TEXT,
  size INTEGER,
  etag TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS file_versions_path_drive_version_uq
  ON file_versions(path, drive_id, version);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  drive_id TEXT NOT NULL REFERENCES drives(id),
  path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  quoted_content TEXT,
  file_version_id INTEGER REFERENCES file_versions(id),
  body TEXT NOT NULL,
  author TEXT NOT NULL REFERENCES users(id),
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_path ON comments(drive_id, path);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_org ON comments(org_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES users(id),
  target TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created', 'ack', 'deleted')),
  metadata TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_resource ON events(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor);
CREATE INDEX IF NOT EXISTS idx_events_notification_inbox
  ON events(org_id, type, target, status, created_at DESC);

CREATE TABLE IF NOT EXISTS content_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_offset INTEGER NOT NULL,
  token_count INTEGER NOT NULL
);

-- Every write, rm, mv and the embedding job look chunks up by (drive, path).
-- Without this index each of those is a full scan of a table that holds a
-- copy of every indexed file.
CREATE INDEX IF NOT EXISTS idx_content_chunks_drive_path
  ON content_chunks(drive_id, file_path);

-- Content table behind the files_fts external-content index. FTS5 cannot use
-- an equality constraint on a column (only MATCH and rowid), so keying the
-- text here with a unique (drive_id, path) index is what makes delete and
-- upsert O(log n) instead of a scan of the whole index.
CREATE TABLE IF NOT EXISTS files_fts_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drive_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS files_fts_docs_drive_path_uq
  ON files_fts_docs(drive_id, path);

-- Small key/value store for internal bookkeeping (e.g. migration cursors).
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** sqlite-vec vector index for semantic search (768 dimensions). */
export const VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[768]
);
`;

/**
 * FTS5 full-text index as an external-content table over files_fts_docs.
 *
 * The triggers keep the index in sync with the content table, so callers only
 * ever touch files_fts_docs. The 'delete' command needs the old column values
 * to remove the right tokens; the triggers are the one place that always has
 * them.
 *
 * Not applied while a pre-0.13.1 internal-content files_fts table still holds
 * the name: see fts-migration.ts.
 */
export const FTS_SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  path, content, drive_id UNINDEXED,
  content='files_fts_docs', content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS files_fts_docs_ai AFTER INSERT ON files_fts_docs BEGIN
  INSERT INTO files_fts(rowid, path, content, drive_id)
    VALUES (new.id, new.path, new.content, new.drive_id);
END;

CREATE TRIGGER IF NOT EXISTS files_fts_docs_ad AFTER DELETE ON files_fts_docs BEGIN
  INSERT INTO files_fts(files_fts, rowid, path, content, drive_id)
    VALUES ('delete', old.id, old.path, old.content, old.drive_id);
END;

CREATE TRIGGER IF NOT EXISTS files_fts_docs_au AFTER UPDATE ON files_fts_docs BEGIN
  INSERT INTO files_fts(files_fts, rowid, path, content, drive_id)
    VALUES ('delete', old.id, old.path, old.content, old.drive_id);
  INSERT INTO files_fts(rowid, path, content, drive_id)
    VALUES (new.id, new.path, new.content, new.drive_id);
END;
`;

/** Every virtual-table object, for fresh databases and tests. */
export const VIRTUAL_TABLE_SQL = VEC_TABLE_SQL + FTS_SCHEMA_SQL;
