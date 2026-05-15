//! The `fuser::Filesystem` implementation.
//!
//! Callbacks are synchronous (libfuse contract); each one bridges into the
//! async IPC client via a borrowed `tokio::runtime::Handle::block_on`.
//!
//! State lives in `AgentFsFs` and is concurrency-safe (the helper opens at
//! least one tokio worker thread).
//!
//! v1 scope (matches plan §Phase 2 op set):
//!
//! - Read side: lookup, getattr, readdir, open, read, release, readlink.
//! - Write side: create, write, flush, release (close-time PUT), truncate,
//!   unlink, rename, mkdir, rmdir.
//! - No-op: chmod, chown, utimens, fsync, fsyncdir, setxattr, getxattr,
//!   listxattr, removexattr, access.
//! - ENOSYS: flock, setlk/getlk, bmap, copy_file_range, ioctl, fallocate,
//!   poll.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::runtime::Handle;
use tokio::sync::Mutex as AsyncMutex;

use crate::ipc::{AttrInfo, IpcTrait, NodeKind, Request, Response};
use crate::layout::{
    current_symlink_target, root_readdir_entries, FsNode, InodeAllocator, TtlCache, ROOT_INODE,
};

/// readdir cache key: `(drive, dir_path)` → list of `(name, kind, inode)`.
type ReaddirCache = TtlCache<(String, String), Vec<(String, NodeKind, u64)>>;

/// Per-open working-copy bookkeeping. Each `open()` creates one of these.
#[derive(Debug)]
pub struct OpenFile {
    pub fh: u64,
    pub tmp_path: PathBuf,
    pub base_version: Option<u64>,
    pub base_hash: String,
    pub dirty: bool,
    pub drive: String,
    pub path: String,
}

/// FUSE filesystem state.
///
/// Generic over the IPC backend so unit tests can swap in `MockIpc`.
pub struct AgentFsFs<I: IpcTrait> {
    pub handle: Handle,
    pub ipc: Arc<I>,
    pub mount_workdir: PathBuf,
    pub pid: u32,

    pub inodes: AsyncMutex<HashMap<u64, FsNode>>,
    pub open_files: AsyncMutex<HashMap<u64, OpenFile>>,
    /// Reverse map: `(drive, path)` → inode. Lets us recycle inodes across
    /// lookups so the kernel's `nlookup`/cache references stay consistent.
    pub path_to_inode: AsyncMutex<HashMap<(String, String), u64>>,
    pub next_inode: InodeAllocator,
    pub next_fh: AtomicU64,
    pub readdir_cache: ReaddirCache,
    pub getattr_cache: TtlCache<u64, AttrInfo>,
    /// Uid/gid for synthetic stat replies (the kernel cares about these for
    /// `default_permissions`).
    pub uid: u32,
    pub gid: u32,
}

impl<I: IpcTrait> AgentFsFs<I> {
    pub fn new(handle: Handle, ipc: Arc<I>, mount_workdir: PathBuf, pid: u32) -> Self {
        let mut inodes = HashMap::new();
        inodes.insert(ROOT_INODE, FsNode::root());
        // SAFETY: getuid/getgid are infallible.
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        Self {
            handle,
            ipc,
            mount_workdir,
            pid,
            inodes: AsyncMutex::new(inodes),
            open_files: AsyncMutex::new(HashMap::new()),
            path_to_inode: AsyncMutex::new(HashMap::new()),
            next_inode: InodeAllocator::new(),
            next_fh: AtomicU64::new(1),
            readdir_cache: TtlCache::new(Duration::from_secs(15)),
            getattr_cache: TtlCache::new(Duration::from_secs(5)),
            uid,
            gid,
        }
    }

    /// Lookup an inode by number. Returns `None` if we never minted it.
    pub async fn get_inode(&self, ino: u64) -> Option<FsNode> {
        self.inodes.lock().await.get(&ino).cloned()
    }

    /// Mint a fresh inode for `(drive, path)` and store it.
    pub async fn insert_inode(&self, node: FsNode) -> u64 {
        let key = (node.drive.clone(), node.path.clone());
        let mut p2i = self.path_to_inode.lock().await;
        if let Some(&existing) = p2i.get(&key) {
            // Refresh the cached attrs while preserving the inode number.
            let mut map = self.inodes.lock().await;
            let mut n = node;
            n.inode = existing;
            map.insert(existing, n);
            return existing;
        }
        let mut map = self.inodes.lock().await;
        let ino = if node.inode == 0 {
            self.next_inode.next()
        } else {
            node.inode
        };
        let mut n = node;
        n.inode = ino;
        map.insert(ino, n);
        p2i.insert(key, ino);
        ino
    }

    // -----------------------------------------------------------------------
    // Working-copy lifecycle
    // -----------------------------------------------------------------------

    /// `open(path)` flow: GET bytes from daemon over IPC, write to a local
    /// working copy, register an `OpenFile`. Returns the file handle.
    pub async fn open_for_read(&self, drive: &str, path: &str) -> std::result::Result<u64, i32> {
        let req = Request::OpenRead {
            drive: drive.to_string(),
            path: path.to_string(),
        };
        let resp = self.ipc.send(req).await.map_err(|_| libc::EIO)?;
        let (bytes, version, content_hash) = match resp {
            Response::OpenRead {
                bytes,
                version,
                content_hash,
                ..
            } => (bytes, version, content_hash),
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                return Err(crate::errno::map(http_status, c));
            }
            _ => return Err(libc::EIO),
        };

        let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
        let tmp_path = self.mount_workdir.join(fh.to_string());
        std::fs::create_dir_all(&self.mount_workdir).map_err(|_| libc::EIO)?;
        write_perm_0600(&tmp_path, &bytes).map_err(|_| libc::EIO)?;

        let open = OpenFile {
            fh,
            tmp_path,
            base_version: Some(version),
            base_hash: content_hash,
            dirty: false,
            drive: drive.to_string(),
            path: path.to_string(),
        };
        self.open_files.lock().await.insert(fh, open);
        Ok(fh)
    }

    /// `create(path)` flow: register an `OpenFile` with no remote bytes yet.
    /// On close we'll PUT the local body with `base_version = None`.
    pub async fn create_local(&self, drive: &str, path: &str) -> std::result::Result<u64, i32> {
        let fh = self.next_fh.fetch_add(1, Ordering::Relaxed);
        let tmp_path = self.mount_workdir.join(fh.to_string());
        std::fs::create_dir_all(&self.mount_workdir).map_err(|_| libc::EIO)?;
        write_perm_0600(&tmp_path, &[]).map_err(|_| libc::EIO)?;
        let open = OpenFile {
            fh,
            tmp_path,
            base_version: None,
            base_hash: sha256_hex(&[]),
            dirty: true,
            drive: drive.to_string(),
            path: path.to_string(),
        };
        self.open_files.lock().await.insert(fh, open);
        Ok(fh)
    }

    /// `read(fh, offset, size)` — serve from the working copy.
    pub async fn read_local(
        &self,
        fh: u64,
        offset: u64,
        size: u32,
    ) -> std::result::Result<Vec<u8>, i32> {
        let path = {
            let map = self.open_files.lock().await;
            let of = map.get(&fh).ok_or(libc::EBADF)?;
            of.tmp_path.clone()
        };
        let mut f = std::fs::File::open(&path).map_err(|_| libc::EIO)?;
        f.seek(SeekFrom::Start(offset)).map_err(|_| libc::EIO)?;
        let mut buf = vec![0u8; size as usize];
        let n = f.read(&mut buf).map_err(|_| libc::EIO)?;
        buf.truncate(n);
        Ok(buf)
    }

    /// `write(fh, offset, data)` — append to / overwrite the working copy.
    pub async fn write_local(
        &self,
        fh: u64,
        offset: u64,
        data: &[u8],
    ) -> std::result::Result<u32, i32> {
        let path = {
            let mut map = self.open_files.lock().await;
            let of = map.get_mut(&fh).ok_or(libc::EBADF)?;
            of.dirty = true;
            of.tmp_path.clone()
        };
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|_| libc::EIO)?;
        f.seek(SeekFrom::Start(offset)).map_err(|_| libc::EIO)?;
        f.write_all(data).map_err(|_| libc::EIO)?;
        Ok(data.len() as u32)
    }

    /// `truncate(fh, size)` — local ftruncate.
    pub async fn truncate_local(&self, fh: u64, size: u64) -> std::result::Result<(), i32> {
        let path = {
            let mut map = self.open_files.lock().await;
            let of = map.get_mut(&fh).ok_or(libc::EBADF)?;
            of.dirty = true;
            of.tmp_path.clone()
        };
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|_| libc::EIO)?;
        f.set_len(size).map_err(|_| libc::EIO)?;
        Ok(())
    }

    /// `release(fh)` — close-time PUT, hash-dedup, conflict surfacing.
    ///
    /// Returns `Ok(None)` if the close was a no-op (clean or hash-dedup),
    /// `Ok(Some((version, hash)))` if a PUT happened, or `Err(errno)`.
    pub async fn release_close(&self, fh: u64) -> std::result::Result<Option<(u64, String)>, i32> {
        let open = {
            let mut map = self.open_files.lock().await;
            map.remove(&fh).ok_or(libc::EBADF)?
        };
        // Always remove the working copy at the end.
        let _cleanup = TempCleanup::new(open.tmp_path.clone());

        if !open.dirty {
            return Ok(None);
        }

        let bytes = std::fs::read(&open.tmp_path).map_err(|_| libc::EIO)?;
        let hash = sha256_hex(&bytes);
        if hash == open.base_hash {
            // Dedup short-circuit.
            return Ok(None);
        }

        let req = Request::OpenWrite {
            drive: open.drive.clone(),
            path: open.path.clone(),
            base_version: open.base_version,
            content_hash: hash.clone(),
            bytes: bytes.clone(),
        };
        match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::OpenWrite {
                version,
                content_hash,
                ..
            } => {
                // Bust readdir cache for the parent dir.
                self.readdir_cache
                    .invalidate(&(open.drive.clone(), parent_dir(&open.path).to_string()));
                self.getattr_cache.clear();
                Ok(Some((version, content_hash)))
            }
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                let errno = crate::errno::map(http_status, c);
                // For conflicts, fire-and-forget RecordConflict via IPC. The
                // daemon owns the actual NDJSON writer in v1.
                if matches!(c, Some(crate::errno::ErrorCode::EditConflict)) {
                    let rec = Request::RecordConflict {
                        drive: open.drive.clone(),
                        path: open.path.clone(),
                        base_version: open.base_version.unwrap_or(0),
                        head_version: 0,
                        base_hash: open.base_hash.clone(),
                        attempted_hash: hash.clone(),
                        bytes: bytes.len() as u64,
                    };
                    let _ = self.ipc.send(rec).await;
                }
                Err(errno)
            }
            _ => Err(libc::EIO),
        }
    }

    // -----------------------------------------------------------------------
    // Helpers used by the fuser::Filesystem trait callbacks
    // -----------------------------------------------------------------------

    /// Resolve `(parent_ino, name)` → child `FsNode`, fetching via IPC if
    /// the inode hasn't been seen before. Used by `lookup` and `unlink` /
    /// `rmdir` / `rename`.
    pub async fn resolve_child(
        &self,
        parent_ino: u64,
        name: &str,
    ) -> std::result::Result<FsNode, i32> {
        let parent = self.get_inode(parent_ino).await.ok_or(libc::ENOENT)?;

        // Root-level lookups are virtual: each entry is either a drive
        // (Dir) or the `current` symlink.
        if parent_ino == ROOT_INODE {
            if name == "current" {
                let node = FsNode {
                    inode: 0,
                    kind: NodeKind::Symlink,
                    drive: String::new(),
                    path: "/current".into(),
                    head_version: None,
                    content_hash: None,
                    size: 0,
                    mtime_unix: 0,
                };
                let ino = self.insert_inode(node.clone()).await;
                return Ok(FsNode { inode: ino, ..node });
            }
            // Otherwise it must be a drive slug — confirm via ListDrives.
            let drives = self.list_drives_cached().await?;
            for d in &drives {
                if d.slug == name {
                    let node = FsNode {
                        inode: 0,
                        kind: NodeKind::Dir,
                        drive: d.slug.clone(),
                        path: "/".into(),
                        head_version: None,
                        content_hash: None,
                        size: 0,
                        mtime_unix: 0,
                    };
                    let ino = self.insert_inode(node.clone()).await;
                    return Ok(FsNode { inode: ino, ..node });
                }
            }
            return Err(libc::ENOENT);
        }

        // Below the root we live inside a drive — join the parent's path
        // and ask the daemon for the child's attrs.
        let child_path = join_path(&parent.path, name);
        let req = Request::GetAttr {
            drive: parent.drive.clone(),
            path: child_path.clone(),
        };
        let attr = match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::Attr(a) => a,
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                return Err(crate::errno::map(http_status, c));
            }
            _ => return Err(libc::EIO),
        };

        let node = FsNode {
            inode: 0,
            kind: attr.kind,
            drive: parent.drive.clone(),
            path: child_path,
            head_version: attr.version,
            content_hash: attr.content_hash.clone(),
            size: attr.size,
            mtime_unix: attr.mtime_unix,
        };
        let ino = self.insert_inode(node.clone()).await;
        Ok(FsNode { inode: ino, ..node })
    }

    /// Walk the root + drive layout to produce `(ino, name, kind)` entries
    /// for a `readdir`.
    pub async fn readdir_entries(
        &self,
        ino: u64,
    ) -> std::result::Result<Vec<(u64, String, NodeKind)>, i32> {
        let node = self.get_inode(ino).await.ok_or(libc::ENOENT)?;
        if ino == ROOT_INODE {
            let drives = self.list_drives_cached().await?;
            let entries = root_readdir_entries(&drives);
            let mut out = Vec::with_capacity(entries.len());
            for (name, kind) in entries {
                let path = if kind == NodeKind::Symlink {
                    "/current".to_string()
                } else {
                    "/".to_string()
                };
                let child = FsNode {
                    inode: 0,
                    kind,
                    drive: if kind == NodeKind::Symlink {
                        String::new()
                    } else {
                        name.clone()
                    },
                    path,
                    head_version: None,
                    content_hash: None,
                    size: 0,
                    mtime_unix: 0,
                };
                let cino = self.insert_inode(child).await;
                out.push((cino, name, kind));
            }
            return Ok(out);
        }

        // Cache lookup for non-root readdirs.
        let cache_key = (node.drive.clone(), node.path.clone());
        if let Some(cached) = self.readdir_cache.get(&cache_key) {
            return Ok(cached.into_iter().map(|(n, k, i)| (i, n, k)).collect());
        }
        let req = Request::ReadDir {
            drive: node.drive.clone(),
            path: node.path.clone(),
        };
        let entries = match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::DirEntries(v) => v,
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                return Err(crate::errno::map(http_status, c));
            }
            _ => return Err(libc::EIO),
        };

        let mut out = Vec::with_capacity(entries.len());
        let mut cache_val = Vec::with_capacity(entries.len());
        for e in entries {
            let child_path = join_path(&node.path, &e.name);
            let child = FsNode {
                inode: 0,
                kind: e.kind,
                drive: node.drive.clone(),
                path: child_path,
                head_version: e.version,
                content_hash: e.content_hash.clone(),
                size: e.size,
                mtime_unix: e.mtime_unix,
            };
            let cino = self.insert_inode(child).await;
            out.push((cino, e.name.clone(), e.kind));
            cache_val.push((e.name, e.kind, cino));
        }
        self.readdir_cache.insert(cache_key, cache_val);
        Ok(out)
    }

    async fn list_drives_cached(&self) -> std::result::Result<Vec<crate::ipc::DriveInfo>, i32> {
        let req = Request::ListDrives;
        match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::Drives(v) => Ok(v),
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                Err(crate::errno::map(http_status, c))
            }
            _ => Err(libc::EIO),
        }
    }

    /// Stat a node by inode. Falls back to IPC `GetAttr` on cache miss.
    pub async fn stat_inode(
        &self,
        ino: u64,
    ) -> std::result::Result<(NodeKind, u64, i64, u32), i32> {
        let node = self.get_inode(ino).await.ok_or(libc::ENOENT)?;

        // Root + drive roots are virtual directories — no IPC needed.
        if ino == ROOT_INODE || node.path == "/" {
            return Ok((NodeKind::Dir, 0, 0, 0o755));
        }
        if matches!(node.kind, NodeKind::Symlink) {
            // Just the synthetic "current" symlink for now.
            return Ok((NodeKind::Symlink, 0, 0, 0o777));
        }
        // Re-fetch attrs to keep size + mtime fresh.
        let req = Request::GetAttr {
            drive: node.drive.clone(),
            path: node.path.clone(),
        };
        match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::Attr(a) => {
                let mode = match a.kind {
                    NodeKind::Dir => 0o755,
                    NodeKind::File => 0o644,
                    NodeKind::Symlink => 0o777,
                };
                Ok((a.kind, a.size, a.mtime_unix, mode))
            }
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                Err(crate::errno::map(http_status, c))
            }
            _ => Err(libc::EIO),
        }
    }

    pub async fn unlink_path(&self, parent_ino: u64, name: &str) -> std::result::Result<(), i32> {
        let parent = self.get_inode(parent_ino).await.ok_or(libc::ENOENT)?;
        if parent_ino == ROOT_INODE {
            return Err(libc::EROFS);
        }
        let path = join_path(&parent.path, name);
        let req = Request::Unlink {
            drive: parent.drive.clone(),
            path,
        };
        match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::Ok => {
                self.readdir_cache
                    .invalidate(&(parent.drive.clone(), parent.path.clone()));
                Ok(())
            }
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                Err(crate::errno::map(http_status, c))
            }
            _ => Err(libc::EIO),
        }
    }

    pub async fn rename_path(
        &self,
        parent_ino: u64,
        name: &str,
        newparent_ino: u64,
        newname: &str,
    ) -> std::result::Result<(), i32> {
        let parent = self.get_inode(parent_ino).await.ok_or(libc::ENOENT)?;
        let newparent = self.get_inode(newparent_ino).await.ok_or(libc::ENOENT)?;
        if parent_ino == ROOT_INODE || newparent_ino == ROOT_INODE {
            return Err(libc::EROFS);
        }
        if parent.drive != newparent.drive {
            // Cross-drive renames aren't supported in v1; surface EXDEV so
            // userspace `mv` falls back to copy+remove.
            return Err(libc::EXDEV);
        }
        let from = join_path(&parent.path, name);
        let to = join_path(&newparent.path, newname);
        let req = Request::Rename {
            drive: parent.drive.clone(),
            from_path: from,
            to_drive: parent.drive.clone(),
            to_path: to,
        };
        match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::Ok => {
                self.readdir_cache
                    .invalidate(&(parent.drive.clone(), parent.path.clone()));
                self.readdir_cache
                    .invalidate(&(newparent.drive.clone(), newparent.path.clone()));
                Ok(())
            }
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                Err(crate::errno::map(http_status, c))
            }
            _ => Err(libc::EIO),
        }
    }

    pub async fn mkdir_path(
        &self,
        parent_ino: u64,
        name: &str,
    ) -> std::result::Result<FsNode, i32> {
        let parent = self.get_inode(parent_ino).await.ok_or(libc::ENOENT)?;
        if parent_ino == ROOT_INODE {
            // Drive creation goes through the CLI, not the mount.
            return Err(libc::EROFS);
        }
        let path = join_path(&parent.path, name);
        let req = Request::Mkdir {
            drive: parent.drive.clone(),
            path: path.clone(),
        };
        match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::Ok => {
                let node = FsNode {
                    inode: 0,
                    kind: NodeKind::Dir,
                    drive: parent.drive.clone(),
                    path,
                    head_version: None,
                    content_hash: None,
                    size: 0,
                    mtime_unix: now_unix(),
                };
                let ino = self.insert_inode(node.clone()).await;
                self.readdir_cache
                    .invalidate(&(parent.drive.clone(), parent.path.clone()));
                Ok(FsNode { inode: ino, ..node })
            }
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                Err(crate::errno::map(http_status, c))
            }
            _ => Err(libc::EIO),
        }
    }

    pub async fn rmdir_path(&self, parent_ino: u64, name: &str) -> std::result::Result<(), i32> {
        let parent = self.get_inode(parent_ino).await.ok_or(libc::ENOENT)?;
        if parent_ino == ROOT_INODE {
            return Err(libc::EROFS);
        }
        let path = join_path(&parent.path, name);
        let req = Request::Rmdir {
            drive: parent.drive.clone(),
            path,
        };
        match self.ipc.send(req).await.map_err(|_| libc::EIO)? {
            Response::Ok => {
                self.readdir_cache
                    .invalidate(&(parent.drive.clone(), parent.path.clone()));
                Ok(())
            }
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                Err(crate::errno::map(http_status, c))
            }
            _ => Err(libc::EIO),
        }
    }

    pub async fn readlink_root_current(&self) -> std::result::Result<String, i32> {
        match self
            .ipc
            .send(Request::DefaultDriveSlug)
            .await
            .map_err(|_| libc::EIO)?
        {
            Response::DefaultDriveSlug(Some(slug)) => Ok(current_symlink_target(&slug)),
            Response::DefaultDriveSlug(None) => Err(libc::ENOENT),
            Response::Error {
                http_status, code, ..
            } => {
                let c = code.as_deref().map(crate::errno::ErrorCode::parse_code);
                Err(crate::errno::map(http_status, c))
            }
            _ => Err(libc::EIO),
        }
    }

    /// Per-pid temp-dir GC. Call on startup to clean dead-PID dirs in
    /// `${AGENT_FS_HOME}/mount/`. Best-effort; failures are logged not fatal.
    pub fn gc_dead_pid_dirs(home: &std::path::Path) {
        let mount_dir = home.join("mount");
        let Ok(entries) = std::fs::read_dir(&mount_dir) else {
            return;
        };
        for ent in entries.flatten() {
            let name = ent.file_name();
            let Some(name) = name.to_str() else { continue };
            let Ok(pid) = name.parse::<i32>() else {
                continue;
            };
            if !pid_alive(pid) {
                let _ = std::fs::remove_dir_all(ent.path());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// fuser::Filesystem trait impl on a newtype around `Arc<AgentFsFs<I>>`.
//
// The newtype is required so the trait impl can `Clone` the inner Arc into
// per-callback closures (the trait callbacks take `&self`, not `&mut self`).
// ---------------------------------------------------------------------------

pub struct FuserAdapter<I: IpcTrait> {
    pub inner: Arc<AgentFsFs<I>>,
}

impl<I: IpcTrait> FuserAdapter<I> {
    pub fn new(fs: AgentFsFs<I>) -> Self {
        Self {
            inner: Arc::new(fs),
        }
    }
}

const TTL: Duration = Duration::from_secs(1);

fn make_file_attr(
    ino: u64,
    kind: NodeKind,
    size: u64,
    mtime_unix: i64,
    mode: u32,
    uid: u32,
    gid: u32,
) -> fuser::FileAttr {
    let mtime = unix_to_systemtime(mtime_unix);
    fuser::FileAttr {
        ino: fuser::INodeNo(ino),
        size,
        blocks: size.div_ceil(512),
        atime: mtime,
        mtime,
        ctime: mtime,
        crtime: mtime,
        kind: match kind {
            NodeKind::File => fuser::FileType::RegularFile,
            NodeKind::Dir => fuser::FileType::Directory,
            NodeKind::Symlink => fuser::FileType::Symlink,
        },
        perm: mode as u16,
        nlink: if matches!(kind, NodeKind::Dir) { 2 } else { 1 },
        uid,
        gid,
        rdev: 0,
        blksize: 4096,
        flags: 0,
    }
}

impl<I: IpcTrait> fuser::Filesystem for FuserAdapter<I> {
    fn init(
        &mut self,
        _req: &fuser::Request,
        _config: &mut fuser::KernelConfig,
    ) -> std::result::Result<(), std::io::Error> {
        tracing::info!("fuse init");
        Ok(())
    }

    fn destroy(&mut self) {
        tracing::info!("fuse destroy");
        // Clean up our per-pid working-copy dir on the way out.
        let workdir = self.inner.mount_workdir.clone();
        let _ = std::fs::remove_dir_all(&workdir);
    }

    fn lookup(
        &self,
        _req: &fuser::Request,
        parent: fuser::INodeNo,
        name: &OsStr,
        reply: fuser::ReplyEntry,
    ) {
        let inner = self.inner.clone();
        let name = match name.to_str() {
            Some(n) => n.to_string(),
            None => {
                reply.error(fuser::Errno::EINVAL);
                return;
            }
        };
        let handle = inner.handle.clone();
        match handle.block_on(inner.resolve_child(parent.0, &name)) {
            Ok(node) => {
                let (kind, size, mtime, mode) = (
                    node.kind,
                    node.size,
                    node.mtime_unix,
                    match node.kind {
                        NodeKind::Dir => 0o755,
                        NodeKind::File => 0o644,
                        NodeKind::Symlink => 0o777,
                    },
                );
                let attr =
                    make_file_attr(node.inode, kind, size, mtime, mode, inner.uid, inner.gid);
                reply.entry(&TTL, &attr, fuser::Generation(0));
            }
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn getattr(
        &self,
        _req: &fuser::Request,
        ino: fuser::INodeNo,
        _fh: Option<fuser::FileHandle>,
        reply: fuser::ReplyAttr,
    ) {
        let inner = self.inner.clone();
        let handle = inner.handle.clone();
        match handle.block_on(inner.stat_inode(ino.0)) {
            Ok((kind, size, mtime, mode)) => {
                let attr = make_file_attr(ino.0, kind, size, mtime, mode, inner.uid, inner.gid);
                reply.attr(&TTL, &attr);
            }
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn setattr(
        &self,
        _req: &fuser::Request,
        ino: fuser::INodeNo,
        _mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        size: Option<u64>,
        _atime: Option<fuser::TimeOrNow>,
        _mtime: Option<fuser::TimeOrNow>,
        _ctime: Option<SystemTime>,
        fh: Option<fuser::FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<fuser::BsdFileFlags>,
        reply: fuser::ReplyAttr,
    ) {
        let inner = self.inner.clone();
        // We accept chmod/chown/utimens as no-ops (return current attrs).
        // A real truncate goes through the working copy if the file is open.
        if let (Some(new_size), Some(fh)) = (size, fh) {
            let handle = inner.handle.clone();
            if let Err(e) = handle.block_on(inner.truncate_local(fh.0, new_size)) {
                reply.error(map_errno(e));
                return;
            }
        }
        let handle = inner.handle.clone();
        match handle.block_on(inner.stat_inode(ino.0)) {
            Ok((kind, cur_size, mtime, mode)) => {
                let final_size = size.unwrap_or(cur_size);
                let attr =
                    make_file_attr(ino.0, kind, final_size, mtime, mode, inner.uid, inner.gid);
                reply.attr(&TTL, &attr);
            }
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn readlink(&self, _req: &fuser::Request, ino: fuser::INodeNo, reply: fuser::ReplyData) {
        let inner = self.inner.clone();
        let handle = inner.handle.clone();
        // Only the synthetic root "/current" is a symlink in v1.
        let node = match handle.block_on(inner.get_inode(ino.0)) {
            Some(n) => n,
            None => {
                reply.error(fuser::Errno::ENOENT);
                return;
            }
        };
        if !matches!(node.kind, NodeKind::Symlink) {
            reply.error(fuser::Errno::EINVAL);
            return;
        }
        match handle.block_on(inner.readlink_root_current()) {
            Ok(target) => reply.data(target.as_bytes()),
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn mkdir(
        &self,
        _req: &fuser::Request,
        parent: fuser::INodeNo,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        reply: fuser::ReplyEntry,
    ) {
        let inner = self.inner.clone();
        let name = match name.to_str() {
            Some(n) => n.to_string(),
            None => {
                reply.error(fuser::Errno::EINVAL);
                return;
            }
        };
        let handle = inner.handle.clone();
        match handle.block_on(inner.mkdir_path(parent.0, &name)) {
            Ok(node) => {
                let attr = make_file_attr(
                    node.inode,
                    node.kind,
                    node.size,
                    node.mtime_unix,
                    0o755,
                    inner.uid,
                    inner.gid,
                );
                reply.entry(&TTL, &attr, fuser::Generation(0));
            }
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn unlink(
        &self,
        _req: &fuser::Request,
        parent: fuser::INodeNo,
        name: &OsStr,
        reply: fuser::ReplyEmpty,
    ) {
        let inner = self.inner.clone();
        let name = match name.to_str() {
            Some(n) => n.to_string(),
            None => {
                reply.error(fuser::Errno::EINVAL);
                return;
            }
        };
        let handle = inner.handle.clone();
        match handle.block_on(inner.unlink_path(parent.0, &name)) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn rmdir(
        &self,
        _req: &fuser::Request,
        parent: fuser::INodeNo,
        name: &OsStr,
        reply: fuser::ReplyEmpty,
    ) {
        let inner = self.inner.clone();
        let name = match name.to_str() {
            Some(n) => n.to_string(),
            None => {
                reply.error(fuser::Errno::EINVAL);
                return;
            }
        };
        let handle = inner.handle.clone();
        match handle.block_on(inner.rmdir_path(parent.0, &name)) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn rename(
        &self,
        _req: &fuser::Request,
        parent: fuser::INodeNo,
        name: &OsStr,
        newparent: fuser::INodeNo,
        newname: &OsStr,
        _flags: fuser::RenameFlags,
        reply: fuser::ReplyEmpty,
    ) {
        let inner = self.inner.clone();
        let (name, newname) = match (name.to_str(), newname.to_str()) {
            (Some(a), Some(b)) => (a.to_string(), b.to_string()),
            _ => {
                reply.error(fuser::Errno::EINVAL);
                return;
            }
        };
        let handle = inner.handle.clone();
        match handle.block_on(inner.rename_path(parent.0, &name, newparent.0, &newname)) {
            Ok(()) => reply.ok(),
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn open(
        &self,
        _req: &fuser::Request,
        ino: fuser::INodeNo,
        _flags: fuser::OpenFlags,
        reply: fuser::ReplyOpen,
    ) {
        let inner = self.inner.clone();
        let handle = inner.handle.clone();
        let node = match handle.block_on(inner.get_inode(ino.0)) {
            Some(n) => n,
            None => {
                reply.error(fuser::Errno::ENOENT);
                return;
            }
        };
        if !matches!(node.kind, NodeKind::File) {
            reply.error(fuser::Errno::EISDIR);
            return;
        }
        match handle.block_on(inner.open_for_read(&node.drive, &node.path)) {
            Ok(fh) => reply.opened(fuser::FileHandle(fh), fuser::FopenFlags::empty()),
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn read(
        &self,
        _req: &fuser::Request,
        _ino: fuser::INodeNo,
        fh: fuser::FileHandle,
        offset: u64,
        size: u32,
        _flags: fuser::OpenFlags,
        _lock_owner: Option<fuser::LockOwner>,
        reply: fuser::ReplyData,
    ) {
        let inner = self.inner.clone();
        let handle = inner.handle.clone();
        match handle.block_on(inner.read_local(fh.0, offset, size)) {
            Ok(bytes) => reply.data(&bytes),
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn write(
        &self,
        _req: &fuser::Request,
        _ino: fuser::INodeNo,
        fh: fuser::FileHandle,
        offset: u64,
        data: &[u8],
        _write_flags: fuser::WriteFlags,
        _flags: fuser::OpenFlags,
        _lock_owner: Option<fuser::LockOwner>,
        reply: fuser::ReplyWrite,
    ) {
        let inner = self.inner.clone();
        let handle = inner.handle.clone();
        match handle.block_on(inner.write_local(fh.0, offset, data)) {
            Ok(n) => reply.written(n),
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn flush(
        &self,
        _req: &fuser::Request,
        _ino: fuser::INodeNo,
        _fh: fuser::FileHandle,
        _lock_owner: fuser::LockOwner,
        reply: fuser::ReplyEmpty,
    ) {
        // Open-to-close consistency: flush is a no-op; PUT happens on release.
        reply.ok();
    }

    fn release(
        &self,
        _req: &fuser::Request,
        _ino: fuser::INodeNo,
        fh: fuser::FileHandle,
        _flags: fuser::OpenFlags,
        _lock_owner: Option<fuser::LockOwner>,
        _flush: bool,
        reply: fuser::ReplyEmpty,
    ) {
        let inner = self.inner.clone();
        let handle = inner.handle.clone();
        match handle.block_on(inner.release_close(fh.0)) {
            Ok(_) => reply.ok(),
            Err(e) => reply.error(map_errno(e)),
        }
    }

    fn create(
        &self,
        _req: &fuser::Request,
        parent: fuser::INodeNo,
        name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: fuser::ReplyCreate,
    ) {
        let inner = self.inner.clone();
        let handle = inner.handle.clone();
        let name = match name.to_str() {
            Some(n) => n.to_string(),
            None => {
                reply.error(fuser::Errno::EINVAL);
                return;
            }
        };
        let parent_node = match handle.block_on(inner.get_inode(parent.0)) {
            Some(n) => n,
            None => {
                reply.error(fuser::Errno::ENOENT);
                return;
            }
        };
        if parent.0 == ROOT_INODE {
            reply.error(fuser::Errno::EROFS);
            return;
        }
        let path = join_path(&parent_node.path, &name);
        let fh = match handle.block_on(inner.create_local(&parent_node.drive, &path)) {
            Ok(h) => h,
            Err(e) => {
                reply.error(map_errno(e));
                return;
            }
        };
        // Mint an inode for the new file. Until release_close runs the file
        // has no remote head; we record size=0/mtime=now optimistically.
        let node = FsNode {
            inode: 0,
            kind: NodeKind::File,
            drive: parent_node.drive.clone(),
            path: path.clone(),
            head_version: None,
            content_hash: None,
            size: 0,
            mtime_unix: now_unix(),
        };
        let ino_handle = handle.clone();
        let ino = ino_handle.block_on(inner.insert_inode(node.clone()));
        let attr = make_file_attr(
            ino,
            NodeKind::File,
            0,
            now_unix(),
            0o644,
            inner.uid,
            inner.gid,
        );
        reply.created(
            &TTL,
            &attr,
            fuser::Generation(0),
            fuser::FileHandle(fh),
            fuser::FopenFlags::empty(),
        );
    }

    fn readdir(
        &self,
        _req: &fuser::Request,
        ino: fuser::INodeNo,
        _fh: fuser::FileHandle,
        offset: u64,
        mut reply: fuser::ReplyDirectory,
    ) {
        let inner = self.inner.clone();
        let handle = inner.handle.clone();
        let entries = match handle.block_on(inner.readdir_entries(ino.0)) {
            Ok(v) => v,
            Err(e) => {
                reply.error(map_errno(e));
                return;
            }
        };
        // Synthesize "." and ".." at offsets 0 and 1; real entries start at 2.
        let synthetic = vec![
            (ino.0, ".".to_string(), NodeKind::Dir),
            (ino.0, "..".to_string(), NodeKind::Dir),
        ];
        let all: Vec<(u64, String, NodeKind)> = synthetic.into_iter().chain(entries).collect();
        for (i, (cino, name, kind)) in all.into_iter().enumerate().skip(offset as usize) {
            let ftype = match kind {
                NodeKind::Dir => fuser::FileType::Directory,
                NodeKind::File => fuser::FileType::RegularFile,
                NodeKind::Symlink => fuser::FileType::Symlink,
            };
            if reply.add(fuser::INodeNo(cino), (i + 1) as u64, ftype, name.as_str()) {
                break;
            }
        }
        reply.ok();
    }

    // No-op stubs (return Ok with current attrs or just Ok). Keeps shell
    // tooling happy without modifying the filesystem.
    fn fsync(
        &self,
        _req: &fuser::Request,
        _ino: fuser::INodeNo,
        _fh: fuser::FileHandle,
        _datasync: bool,
        reply: fuser::ReplyEmpty,
    ) {
        reply.ok();
    }

    fn fsyncdir(
        &self,
        _req: &fuser::Request,
        _ino: fuser::INodeNo,
        _fh: fuser::FileHandle,
        _datasync: bool,
        reply: fuser::ReplyEmpty,
    ) {
        reply.ok();
    }

    fn access(
        &self,
        _req: &fuser::Request,
        _ino: fuser::INodeNo,
        _mask: fuser::AccessFlags,
        reply: fuser::ReplyEmpty,
    ) {
        reply.ok();
    }
}

fn map_errno(e: i32) -> fuser::Errno {
    // Map libc errno into fuser::Errno. fuser's Errno is a thin wrapper
    // around the integer; we round-trip via the i32.
    fuser::Errno::from_i32(e)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn write_perm_0600(p: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(p)?;
    f.write_all(bytes)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(out, "{:02x}", b);
    }
    out
}

fn parent_dir(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) => "/",
        Some(i) => &path[..i],
        None => "/",
    }
}

fn join_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{}", name)
    } else if parent.ends_with('/') {
        format!("{}{}", parent, name)
    } else {
        format!("{}/{}", parent, name)
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn unix_to_systemtime(secs: i64) -> SystemTime {
    if secs >= 0 {
        UNIX_EPOCH + Duration::from_secs(secs as u64)
    } else {
        UNIX_EPOCH - Duration::from_secs((-secs) as u64)
    }
}

fn pid_alive(pid: i32) -> bool {
    // kill(pid, 0): returns 0 if signalable, -1 with ESRCH if not.
    // SAFETY: this is the documented liveness check.
    let r = unsafe { libc::kill(pid, 0) };
    if r == 0 {
        return true;
    }
    // EPERM means the process exists but we can't signal it — still alive.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// RAII cleanup of a working-copy file. Used to make sure `release_close`
/// always removes the tmp file regardless of early-return path.
struct TempCleanup(PathBuf);
impl TempCleanup {
    fn new(p: PathBuf) -> Self {
        Self(p)
    }
}
impl Drop for TempCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Tests — drive the inner FS with a MockIpc to cover the working-copy paths
// and the new callback-helper methods.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::{DirEntry, DriveInfo, MockIpc};
    use std::sync::Arc;
    use tempfile::TempDir;

    fn build(
        handler: impl Fn(Request) -> Response + Send + Sync + 'static,
    ) -> (AgentFsFs<MockIpc>, TempDir, Arc<MockIpc>) {
        let tmp = TempDir::new().unwrap();
        let workdir = tmp
            .path()
            .join("mount")
            .join(std::process::id().to_string());
        std::fs::create_dir_all(&workdir).unwrap();
        let ipc = Arc::new(MockIpc::new(handler));
        let handle = Handle::current();
        let fs = AgentFsFs::new(handle, ipc.clone(), workdir, std::process::id());
        (fs, tmp, ipc)
    }

    #[tokio::test]
    async fn create_write_release_round_trips() {
        let (fs, _tmp, ipc) = build(|req| match req {
            Request::OpenWrite {
                bytes: _,
                content_hash,
                ..
            } => Response::OpenWrite {
                version: 1,
                content_hash,
                deduped: false,
            },
            _ => Response::Ok,
        });
        let fh = fs.create_local("brain", "/scratch.md").await.unwrap();
        let n = fs.write_local(fh, 0, b"hello").await.unwrap();
        assert_eq!(n, 5);
        let out = fs.release_close(fh).await.unwrap();
        assert!(out.is_some());
        let (version, hash) = out.unwrap();
        assert_eq!(version, 1);
        assert_eq!(hash, sha256_hex(b"hello"));
        // Confirm IPC saw an OpenWrite with the expected hash.
        let log = ipc.log.lock().await;
        let has_write = log.iter().any(|r| matches!(r, Request::OpenWrite { .. }));
        assert!(has_write);
    }

    #[tokio::test]
    async fn hash_dedup_short_circuits_put() {
        // OpenRead returns "hello"/v3. Caller writes the same bytes back.
        let (fs, _tmp, ipc) = build(move |req| match req {
            Request::OpenRead { .. } => Response::OpenRead {
                bytes: b"hello".to_vec(),
                version: 3,
                content_hash: sha256_hex(b"hello"),
                size: 5,
                mtime_unix: 0,
            },
            _ => Response::Ok,
        });
        let fh = fs.open_for_read("brain", "/h.md").await.unwrap();
        // Mark dirty by writing identical bytes.
        fs.write_local(fh, 0, b"hello").await.unwrap();
        let out = fs.release_close(fh).await.unwrap();
        assert!(out.is_none(), "dedup must short-circuit the PUT");
        // No OpenWrite request should have been sent.
        let log = ipc.log.lock().await;
        assert!(!log.iter().any(|r| matches!(r, Request::OpenWrite { .. })));
    }

    #[tokio::test]
    async fn conflict_returns_eio_and_records() {
        let (fs, _tmp, ipc) = build(|req| match req {
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
        // RecordConflict must have been sent after the failed OpenWrite.
        let log = ipc.log.lock().await;
        assert!(log
            .iter()
            .any(|r| matches!(r, Request::RecordConflict { .. })));
    }

    #[tokio::test]
    async fn truncate_marks_dirty_and_resizes_local() {
        let (fs, _tmp, _ipc) = build(|_| Response::Ok);
        let fh = fs.create_local("brain", "/t.md").await.unwrap();
        fs.write_local(fh, 0, b"abcdef").await.unwrap();
        fs.truncate_local(fh, 3).await.unwrap();
        let buf = fs.read_local(fh, 0, 10).await.unwrap();
        assert_eq!(buf, b"abc");
    }

    #[tokio::test]
    async fn resolve_child_at_root_maps_drive_to_inode() {
        let (fs, _tmp, _ipc) = build(|req| match req {
            Request::ListDrives => Response::Drives(vec![DriveInfo {
                slug: "brain".into(),
                id: "d1".into(),
                org_id: "o1".into(),
            }]),
            _ => Response::Ok,
        });
        let node = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
        assert_eq!(node.drive, "brain");
        assert_eq!(node.kind, NodeKind::Dir);
        assert!(node.inode >= 2);
    }

    #[tokio::test]
    async fn resolve_child_below_root_uses_get_attr() {
        let (fs, _tmp, _ipc) = build(|req| match req {
            Request::ListDrives => Response::Drives(vec![DriveInfo {
                slug: "brain".into(),
                id: "d1".into(),
                org_id: "o1".into(),
            }]),
            Request::GetAttr { .. } => Response::Attr(AttrInfo {
                kind: NodeKind::File,
                size: 42,
                mtime_unix: 1700000000,
                version: Some(2),
                content_hash: Some("abc".into()),
            }),
            _ => Response::Ok,
        });
        let drive_node = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
        let file_node = fs.resolve_child(drive_node.inode, "x.md").await.unwrap();
        assert_eq!(file_node.kind, NodeKind::File);
        assert_eq!(file_node.size, 42);
        assert_eq!(file_node.path, "/x.md");
    }

    #[tokio::test]
    async fn readdir_root_lists_drives_plus_current_symlink() {
        let (fs, _tmp, _ipc) = build(|req| match req {
            Request::ListDrives => Response::Drives(vec![
                DriveInfo {
                    slug: "alpha".into(),
                    id: "d1".into(),
                    org_id: "o1".into(),
                },
                DriveInfo {
                    slug: "beta".into(),
                    id: "d2".into(),
                    org_id: "o1".into(),
                },
            ]),
            _ => Response::Ok,
        });
        let entries = fs.readdir_entries(ROOT_INODE).await.unwrap();
        assert_eq!(entries.len(), 3);
        assert!(entries.iter().any(|(_, n, _)| n == "alpha"));
        assert!(entries.iter().any(|(_, n, _)| n == "beta"));
        assert!(entries
            .iter()
            .any(|(_, n, k)| n == "current" && *k == NodeKind::Symlink));
    }

    #[tokio::test]
    async fn readdir_drive_dir_caches_and_forwards_to_ipc() {
        let (fs, _tmp, ipc) = build(|req| match req {
            Request::ListDrives => Response::Drives(vec![DriveInfo {
                slug: "brain".into(),
                id: "d1".into(),
                org_id: "o1".into(),
            }]),
            Request::ReadDir { .. } => Response::DirEntries(vec![DirEntry {
                name: "x.md".into(),
                kind: NodeKind::File,
                size: 1,
                mtime_unix: 0,
                version: None,
                content_hash: None,
            }]),
            _ => Response::Ok,
        });
        let drive_node = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
        let _ = fs.readdir_entries(drive_node.inode).await.unwrap();
        // Second call should hit the readdir cache.
        let _ = fs.readdir_entries(drive_node.inode).await.unwrap();
        let log = ipc.log.lock().await;
        let read_dir_calls = log
            .iter()
            .filter(|r| matches!(r, Request::ReadDir { .. }))
            .count();
        assert_eq!(read_dir_calls, 1, "second readdir must hit the cache");
    }

    #[tokio::test]
    async fn unlink_forwards_to_ipc_and_busts_cache() {
        let (fs, _tmp, ipc) = build(|req| match req {
            Request::ListDrives => Response::Drives(vec![DriveInfo {
                slug: "brain".into(),
                id: "d1".into(),
                org_id: "o1".into(),
            }]),
            Request::Unlink { .. } => Response::Ok,
            _ => Response::Ok,
        });
        let drive_node = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
        fs.unlink_path(drive_node.inode, "old.md").await.unwrap();
        let log = ipc.log.lock().await;
        assert!(log.iter().any(|r| matches!(r, Request::Unlink { .. })));
    }

    #[tokio::test]
    async fn rename_within_drive_forwards_to_ipc() {
        let (fs, _tmp, ipc) = build(|req| match req {
            Request::ListDrives => Response::Drives(vec![DriveInfo {
                slug: "brain".into(),
                id: "d1".into(),
                org_id: "o1".into(),
            }]),
            Request::Rename { .. } => Response::Ok,
            _ => Response::Ok,
        });
        let drive_node = fs.resolve_child(ROOT_INODE, "brain").await.unwrap();
        fs.rename_path(drive_node.inode, "a.md", drive_node.inode, "b.md")
            .await
            .unwrap();
        let log = ipc.log.lock().await;
        assert!(log.iter().any(|r| matches!(r, Request::Rename { .. })));
    }

    #[tokio::test]
    async fn mkdir_root_returns_erofs() {
        let (fs, _tmp, _ipc) = build(|_| Response::Ok);
        let err = fs.mkdir_path(ROOT_INODE, "new-drive").await.unwrap_err();
        assert_eq!(err, libc::EROFS);
    }

    #[tokio::test]
    async fn readlink_default_drive_returns_relative_target() {
        let (fs, _tmp, _ipc) = build(|req| match req {
            Request::DefaultDriveSlug => Response::DefaultDriveSlug(Some("brain".into())),
            _ => Response::Ok,
        });
        let target = fs.readlink_root_current().await.unwrap();
        assert_eq!(target, "./brain");
    }

    #[test]
    fn parent_dir_extracts_correctly() {
        assert_eq!(parent_dir("/a/b/c.md"), "/a/b");
        assert_eq!(parent_dir("/x.md"), "/");
        assert_eq!(parent_dir("/"), "/");
    }

    #[test]
    fn sha256_hex_deterministic() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn join_path_handles_root_and_nested() {
        assert_eq!(join_path("/", "a"), "/a");
        assert_eq!(join_path("/dir", "a"), "/dir/a");
        assert_eq!(join_path("/dir/", "a"), "/dir/a");
    }
}
