import {
  sqliteTable,
  text,
  integer,
  index,
  primaryKey,
  uniqueIndex,
  unique,
} from "drizzle-orm/sqlite-core";

// users
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name"),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// user_api_keys: additional API keys per user. See raw.ts.
export const userApiKeys = sqliteTable(
  "user_api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    keyHash: text("key_hash").notNull(),
    label: text("label").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    createdByUserId: text("created_by_user_id").notNull(),
    /** Null for a self-minted key; the minting org for an admin-minted one. */
    orgId: text("org_id"),
  },
  (table) => ({
    keyHashUq: uniqueIndex("user_api_keys_key_hash_uq").on(table.keyHash),
    userIdx: index("idx_user_api_keys_user").on(table.userId),
    orgIdx: index("idx_user_api_keys_org").on(table.orgId),
  })
);

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
      enum: ["pending", "indexed", "failed", "skipped"],
    }).default("pending"),
    imageEmbeddingStatus: text("image_embedding_status", {
      enum: ["pending", "indexed", "failed"],
    }),
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

// webhook_subscriptions: outbound webhook endpoints. See raw.ts. Unlike the
// tables above, timestamps are epoch milliseconds (mode "timestamp_ms").
export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id),
    driveId: text("drive_id").references(() => drives.id), // NULL = whole org
    url: text("url").notNull(),
    description: text("description"),
    eventTypes: text("event_types").notNull(), // JSON array, non-empty
    secretCiphertext: text("secret_ciphertext").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    disabledReason: text("disabled_reason", {
      enum: ["gone", "failing", "manual"],
    }),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    failingSince: integer("failing_since", { mode: "timestamp_ms" }),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    lastFailureAt: integer("last_failure_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    orgIdx: index("idx_webhook_subs_org").on(table.orgId, table.enabled),
    driveIdx: index("idx_webhook_subs_drive").on(table.driveId),
  })
);

// webhook_deliveries: the outbox, one row per (subscription, event). See
// raw.ts. Timestamps are epoch milliseconds.
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(), // events.id, sent as webhook-id
    eventType: text("event_type").notNull(),
    payload: text("payload").notNull(), // exact JSON body
    status: text("status", { enum: ["pending", "delivered", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    subEventUq: unique().on(table.subscriptionId, table.eventId),
    dueIdx: index("idx_webhook_deliveries_due").on(table.nextAttemptAt),
    subIdx: index("idx_webhook_deliveries_sub").on(
      table.subscriptionId,
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
    page: integer("page"),
    kind: text("kind", { enum: ["text", "image"] }).notNull().default("text"),
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
    /** A link that never expires; `expires_at` then holds a far-future date. See share.ts. */
    neverExpires: integer("never_expires", { mode: "boolean" }).notNull().default(false),
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

// org_invites: pending invites for emails without an account. See raw.ts.
export const orgInvites = sqliteTable(
  "org_invites",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    /** Trimmed and lowercased. */
    email: text("email").notNull(),
    orgRole: text("org_role", { enum: ["viewer", "editor", "admin"] }).notNull(),
    /** JSON array of { driveId, role }. */
    drives: text("drives").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    acceptedAt: integer("accepted_at", { mode: "timestamp" }),
    acceptedBy: text("accepted_by"),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
  },
  (table) => ({
    tokenHashUq: uniqueIndex("org_invites_token_hash_uq").on(table.tokenHash),
  })
);
