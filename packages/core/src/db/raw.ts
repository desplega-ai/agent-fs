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
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS content_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_offset INTEGER NOT NULL,
  token_count INTEGER NOT NULL
);
`;

export const VIRTUAL_TABLE_SQL = `
-- FTS5 full-text index (internal content storage)
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  path, content, drive_id UNINDEXED
);

-- sqlite-vec vector index for semantic search (768 dimensions)
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[768]
);
`;
