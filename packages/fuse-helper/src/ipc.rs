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
    /// `is_idempotent(&req)` decides whether transport errors (no response,
    /// disconnected) should retry up to 3× within 1 s. Mutating ops never
    /// retry — they map transport failures straight to the caller.
    async fn send_with_retry(&self, req: Request) -> Result<Response> {
        let idempotent = is_idempotent(&req);
        let mut attempts: u32 = 0;
        let mut backoff_ms: u64 = 50;
        loop {
            attempts += 1;
            match self.send_inner(req.clone()).await {
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
