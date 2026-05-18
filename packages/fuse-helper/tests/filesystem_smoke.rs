//! Filesystem smoke tests over `MockIpc`.
//!
//! Real FUSE mounts require `/dev/fuse`, which most CI runners lack. Instead
//! we exercise the open/write/release state machine + the new trait-helper
//! methods that the wired `fuser::Filesystem` callbacks delegate to. The
//! callback wiring itself is a thin block_on shim — covered by these tests
//! by way of the helpers they call.

use std::sync::Arc;

use agent_fs_fuse::fs::{sha256_hex, AgentFsFs};
use agent_fs_fuse::ipc::{AttrInfo, DirEntry, DriveInfo, MockIpc, NodeKind, Request, Response};
use agent_fs_fuse::layout::ROOT_INODE;
use tempfile::TempDir;
use tokio::runtime::Handle;

fn build_fs(
    handler: impl Fn(Request) -> Response + Send + Sync + 'static,
) -> (AgentFsFs<MockIpc>, TempDir, Arc<MockIpc>) {
    let tmp = TempDir::new().unwrap();
    let workdir = tmp.path().join("workdir");
    std::fs::create_dir_all(&workdir).unwrap();
    let ipc = Arc::new(MockIpc::new(handler));
    let handle = Handle::current();
    let fs = AgentFsFs::new(handle, ipc.clone(), workdir, std::process::id());
    (fs, tmp, ipc)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_then_release_puts_via_ipc() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::OpenWrite { content_hash, .. } => Response::OpenWrite {
            version: 7,
            content_hash,
            deduped: false,
        },
        _ => Response::Ok,
    });
    let fh = fs.create_local("brain", "/foo.md").await.unwrap();
    fs.write_local(fh, 0, b"abc").await.unwrap();
    let out = fs.release_close(fh).await.unwrap();
    let (version, hash) = out.expect("release should PUT");
    assert_eq!(version, 7);
    assert_eq!(hash, sha256_hex(b"abc"));

    let log = ipc.log.lock().await;
    assert!(log.iter().any(|r| matches!(
        r,
        Request::OpenWrite { drive, path, .. } if drive == "brain" && path == "/foo.md"
    )));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idempotent_rewrite_dedups() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::OpenRead { .. } => Response::OpenRead {
            bytes: b"same".to_vec(),
            version: 1,
            content_hash: sha256_hex(b"same"),
            size: 4,
            mtime_unix: 0,
        },
        _ => Response::Ok,
    });
    let fh = fs.open_for_read("brain", "/x.md").await.unwrap();
    fs.write_local(fh, 0, b"same").await.unwrap();
    let out = fs.release_close(fh).await.unwrap();
    assert!(out.is_none(), "dedup must skip the PUT");
    let log = ipc.log.lock().await;
    assert!(!log.iter().any(|r| matches!(r, Request::OpenWrite { .. })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflict_returns_eio() {
    let (fs, _tmp, _ipc) = build_fs(|req| match req {
        Request::OpenWrite { .. } => Response::Error {
            http_status: 409,
            code: Some("EDIT_CONFLICT".into()),
            message: "head moved".into(),
        },
        _ => Response::Ok,
    });
    let fh = fs.create_local("brain", "/c.md").await.unwrap();
    fs.write_local(fh, 0, b"x").await.unwrap();
    let err = fs.release_close(fh).await.unwrap_err();
    assert_eq!(err, libc::EIO);
}

// ---------------------------------------------------------------------------
// New wired-callback coverage (Phase 3).
// ---------------------------------------------------------------------------

/// `lookup` of a known path returns a FsNode with attrs from IPC `GetAttr`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lookup_under_drive_returns_attrs_via_get_attr() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::ListDrives => Response::Drives(vec![DriveInfo {
            slug: "brain".into(),
            id: "d1".into(),
            org_id: "o1".into(),
        }]),
        Request::GetAttr { .. } => Response::Attr(AttrInfo {
            kind: NodeKind::File,
            size: 99,
            mtime_unix: 1700000000,
            version: Some(4),
            content_hash: Some("h4".into()),
        }),
        _ => Response::Ok,
    });
    let drive = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
    let node = fs.resolve_child(drive.inode, "doc.md").await.unwrap();
    assert_eq!(node.kind, NodeKind::File);
    assert_eq!(node.size, 99);
    assert_eq!(node.head_version, Some(4));
    let log = ipc.log.lock().await;
    assert!(log.iter().any(|r| matches!(r, Request::GetAttr { .. })));
}

/// Full open + write + release flow exercising read_local, write_local,
/// release_close in sequence — the path the `read`/`write`/`release`
/// callbacks take.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn open_read_release_flow_round_trips() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::OpenRead { .. } => Response::OpenRead {
            bytes: b"old".to_vec(),
            version: 1,
            content_hash: sha256_hex(b"old"),
            size: 3,
            mtime_unix: 0,
        },
        Request::OpenWrite { content_hash, .. } => Response::OpenWrite {
            version: 2,
            content_hash,
            deduped: false,
        },
        _ => Response::Ok,
    });
    let fh = fs.open_for_read("brain", "/x.md").await.unwrap();
    let bytes = fs.read_local(fh, 0, 64).await.unwrap();
    assert_eq!(bytes, b"old");
    fs.write_local(fh, 0, b"new").await.unwrap();
    let out = fs.release_close(fh).await.unwrap();
    let (version, hash) = out.expect("modified close should PUT");
    assert_eq!(version, 2);
    assert_eq!(hash, sha256_hex(b"new"));
    let log = ipc.log.lock().await;
    assert!(log.iter().any(|r| matches!(r, Request::OpenRead { .. })));
    assert!(log.iter().any(|r| matches!(r, Request::OpenWrite { .. })));
}

/// `create` + `write` + `release` for a brand-new file (no OpenRead).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn create_write_release_for_new_file() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::OpenWrite { content_hash, .. } => Response::OpenWrite {
            version: 1,
            content_hash,
            deduped: false,
        },
        _ => Response::Ok,
    });
    let fh = fs.create_local("brain", "/new.md").await.unwrap();
    fs.write_local(fh, 0, b"hello new").await.unwrap();
    let out = fs.release_close(fh).await.unwrap();
    assert!(out.is_some());
    let log = ipc.log.lock().await;
    // Must NOT pre-fetch via OpenRead (it's a create, not an open).
    assert!(!log.iter().any(|r| matches!(r, Request::OpenRead { .. })));
    assert!(log.iter().any(|r| matches!(r, Request::OpenWrite { .. })));
}

/// `unlink` forwards to IPC and busts the parent dir's readdir cache.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unlink_forwards_to_ipc() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::ListDrives => Response::Drives(vec![DriveInfo {
            slug: "brain".into(),
            id: "d1".into(),
            org_id: "o1".into(),
        }]),
        Request::Unlink { .. } => Response::Ok,
        _ => Response::Ok,
    });
    let drive = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
    fs.unlink_path(drive.inode, "stale.md").await.unwrap();
    let log = ipc.log.lock().await;
    assert!(log.iter().any(|r| matches!(
        r,
        Request::Unlink { drive, path } if drive == "brain" && path == "/stale.md"
    )));
}

/// `rename` forwards to IPC with the correct from/to paths.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_forwards_to_ipc() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::ListDrives => Response::Drives(vec![DriveInfo {
            slug: "brain".into(),
            id: "d1".into(),
            org_id: "o1".into(),
        }]),
        Request::Rename { .. } => Response::Ok,
        _ => Response::Ok,
    });
    let drive = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
    fs.rename_path(drive.inode, "a.md", drive.inode, "b.md")
        .await
        .unwrap();
    let log = ipc.log.lock().await;
    assert!(log.iter().any(|r| matches!(
        r,
        Request::Rename { from_path, to_path, .. } if from_path == "/a.md" && to_path == "/b.md"
    )));
}

/// `readdir` at the root returns drive entries from `ListDrives` + the
/// `current` symlink.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readdir_root_returns_drives_plus_current() {
    let (fs, _tmp, _ipc) = build_fs(|req| match req {
        Request::ListDrives => Response::Drives(vec![DriveInfo {
            slug: "alpha".into(),
            id: "d1".into(),
            org_id: "o1".into(),
        }]),
        _ => Response::Ok,
    });
    let entries = fs.readdir_entries(ROOT_INODE).await.unwrap();
    let names: Vec<_> = entries.iter().map(|(_, n, _)| n.as_str()).collect();
    assert!(names.contains(&"alpha"));
    assert!(names.contains(&"current"));
}

/// `readdir` under a drive forwards to IPC `ReadDir` and caches.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readdir_under_drive_forwards_then_caches() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::ListDrives => Response::Drives(vec![DriveInfo {
            slug: "brain".into(),
            id: "d1".into(),
            org_id: "o1".into(),
        }]),
        Request::ReadDir { .. } => Response::DirEntries(vec![DirEntry {
            name: "a.md".into(),
            kind: NodeKind::File,
            size: 5,
            mtime_unix: 0,
            version: None,
            content_hash: None,
        }]),
        _ => Response::Ok,
    });
    let drive = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
    let _ = fs.readdir_entries(drive.inode).await.unwrap();
    let _ = fs.readdir_entries(drive.inode).await.unwrap();
    let log = ipc.log.lock().await;
    let read_dir_calls = log
        .iter()
        .filter(|r| matches!(r, Request::ReadDir { .. }))
        .count();
    assert_eq!(read_dir_calls, 1, "second readdir must hit the cache");
}

/// `readlink` for the synthetic `current` symlink fetches the default-drive
/// slug from IPC each time.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readlink_current_returns_default_drive() {
    let (fs, _tmp, ipc) = build_fs(|req| match req {
        Request::DefaultDriveSlug => Response::DefaultDriveSlug(Some("brain".into())),
        _ => Response::Ok,
    });
    let target = fs.readlink_root_current().await.unwrap();
    assert_eq!(target, "./brain");
    let log = ipc.log.lock().await;
    assert!(log.iter().any(|r| matches!(r, Request::DefaultDriveSlug)));
}

/// `mkdir` at root returns EROFS — drive creation is CLI-only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mkdir_at_root_returns_erofs() {
    let (fs, _tmp, _ipc) = build_fs(|_| Response::Ok);
    let err = fs.mkdir_path(ROOT_INODE, "new-drive").await.unwrap_err();
    assert_eq!(err, libc::EROFS);
}
