//! IPC client to the Bun daemon over a Unix socket.
//!
//! Wire format: 4-byte big-endian u32 length prefix + msgpack body.
//! Requests carry a `u64 request_id`; responses are multiplexed back to the
//! waiting caller via a `oneshot::Sender` map. A single connection per helper
//! process; reconnect with exponential backoff capped at 1 s on disconnect.
//!
//! Public surface is intentionally async + trait-based (`Ipc`) so the FUSE
//! filesystem can be unit-tested with a `MockIpc` and the integration tests
//! can drive a stub Unix server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::sync::{oneshot, Mutex};
use tokio::time::sleep;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Drive descriptor returned by `ListDrives`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DriveInfo {
    pub slug: String,
    pub id: String,
    pub org_id: String,
}

/// File / directory entry returned by `ReadDir`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub kind: NodeKind,
    pub size: u64,
    pub mtime_unix: i64,
    pub version: Option<u64>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum NodeKind {
    File,
    Dir,
    Symlink,
}

/// File attribute snapshot returned by `GetAttr`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttrInfo {
    pub kind: NodeKind,
    pub size: u64,
    pub mtime_unix: i64,
    pub version: Option<u64>,
    pub content_hash: Option<String>,
}

// ---------------------------------------------------------------------------
// Request / response envelope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Hello {
        client_version: String,
        pid: u32,
    },
    Ping,
    ListDrives,
    DefaultDriveSlug,
    GetAttr {
        drive: String,
        path: String,
    },
    ReadDir {
        drive: String,
        path: String,
    },
    OpenRead {
        drive: String,
        path: String,
    },
    OpenWrite {
        drive: String,
        path: String,
        base_version: Option<u64>,
        content_hash: String,
        bytes: Vec<u8>,
    },
    CreateFile {
        drive: String,
        path: String,
    },
    Truncate {
        drive: String,
        path: String,
        size: u64,
    },
    Unlink {
        drive: String,
        path: String,
    },
    Rename {
        drive: String,
        from_path: String,
        to_drive: String,
        to_path: String,
    },
    Mkdir {
        drive: String,
        path: String,
    },
    Rmdir {
        drive: String,
        path: String,
    },
    RecordConflict {
        drive: String,
        path: String,
        base_version: u64,
        head_version: u64,
        base_hash: String,
        attempted_hash: String,
        bytes: u64,
    },
    WriteStatus {
        line: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Response {
    Ok,
    Pong,
    Drives(Vec<DriveInfo>),
    DefaultDriveSlug(Option<String>),
    Attr(AttrInfo),
    DirEntries(Vec<DirEntry>),
    OpenRead {
        bytes: Vec<u8>,
        version: u64,
        content_hash: String,
        size: u64,
        mtime_unix: i64,
    },
    OpenWrite {
        version: u64,
        content_hash: String,
        deduped: bool,
    },
    Error {
        http_status: u16,
        code: Option<String>,
        message: String,
    },
}

/// Frame on the wire: `{ id, body }`.
///
/// The id is mirrored back in the response so the multiplexer can route it.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope<T> {
    id: u64,
    body: T,
}

// ---------------------------------------------------------------------------
// Client trait + impls
// ---------------------------------------------------------------------------

// IPC surface the FUSE filesystem depends on is defined in `ipc_trait` below
// using a hand-rolled `Pin<Box<dyn Future…>>` signature so we don't have to
// pull in the `async-trait` crate. Re-exported as `IpcTrait` for callers.

// ---------------------------------------------------------------------------
// Concrete client over a Unix socket
// ---------------------------------------------------------------------------

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>;

#[derive(Clone)]
pub struct UnixIpcClient {
    inner: Arc<UnixIpcInner>,
}

struct UnixIpcInner {
    socket_path: PathBuf,
    next_id: std::sync::atomic::AtomicU64,
    write_half: Arc<Mutex<Option<tokio::net::unix::OwnedWriteHalf>>>,
    pending: Pending,
}

impl UnixIpcClient {
    pub fn new(socket_path: impl AsRef<Path>) -> Self {
        Self {
            inner: Arc::new(UnixIpcInner {
                socket_path: socket_path.as_ref().to_path_buf(),
                next_id: std::sync::atomic::AtomicU64::new(1),
                write_half: Arc::new(Mutex::new(None)),
                pending: Arc::new(Mutex::new(HashMap::new())),
            }),
        }
    }

    /// Connect (or reconnect) to the daemon.
    ///
    /// Spawns a reader task that pumps responses into the `pending` map.
    async fn ensure_connected(&self) -> Result<()> {
        let mut guard = self.inner.write_half.lock().await;
        if guard.is_some() {
            return Ok(());
        }
        let stream = UnixStream::connect(&self.inner.socket_path)
            .await
            .with_context(|| format!("connect unix socket {}", self.inner.socket_path.display()))?;
        let (mut read_half, write_half) = stream.into_split();
        *guard = Some(write_half);
        let pending = self.inner.pending.clone();
        let socket_path = self.inner.socket_path.clone();
        let write_half_slot = self.inner.write_half.clone();
        tokio::spawn(async move {
            let mut len_buf = [0u8; 4];
            loop {
                if read_half.read_exact(&mut len_buf).await.is_err() {
                    tracing::warn!(
                        socket = %socket_path.display(),
                        "ipc reader: connection closed"
                    );
                    // Drop the writer so the next send triggers a reconnect.
                    *write_half_slot.lock().await = None;
                    // Fail any pending waiters with a synthetic error.
                    let mut map = pending.lock().await;
                    for (_, tx) in map.drain() {
                        let _ = tx.send(Response::Error {
                            http_status: 0,
                            code: None,
                            message: "ipc disconnected".into(),
                        });
                    }
                    return;
                }
                let len = u32::from_be_bytes(len_buf) as usize;
                if len == 0 || len > 64 * 1024 * 1024 {
                    tracing::error!(len, "ipc reader: implausible frame length");
                    *write_half_slot.lock().await = None;
                    return;
                }
                let mut body = vec![0u8; len];
                if read_half.read_exact(&mut body).await.is_err() {
                    *write_half_slot.lock().await = None;
                    return;
                }
                let env: Envelope<Response> = match rmp_serde::from_slice(&body) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!(?e, "ipc reader: decode failed");
                        continue;
                    }
                };
                let mut map = pending.lock().await;
                if let Some(tx) = map.remove(&env.id) {
                    let _ = tx.send(env.body);
                }
            }
        });
        Ok(())
    }

    async fn send_inner(&self, req: Request) -> Result<Response> {
        self.ensure_connected().await?;
        let id = self
            .inner
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, tx);

        let env = Envelope { id, body: req };
        let body = rmp_serde::to_vec_named(&env).context("encode ipc request")?;
        let len: u32 = body
            .len()
            .try_into()
            .context("ipc request body exceeds u32::MAX")?;
        {
            let mut guard = self.inner.write_half.lock().await;
            let writer = guard
                .as_mut()
                .ok_or_else(|| anyhow::anyhow!("ipc writer not connected"))?;
            writer.write_all(&len.to_be_bytes()).await?;
            writer.write_all(&body).await?;
            writer.flush().await?;
        }
        let resp = rx.await.context("ipc response channel closed")?;
        Ok(resp)
    }
}

// The Ipc trait, expressed without the async-trait crate.
mod ipc_trait {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;

    pub trait Ipc: Send + Sync + 'static {
        fn send<'a>(
            &'a self,
            req: Request,
        ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>>;
    }

    impl Ipc for super::UnixIpcClient {
        fn send<'a>(
            &'a self,
            req: Request,
        ) -> Pin<Box<dyn Future<Output = Result<Response>> + Send + 'a>> {
            Box::pin(async move { self.send_with_retry(req).await })
        }
    }
}

pub use ipc_trait::Ipc as IpcTrait;

impl UnixIpcClient {
    /// Send a request with bounded retry for idempotent ops.
    ///
    /// Delegates to the shared `with_retry` helper so both `UnixIpcClient`
    /// and `HttpIpcClient` honour the same policy (3× backoff for safe ops,
    /// no retry for mutating ops).
    async fn send_with_retry(&self, req: Request) -> Result<Response> {
        with_retry(req, |r| self.send_inner(r)).await
    }
}

/// Shared retry shape used by both `UnixIpcClient` and `HttpIpcClient`.
///
/// `is_idempotent(&req)` decides whether transport errors (no response,
/// disconnected, network blip) should retry up to 3× within ~1 s.
/// Mutating ops never retry — they map transport failures straight to the
/// caller so we don't silently double-write.
pub(crate) async fn with_retry<F, Fut>(req: Request, mut send: F) -> Result<Response>
where
    F: FnMut(Request) -> Fut,
    Fut: std::future::Future<Output = Result<Response>>,
{
    let idempotent = is_idempotent(&req);
    let mut attempts: u32 = 0;
    let mut backoff_ms: u64 = 50;
    loop {
        attempts += 1;
        match send(req.clone()).await {
            Ok(r) => return Ok(r),
            Err(e) if idempotent && attempts < 3 => {
                tracing::debug!(?e, attempts, "ipc retry");
                sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(1000);
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}

pub fn is_idempotent(req: &Request) -> bool {
    matches!(
        req,
        Request::Ping
            | Request::Hello { .. }
            | Request::ListDrives
            | Request::DefaultDriveSlug
            | Request::GetAttr { .. }
            | Request::ReadDir { .. }
            | Request::OpenRead { .. }
    )
}

// ---------------------------------------------------------------------------
// Mock implementation for unit tests
// ---------------------------------------------------------------------------

/// An in-process IPC stub. Tests register a handler closure that maps each
/// `Request` to a canned `Response`.
pub struct MockIpc {
    handler: Box<dyn Fn(Request) -> Response + Send + Sync>,
    pub log: Arc<Mutex<Vec<Request>>>,
}

impl MockIpc {
    pub fn new<F>(handler: F) -> Self
    where
        F: Fn(Request) -> Response + Send + Sync + 'static,
    {
        Self {
            handler: Box::new(handler),
            log: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

impl IpcTrait for MockIpc {
    fn send<'a>(
        &'a self,
        req: Request,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response>> + Send + 'a>> {
        Box::pin(async move {
            self.log.lock().await.push(req.clone());
            Ok((self.handler)(req))
        })
    }
}

// ---------------------------------------------------------------------------
// HTTP implementation (remote-mount mode)
// ---------------------------------------------------------------------------

/// IPC client that talks to a remote `agent-fs` HTTP API instead of a
/// local Unix socket. Used by `agent-fs mount --remote` in environments
/// (Sprite, E2B, Hetzner VM, GitHub Actions, etc.) that can reach a
/// hosted daemon but can't run one locally.
///
/// Phase 3 landed read-only ops; Phase 4 fills in writes (`OpenWrite`,
/// `CreateFile`, `Truncate`, `Unlink`, `Rename`, `Mkdir`, `Rmdir`) via
/// the binary `PUT .../files/*/raw` endpoint and the
/// `POST /orgs/:orgId/ops` dispatcher. Cross-drive renames short-circuit
/// to `EXDEV` so the kernel falls back to copy-then-unlink.
pub struct HttpIpcClient {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
    /// Cached `defaultOrgId` from `/auth/me`. Populated lazily on first
    /// request so we don't block the constructor on a network round-trip.
    default_org: once_cell::sync::OnceCell<String>,
    /// Cached `defaultDriveId` from `/auth/me`. Same lazy pattern.
    default_drive: once_cell::sync::OnceCell<String>,
    /// Cached `(slug → (drive_id, org_id))` table built from
    /// `GET /orgs/:orgId/drives` per visible org. Populated on first call
    /// that needs id-resolution and reused for the lifetime of the helper.
    drive_table: tokio::sync::Mutex<Option<DriveTable>>,
}

#[derive(Debug, Clone, Default)]
struct DriveTable {
    /// slug → (driveId, orgId)
    by_slug: HashMap<String, (String, String)>,
    /// driveId → slug (reverse lookup for `default_drive_slug`)
    slug_by_id: HashMap<String, String>,
    /// flattened DriveInfo list (returned verbatim by `ListDrives`)
    all: Vec<DriveInfo>,
}

#[derive(Debug, Deserialize)]
struct OrgsResponse {
    orgs: Vec<OrgEntry>,
}

#[derive(Debug, Deserialize)]
struct OrgEntry {
    id: String,
    #[serde(default)]
    #[allow(dead_code)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DrivesResponse {
    drives: Vec<DriveEntry>,
}

#[derive(Debug, Deserialize)]
struct DriveEntry {
    id: String,
    name: String,
    #[serde(default, rename = "isDefault")]
    #[allow(dead_code)]
    is_default: bool,
}

#[derive(Debug, Deserialize)]
struct AuthMeResponse {
    #[serde(rename = "defaultOrgId")]
    default_org_id: Option<String>,
    #[serde(rename = "defaultDriveId")]
    default_drive_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LsEntryResponse {
    name: String,
    /// "file" | "directory"
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default, rename = "modifiedAt")]
    modified_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LsResponse {
    entries: Vec<LsEntryResponse>,
}

#[derive(Debug, Deserialize)]
struct StatResponse {
    #[allow(dead_code)]
    path: String,
    size: u64,
    #[serde(default, rename = "currentVersion")]
    current_version: Option<u64>,
    #[serde(default, rename = "modifiedAt")]
    modified_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HttpErrorBody {
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

impl HttpIpcClient {
    /// Construct a new HTTP IPC client.
    ///
    /// `base_url` is the daemon's HTTP origin (e.g. `https://agent-fs-taras.fly.dev`).
    /// `api_key` is forwarded as `Authorization: Bearer <key>` on every
    /// request. Trailing slash on `base_url` is stripped so URL assembly
    /// never double-slashes.
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Result<Self> {
        let base_url = base_url.into();
        let base_url = base_url.trim_end_matches('/').to_string();
        let api_key = api_key.into();
        let http = reqwest::Client::builder()
            .user_agent(concat!("agent-fs-fuse/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()
            .context("build reqwest client")?;
        Ok(Self {
            base_url,
            api_key,
            http,
            default_org: once_cell::sync::OnceCell::new(),
            default_drive: once_cell::sync::OnceCell::new(),
            drive_table: tokio::sync::Mutex::new(None),
        })
    }

    fn auth_header(&self) -> String {
        format!("Bearer {}", self.api_key)
    }

    /// Fetch `/auth/me` once and stash `defaultOrgId` + `defaultDriveId`.
    /// Called by ops that need an org id (`get_attr`, `read_dir`, `open_read`).
    async fn ensure_auth_me(&self) -> Result<()> {
        if self.default_org.get().is_some() {
            return Ok(());
        }
        let url = format!("{}/auth/me", self.base_url);
        let resp = self
            .http
            .get(&url)
            .header("Authorization", self.auth_header())
            .send()
            .await
            .context("GET /auth/me")?;
        let status = resp.status();
        if !status.is_success() {
            anyhow::bail!("/auth/me returned HTTP {}", status.as_u16());
        }
        let body: AuthMeResponse = resp.json().await.context("decode /auth/me")?;
        if let Some(org_id) = body.default_org_id {
            let _ = self.default_org.set(org_id);
        } else {
            anyhow::bail!("/auth/me returned no defaultOrgId");
        }
        if let Some(drive_id) = body.default_drive_id {
            let _ = self.default_drive.set(drive_id);
        }
        Ok(())
    }

    /// Lazily build the slug → (driveId, orgId) lookup table. Walks every
    /// org the API key can see and collects drives across all of them so
    /// `ListDrives` / `DefaultDriveSlug` / `resolve_drive` agree.
    async fn ensure_drive_table(&self) -> Result<()> {
        {
            let guard = self.drive_table.lock().await;
            if guard.is_some() {
                return Ok(());
            }
        }
        let orgs_url = format!("{}/orgs", self.base_url);
        let orgs_resp = self
            .http
            .get(&orgs_url)
            .header("Authorization", self.auth_header())
            .send()
            .await
            .context("GET /orgs")?;
        let status = orgs_resp.status();
        if !status.is_success() {
            anyhow::bail!("/orgs returned HTTP {}", status.as_u16());
        }
        let orgs: OrgsResponse = orgs_resp.json().await.context("decode /orgs")?;

        let mut table = DriveTable::default();
        for org in orgs.orgs {
            let drives_url = format!("{}/orgs/{}/drives", self.base_url, org.id);
            let drives_resp = self
                .http
                .get(&drives_url)
                .header("Authorization", self.auth_header())
                .send()
                .await
                .with_context(|| format!("GET /orgs/{}/drives", org.id))?;
            let dstatus = drives_resp.status();
            if !dstatus.is_success() {
                // Skip orgs we can't see drives for — partial visibility
                // shouldn't fail the whole call.
                tracing::warn!(
                    org_id = %org.id,
                    status = dstatus.as_u16(),
                    "skipping org drives listing"
                );
                continue;
            }
            let drives: DrivesResponse =
                drives_resp.json().await.context("decode drives response")?;
            for d in drives.drives {
                // Slug == name in this codebase (see daemon
                // `handlers.ts:213`). Keep the same mapping here.
                table
                    .by_slug
                    .insert(d.name.clone(), (d.id.clone(), org.id.clone()));
                table.slug_by_id.insert(d.id.clone(), d.name.clone());
                table.all.push(DriveInfo {
                    slug: d.name,
                    id: d.id,
                    org_id: org.id.clone(),
                });
            }
        }
        *self.drive_table.lock().await = Some(table);
        Ok(())
    }

    /// Resolve a drive slug (the helper's id of choice) to `(orgId, driveId)`.
    /// Builds the cache on first use.
    async fn resolve_drive(&self, slug: &str) -> Result<(String, String)> {
        self.ensure_drive_table().await?;
        let guard = self.drive_table.lock().await;
        let table = guard.as_ref().expect("drive_table populated above");
        let entry = table
            .by_slug
            .get(slug)
            .ok_or_else(|| anyhow::anyhow!("drive not found: {}", slug))?;
        Ok((entry.1.clone(), entry.0.clone())) // (orgId, driveId)
    }

    /// Inner request dispatcher. Mirrors `UnixIpcClient::send_inner` shape so
    /// `with_retry` can drive both transports identically.
    async fn send_inner(&self, req: Request) -> Result<Response> {
        match req {
            Request::Ping => self.do_ping().await,
            Request::Hello { .. } => self.do_hello().await,
            Request::ListDrives => self.do_list_drives().await,
            Request::DefaultDriveSlug => self.do_default_drive_slug().await,
            Request::GetAttr { drive, path } => self.do_get_attr(&drive, &path).await,
            Request::ReadDir { drive, path } => self.do_read_dir(&drive, &path).await,
            Request::OpenRead { drive, path } => self.do_open_read(&drive, &path).await,
            Request::OpenWrite {
                drive,
                path,
                base_version,
                content_hash,
                bytes,
            } => {
                self.do_open_write(&drive, &path, base_version, &content_hash, bytes)
                    .await
            }
            Request::CreateFile { drive, path } => self.do_create_file(&drive, &path).await,
            Request::Truncate { drive, path, size } => self.do_truncate(&drive, &path, size).await,
            Request::Unlink { drive, path } => self.do_unlink(&drive, &path).await,
            Request::Rename {
                drive,
                from_path,
                to_drive,
                to_path,
            } => {
                self.do_rename(&drive, &from_path, &to_drive, &to_path)
                    .await
            }
            Request::Mkdir { drive, path } => self.do_mkdir(&drive, &path).await,
            Request::Rmdir { drive, path } => self.do_rmdir(&drive, &path).await,
            // Diagnostic-only ops have no HTTP equivalent — log + ack so the
            // helper doesn't EIO on housekeeping calls.
            Request::RecordConflict { .. } => {
                tracing::warn!("record_conflict (http transport, no-op)");
                Ok(Response::Ok)
            }
            Request::WriteStatus { line } => {
                tracing::info!(line, "write_status (http transport, no-op)");
                Ok(Response::Ok)
            }
        }
    }

    async fn do_ping(&self) -> Result<Response> {
        let url = format!("{}/health", self.base_url);
        // /health is public but we still send auth so wiremock-style stubs
        // can assert the header is present on every call.
        let resp = self
            .http
            .get(&url)
            .header("Authorization", self.auth_header())
            .send()
            .await
            .context("GET /health")?;
        let status = resp.status();
        if !status.is_success() {
            return Ok(http_error(status.as_u16(), None, "/health failed"));
        }
        Ok(Response::Pong)
    }

    async fn do_hello(&self) -> Result<Response> {
        self.ensure_auth_me().await?;
        Ok(Response::Ok)
    }

    async fn do_list_drives(&self) -> Result<Response> {
        self.ensure_drive_table().await?;
        let guard = self.drive_table.lock().await;
        let drives = guard.as_ref().map(|t| t.all.clone()).unwrap_or_default();
        Ok(Response::Drives(drives))
    }

    async fn do_default_drive_slug(&self) -> Result<Response> {
        self.ensure_auth_me().await?;
        let drive_id = match self.default_drive.get() {
            Some(id) => id.clone(),
            None => return Ok(Response::DefaultDriveSlug(None)),
        };
        self.ensure_drive_table().await?;
        let guard = self.drive_table.lock().await;
        let slug = guard
            .as_ref()
            .and_then(|t| t.slug_by_id.get(&drive_id).cloned());
        Ok(Response::DefaultDriveSlug(slug))
    }

    async fn do_get_attr(&self, drive: &str, path: &str) -> Result<Response> {
        let (org_id, drive_id) = self.resolve_drive(drive).await?;
        let url = format!("{}/orgs/{}/ops", self.base_url, org_id);
        let body = serde_json::json!({
            "op": "stat",
            "driveId": drive_id,
            "path": path,
        });
        let resp = self
            .http
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .context("POST /ops stat")?;
        let status = resp.status();
        if status.as_u16() == 404 {
            // The daemon falls back to a directory probe via `ls` when
            // stat 404s. Mirror that here so `ls /mnt/drive/dir` works.
            return self.dir_attr_or_404(&org_id, &drive_id, path).await;
        }
        if !status.is_success() {
            let body: HttpErrorBody = resp.json().await.unwrap_or(HttpErrorBody {
                error: None,
                message: None,
            });
            return Ok(http_error(
                status.as_u16(),
                body.error,
                &body.message.unwrap_or_default(),
            ));
        }
        let stat: StatResponse = resp.json().await.context("decode stat response")?;
        let mtime_unix = parse_iso8601(stat.modified_at.as_deref()).unwrap_or(0);
        Ok(Response::Attr(AttrInfo {
            kind: NodeKind::File,
            size: stat.size,
            mtime_unix,
            version: stat.current_version,
            content_hash: None,
        }))
    }

    /// Fallback used when `stat` returns 404 — probe via `ls` and, if the
    /// path has children, synthesize a directory `AttrInfo`. Matches the
    /// daemon's `get_attr` handler in `packages/server/src/ipc/handlers.ts`.
    async fn dir_attr_or_404(&self, org_id: &str, drive_id: &str, path: &str) -> Result<Response> {
        let url = format!("{}/orgs/{}/ops", self.base_url, org_id);
        let body = serde_json::json!({
            "op": "ls",
            "driveId": drive_id,
            "path": path,
        });
        let resp = self
            .http
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .context("POST /ops ls (dir probe)")?;
        let status = resp.status();
        if !status.is_success() {
            return Ok(http_error(404, Some("NOT_FOUND".into()), "not found"));
        }
        let ls: LsResponse = resp.json().await.context("decode ls (dir probe)")?;
        if ls.entries.is_empty() {
            return Ok(http_error(404, Some("NOT_FOUND".into()), "not found"));
        }
        Ok(Response::Attr(AttrInfo {
            kind: NodeKind::Dir,
            size: 0,
            mtime_unix: 0,
            version: None,
            content_hash: None,
        }))
    }

    async fn do_read_dir(&self, drive: &str, path: &str) -> Result<Response> {
        let (org_id, drive_id) = self.resolve_drive(drive).await?;
        let url = format!("{}/orgs/{}/ops", self.base_url, org_id);
        let body = serde_json::json!({
            "op": "ls",
            "driveId": drive_id,
            "path": path,
        });
        let resp = self
            .http
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .context("POST /ops ls")?;
        let status = resp.status();
        if !status.is_success() {
            let body: HttpErrorBody = resp.json().await.unwrap_or(HttpErrorBody {
                error: None,
                message: None,
            });
            return Ok(http_error(
                status.as_u16(),
                body.error,
                &body.message.unwrap_or_default(),
            ));
        }
        let ls: LsResponse = resp.json().await.context("decode ls response")?;
        let entries = ls
            .entries
            .into_iter()
            .map(|e| {
                let kind = match e.kind.as_str() {
                    "directory" => NodeKind::Dir,
                    _ => NodeKind::File,
                };
                DirEntry {
                    name: e.name,
                    kind,
                    size: e.size.unwrap_or(0),
                    mtime_unix: parse_iso8601(e.modified_at.as_deref()).unwrap_or(0),
                    version: None,
                    content_hash: None,
                }
            })
            .collect();
        Ok(Response::DirEntries(entries))
    }

    async fn do_open_read(&self, drive: &str, path: &str) -> Result<Response> {
        let (org_id, drive_id) = self.resolve_drive(drive).await?;
        // Server's `GET /files/*/raw` already URL-decodes the wildcard
        // capture — match exactly what `files.ts:24-84` expects. The
        // leading slash is stripped because the route already contributes
        // one.
        let stripped = path.strip_prefix('/').unwrap_or(path);
        let url = format!(
            "{}/orgs/{}/drives/{}/files/{}/raw",
            self.base_url,
            org_id,
            drive_id,
            url_encode_path(stripped)
        );
        let resp = self
            .http
            .get(&url)
            .header("Authorization", self.auth_header())
            .send()
            .await
            .context("GET /files/.../raw")?;
        let status = resp.status();
        if !status.is_success() {
            let code = if status.as_u16() == 404 {
                Some("NOT_FOUND".into())
            } else {
                None
            };
            return Ok(http_error(status.as_u16(), code, "raw read failed"));
        }
        let version = resp
            .headers()
            .get("X-Agent-FS-Version")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let content_hash = resp
            .headers()
            .get("X-Agent-FS-Content-Hash")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let last_modified = resp
            .headers()
            .get("Last-Modified")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let bytes = resp.bytes().await.context("read raw bytes")?.to_vec();
        let size = bytes.len() as u64;
        let mtime_unix = last_modified.and_then(|s| parse_http_date(&s)).unwrap_or(0);
        Ok(Response::OpenRead {
            bytes,
            version,
            content_hash,
            size,
            mtime_unix,
        })
    }

    /// `PUT /orgs/:orgId/drives/:driveId/files/:path/raw` — close-time write
    /// from the FUSE mount. `base_version` of `Some(n)` maps to `If-Match`
    /// (overwrite known head), `None` is unconditional (overwrite-anything).
    /// `content_hash` is currently informational only — the daemon doesn't
    /// honour it as a precondition yet (no `Content-SHA256` handler in
    /// `routes/files.ts`), but we forward it so the wire shape is ready
    /// once the server-side check lands.
    async fn do_open_write(
        &self,
        drive: &str,
        path: &str,
        base_version: Option<u64>,
        content_hash: &str,
        bytes: Vec<u8>,
    ) -> Result<Response> {
        let (org_id, drive_id) = self.resolve_drive(drive).await?;
        let stripped = path.strip_prefix('/').unwrap_or(path);
        let url = format!(
            "{}/orgs/{}/drives/{}/files/{}/raw",
            self.base_url,
            org_id,
            drive_id,
            url_encode_path(stripped)
        );
        let mut req = self
            .http
            .put(&url)
            .header("Authorization", self.auth_header())
            // Hono routes /raw expect a non-JSON Content-Type so the
            // 415-guard in files.ts:104-114 doesn't trip.
            .header("Content-Type", "application/octet-stream")
            .body(bytes);
        if let Some(v) = base_version {
            req = req.header("If-Match", v.to_string());
        }
        if !content_hash.is_empty() {
            req = req.header("Content-SHA256", content_hash);
        }
        let resp = req.send().await.context("PUT /files/.../raw")?;
        let status = resp.status();
        if !status.is_success() {
            return Ok(decode_http_error(resp).await);
        }
        let (version, content_hash, deduped) = parse_version_headers(resp.headers());
        Ok(Response::OpenWrite {
            version,
            content_hash,
            deduped,
        })
    }

    /// `PUT /orgs/:orgId/drives/:driveId/files/:path/raw` with `If-None-Match: *`
    /// — fails 409 if the file already exists. Mirrors the daemon's
    /// `create_file` IPC handler (writes with `expectedVersion: 0`).
    async fn do_create_file(&self, drive: &str, path: &str) -> Result<Response> {
        let (org_id, drive_id) = self.resolve_drive(drive).await?;
        let stripped = path.strip_prefix('/').unwrap_or(path);
        let url = format!(
            "{}/orgs/{}/drives/{}/files/{}/raw",
            self.base_url,
            org_id,
            drive_id,
            url_encode_path(stripped)
        );
        let resp = self
            .http
            .put(&url)
            .header("Authorization", self.auth_header())
            .header("Content-Type", "application/octet-stream")
            .header("If-None-Match", "*")
            .body(Vec::<u8>::new())
            .send()
            .await
            .context("PUT /files/.../raw (create)")?;
        let status = resp.status();
        if !status.is_success() {
            return Ok(decode_http_error(resp).await);
        }
        let (version, content_hash, deduped) = parse_version_headers(resp.headers());
        Ok(Response::OpenWrite {
            version,
            content_hash,
            deduped,
        })
    }

    /// `truncate` is RMW because the HTTP API exposes no direct truncate
    /// endpoint: `GET .../files/.../raw` → slice → `PUT` back. This races
    /// with concurrent writes; matches the daemon's `truncate` handler
    /// behaviour in `packages/server/src/ipc/handlers.ts:355-374`.
    async fn do_truncate(&self, drive: &str, path: &str, size: u64) -> Result<Response> {
        // Reuse the open_read helper for the GET leg so URL encoding,
        // header parsing, and 404 handling stay in one place.
        let read_resp = self.do_open_read(drive, path).await?;
        let (current_bytes, base_version) = match read_resp {
            Response::OpenRead { bytes, version, .. } => (bytes, Some(version)),
            // Pass through any 404 / error from the GET — the kernel sees it.
            err @ Response::Error { .. } => return Ok(err),
            other => {
                anyhow::bail!(
                    "unexpected response from open_read during truncate: {:?}",
                    other
                )
            }
        };
        let new_len = (size as usize).min(current_bytes.len());
        let trimmed = current_bytes[..new_len].to_vec();
        self.do_open_write(drive, path, base_version, "", trimmed)
            .await
    }

    /// `POST /orgs/:orgId/ops {op:"rm",path}` — matches the daemon's
    /// `unlink` handler which itself calls `dispatchOp(..., "rm", ...)`.
    async fn do_unlink(&self, drive: &str, path: &str) -> Result<Response> {
        let (org_id, drive_id) = self.resolve_drive(drive).await?;
        let url = format!("{}/orgs/{}/ops", self.base_url, org_id);
        let body = serde_json::json!({
            "op": "rm",
            "driveId": drive_id,
            "path": path,
        });
        let resp = self
            .http
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .context("POST /ops rm")?;
        let status = resp.status();
        if !status.is_success() {
            return Ok(decode_http_error(resp).await);
        }
        Ok(Response::Ok)
    }

    /// Cross-drive rename short-circuits to `EXDEV` so the kernel knows to
    /// fall back to copy + unlink; same-drive rename dispatches `mv` via
    /// `POST /ops`.
    async fn do_rename(
        &self,
        drive: &str,
        from_path: &str,
        to_drive: &str,
        to_path: &str,
    ) -> Result<Response> {
        if drive != to_drive {
            // `http_status: 0` is the sentinel the helper uses for
            // transport-internal errors; `errno::map` keys off the `code`.
            return Ok(http_error(
                0,
                Some("EXDEV".into()),
                "cross-drive rename not supported",
            ));
        }
        let (org_id, drive_id) = self.resolve_drive(drive).await?;
        let url = format!("{}/orgs/{}/ops", self.base_url, org_id);
        let body = serde_json::json!({
            "op": "mv",
            "driveId": drive_id,
            "from": from_path,
            "to": to_path,
        });
        let resp = self
            .http
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .context("POST /ops mv")?;
        let status = resp.status();
        if !status.is_success() {
            return Ok(decode_http_error(resp).await);
        }
        Ok(Response::Ok)
    }

    /// Object storage has no directory marker — the namespace populates on
    /// first file write under the prefix. Match the daemon's local-no-op
    /// behaviour (`handlers.ts:395-401`) so the kernel doesn't surface a
    /// spurious error.
    async fn do_mkdir(&self, drive: &str, path: &str) -> Result<Response> {
        tracing::debug!(drive = drive, path = path, "mkdir (http transport, no-op)");
        Ok(Response::Ok)
    }

    /// `rmdir` checks emptiness via `ls` to mirror the daemon (which does
    /// the same in `handlers.ts:403-413`). No dedicated HTTP rmdir endpoint
    /// today; an empty `ls` is the cheapest cross-drive check.
    async fn do_rmdir(&self, drive: &str, path: &str) -> Result<Response> {
        let (org_id, drive_id) = self.resolve_drive(drive).await?;
        let url = format!("{}/orgs/{}/ops", self.base_url, org_id);
        let body = serde_json::json!({
            "op": "ls",
            "driveId": drive_id,
            "path": path,
        });
        let resp = self
            .http
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&body)
            .send()
            .await
            .context("POST /ops ls (rmdir probe)")?;
        let status = resp.status();
        if !status.is_success() {
            return Ok(decode_http_error(resp).await);
        }
        let ls: LsResponse = resp.json().await.context("decode ls (rmdir probe)")?;
        if !ls.entries.is_empty() {
            return Ok(http_error(
                409,
                Some("VALIDATION".into()),
                "directory not empty",
            ));
        }
        Ok(Response::Ok)
    }
}

impl IpcTrait for HttpIpcClient {
    fn send<'a>(
        &'a self,
        req: Request,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Response>> + Send + 'a>> {
        Box::pin(async move { with_retry(req, |r| async move { self.send_inner(r).await }).await })
    }
}

fn http_error(http_status: u16, code: Option<String>, message: &str) -> Response {
    Response::Error {
        http_status,
        code,
        message: message.to_string(),
    }
}

/// Read a non-2xx response body and translate the daemon's JSON error
/// payload (`{ error, message }`, per
/// `packages/server/src/middleware/error.ts:20-32`) into a
/// `Response::Error`. Falls back to `("<empty>", "")` if the body isn't
/// JSON-shaped.
async fn decode_http_error(resp: reqwest::Response) -> Response {
    let status = resp.status().as_u16();
    let body: HttpErrorBody = resp.json().await.unwrap_or(HttpErrorBody {
        error: None,
        message: None,
    });
    http_error(
        status,
        body.error,
        &body.message.unwrap_or_else(|| format!("HTTP {}", status)),
    )
}

/// Extract `(version, content_hash, deduped)` from the headers the daemon
/// emits on a successful raw write. The header names mirror those set in
/// `packages/server/src/routes/files.ts:183-194`:
///   ETag                       → `"<version>"`  (preferred; canonical)
///   X-Agent-FS-Version         → `<version>`    (fallback)
///   X-Agent-FS-Content-Hash    → `<sha256-hex>`
///   X-Agent-FS-Deduped         → `"0" | "1"`
fn parse_version_headers(headers: &reqwest::header::HeaderMap) -> (u64, String, bool) {
    let version = headers
        .get("ETag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string())
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| {
            headers
                .get("X-Agent-FS-Version")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
        })
        .unwrap_or(0);
    let content_hash = headers
        .get("X-Agent-FS-Content-Hash")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let deduped = headers
        .get("X-Agent-FS-Deduped")
        .and_then(|v| v.to_str().ok())
        .map(|s| s == "1")
        .unwrap_or(false);
    (version, content_hash, deduped)
}

/// Percent-encode a path while preserving `/` segment separators. The
/// raw-files route is `*` (Hono multi-segment wildcard) so we need to
/// keep slashes literal.
fn url_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '/' => out.push('/'),
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            other => {
                let mut buf = [0u8; 4];
                for b in other.encode_utf8(&mut buf).as_bytes() {
                    out.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    out
}

/// Best-effort parse of an ISO-8601 / RFC-3339 timestamp into unix seconds.
/// Falls back to `None` on parse failure (caller substitutes 0). We avoid
/// pulling `chrono` in just for this — `time` is already a transitive dep.
fn parse_iso8601(s: Option<&str>) -> Option<i64> {
    let s = s?;
    // Tolerate a "Z" suffix and millisecond precision. Common shapes:
    //   "2026-05-18T18:30:00.000Z"
    //   "2026-05-18T18:30:00Z"
    // SystemTime::from_str isn't a thing, so do a manual minimal parse.
    let trimmed = s.trim_end_matches('Z');
    let (date, time) = trimmed.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let time = time.split('.').next().unwrap_or(time);
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 = time_parts.next()?.parse().ok()?;
    // Days since unix epoch via Howard Hinnant's date algorithm.
    let y = year - (if month <= 2 { 1 } else { 0 });
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days_since_epoch = era * 146097 + doe - 719468;
    Some(days_since_epoch * 86400 + hour * 3600 + minute * 60 + second)
}

/// Parse an HTTP-date (`Last-Modified` header) into unix seconds. Tolerates
/// only the most common IMF-fixdate shape since that's what Hono emits;
/// returns `None` otherwise.
fn parse_http_date(s: &str) -> Option<i64> {
    // "Mon, 18 May 2026 18:30:00 GMT"
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() < 6 {
        return None;
    }
    let day: i64 = parts[1].parse().ok()?;
    let month = match parts[2] {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts[3].parse().ok()?;
    let time_parts: Vec<&str> = parts[4].split(':').collect();
    if time_parts.len() != 3 {
        return None;
    }
    let hour: i64 = time_parts[0].parse().ok()?;
    let minute: i64 = time_parts[1].parse().ok()?;
    let second: i64 = time_parts[2].parse().ok()?;
    // Reuse iso8601 math.
    let synthetic = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        year, month, day, hour, minute, second
    );
    parse_iso8601(Some(synthetic.as_str()))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idempotent_classification() {
        assert!(is_idempotent(&Request::Ping));
        assert!(is_idempotent(&Request::ListDrives));
        assert!(is_idempotent(&Request::GetAttr {
            drive: "d".into(),
            path: "/".into(),
        }));
        assert!(!is_idempotent(&Request::CreateFile {
            drive: "d".into(),
            path: "/x".into(),
        }));
        assert!(!is_idempotent(&Request::Unlink {
            drive: "d".into(),
            path: "/x".into(),
        }));
    }

    #[tokio::test]
    async fn mock_logs_and_replies() {
        let mock = MockIpc::new(|_| Response::Pong);
        let resp = mock.send(Request::Ping).await.unwrap();
        assert!(matches!(resp, Response::Pong));
        assert_eq!(mock.log.lock().await.len(), 1);
    }

    #[test]
    fn envelope_roundtrip_msgpack() {
        let env = Envelope {
            id: 42,
            body: Request::Ping,
        };
        let bytes = rmp_serde::to_vec_named(&env).unwrap();
        let decoded: Envelope<Request> = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(decoded.id, 42);
        assert!(matches!(decoded.body, Request::Ping));
    }
}
