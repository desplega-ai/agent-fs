import {
  sqliteTable,
  text,
  integer,
  primaryKey,
} from "drizzle-orm/sqlite-core";

// users
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// orgs
export const orgs = sqliteTable("orgs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  isPersonal: integer("is_personal", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// org_members
export const orgMembers = sqliteTable(
  "org_members",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["viewer", "editor", "admin"] }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.orgId, table.userId] }),
  })
);

// drives
export const drives = sqliteTable("drives", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  name: text("name").notNull(),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// drive_members (RBAC per drive)
export const driveMembers = sqliteTable(
  "drive_members",
  {
    driveId: text("drive_id")
      .notNull()
      .references(() => drives.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["viewer", "editor", "admin"] }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.driveId, table.userId] }),
  })
);

// files (current state metadata)
export const files = sqliteTable(
  "files",
  {
    path: text("path").notNull(),
    driveId: text("drive_id")
      .notNull()
      .references(() => drives.id),
    size: integer("size").notNull(),
    contentType: text("content_type"),
    author: text("author").notNull(),
    currentVersionId: text("current_version_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    modifiedAt: integer("modified_at", { mode: "timestamp" }).notNull(),
    isDeleted: integer("is_deleted", { mode: "boolean" })
      .notNull()
      .default(false),
    embeddingStatus: text("embedding_status", {
      enum: ["pending", "indexed", "failed"],
    }).default("pending"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.path, table.driveId] }),
  })
);

// file_versions
// No FK to `files` table — intentional. Files use soft-delete (isDeleted=true),
// so file records are never removed. Version history is preserved even for deleted files.
export const fileVersions = sqliteTable("file_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  path: text("path").notNull(),
  driveId: text("drive_id").notNull(),
  version: integer("version").notNull(),
  s3VersionId: text("s3_version_id").notNull(),
  author: text("author").notNull(),
  operation: text("operation", {
    enum: ["write", "edit", "append", "delete", "revert"],
  }).notNull(),
  message: text("message"),
  diffSummary: text("diff_summary"),
  size: integer("size"),
  etag: text("etag"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// content_chunks (for embedding)
export const contentChunks = sqliteTable("content_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filePath: text("file_path").notNull(),
  driveId: text("drive_id").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  charOffset: integer("char_offset").notNull(),
  tokenCount: integer("token_count").notNull(),
});
