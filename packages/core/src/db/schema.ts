import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// users
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
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
export const fileVersions = sqliteTable(
  "file_versions",
  {
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
    contentHash: text("content_hash"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    pathDriveVersionUq: uniqueIndex(
      "file_versions_path_drive_version_uq"
    ).on(table.path, table.driveId, table.version),
  })
);

// comments (document comments with threading)
export const comments = sqliteTable("comments", {
  id: text("id").primaryKey(),
  parentId: text("parent_id"), // self-ref, NULL = root comment
  orgId: text("org_id")
    .notNull()
    .references(() => orgs.id),
  driveId: text("drive_id")
    .notNull()
    .references(() => drives.id),
  path: text("path").notNull(),
  lineStart: integer("line_start"),
  lineEnd: integer("line_end"),
  quotedContent: text("quoted_content"),
  // Text-quote anchor (exact selection + surrounding context). Nullable:
  // comments created before these columns, or by clients that don't send a
  // quote, fall back to lineStart/lineEnd + quotedContent.
  quoteExact: text("quote_exact"),
  quotePrefix: text("quote_prefix"),
  quoteSuffix: text("quote_suffix"),
  fileVersionId: integer("file_version_id"),
  body: text("body").notNull(),
  author: text("author")
    .notNull()
    .references(() => users.id),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  resolvedBy: text("resolved_by"),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
});

// comment_mentions (targeted comment mentions)
export const commentMentions = sqliteTable(
  "comment_mentions",
  {
    commentId: text("comment_id")
      .notNull()
      .references(() => comments.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.commentId, table.userId] }),
    userIdx: index("idx_comment_mentions_user").on(table.userId),
  })
);

// events (generic event/notification table)
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    type: text("type").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    actor: text("actor")
      .notNull()
      .references(() => users.id),
    target: text("target"),
    status: text("status", { enum: ["created", "ack", "deleted"] })
      .notNull()
      .default("created"),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    notificationInboxIdx: index("idx_events_notification_inbox").on(
      table.orgId,
      table.type,
      table.target,
      table.status,
      table.createdAt
    ),
  })
);

// content_chunks (for embedding)
export const contentChunks = sqliteTable(
  "content_chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    filePath: text("file_path").notNull(),
    driveId: text("drive_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    charOffset: integer("char_offset").notNull(),
    tokenCount: integer("token_count").notNull(),
  },
  (table) => ({
    drivePathIdx: index("idx_content_chunks_drive_path").on(
      table.driveId,
      table.filePath
    ),
  })
);

// shares (public /share/:token links)
// Only the SHA-256 of the token is stored. No FKs on purpose: a share must
// never block deleting a user, drive or org (same reasoning as file_versions).
export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    driveId: text("drive_id").notNull(),
    path: text("path").notNull(),
    /** `file` = one file at `path`; `site` = the folder at `path`, served under /site/<token>/. */
    kind: text("kind", { enum: ["file", "site"] }).notNull().default("file"),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    maxViews: integer("max_views"),
    views: integer("views").notNull().default(0),
    lastViewedAt: integer("last_viewed_at", { mode: "timestamp" }),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("shares_token_hash_uq").on(table.tokenHash),
    drivePathIdx: index("idx_shares_drive_path").on(table.driveId, table.path),
  })
);

// favorites: per-user stars on files and folders. See raw.ts.
export const favorites = sqliteTable(
  "favorites",
  {
    userId: text("user_id").notNull(),
    driveId: text("drive_id").notNull(),
    path: text("path").notNull(),
    kind: text("kind", { enum: ["file", "directory"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.driveId, table.path] }),
    drivePathIdx: index("idx_favorites_drive_path").on(table.driveId, table.path),
  })
);

// share_view_grants: the credential a counted page view of a view-limited
// share hands to that page for its byte fetches (/raw, /download). Only the
// SHA-256 of the grant is stored. No FKs, same reasoning as `shares`.
export const shareViewGrants = sqliteTable(
  "share_view_grants",
  {
    grantHash: text("grant_hash").primaryKey(),
    shareId: text("share_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    shareIdx: index("idx_share_view_grants_share").on(table.shareId),
    expiryIdx: index("idx_share_view_grants_expiry").on(table.expiresAt),
  })
);
