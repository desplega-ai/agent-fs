//! Virtual layout of the mount.
//!
//! Inode 1 (root) is a virtual directory listing all drives plus a `current`
//! symlink. Drive-level mutations (mkdir/unlink/rmdir/rename) at the root
//! return `EROFS`. Real drive creation stays in the CLI.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::ipc::{DriveInfo, NodeKind};

pub const ROOT_INODE: u64 = 1;
/// First inode handed out to non-root nodes.
pub const FIRST_DYN_INODE: u64 = 2;

/// In-memory inode record. Real attrs are fetched via IPC and may differ from
/// what we have cached here; cache stays best-effort.
#[derive(Debug, Clone)]
pub struct FsNode {
    pub inode: u64,
    pub kind: NodeKind,
    pub drive: String,
    /// Path relative to the drive root, always starting with `/`.
    /// The synthetic root inode uses an empty drive and `"/"`.
    pub path: String,
    pub head_version: Option<u64>,
    pub content_hash: Option<String>,
    pub size: u64,
    pub mtime_unix: i64,
}

impl FsNode {
    pub fn root() -> Self {
        Self {
            inode: ROOT_INODE,
            kind: NodeKind::Dir,
            drive: String::new(),
            path: "/".into(),
            head_version: None,
            content_hash: None,
            size: 0,
            mtime_unix: 0,
        }
    }
}

/// Allocator for inode numbers. Synchronously monotonic.
#[derive(Debug)]
pub struct InodeAllocator(AtomicU64);

impl InodeAllocator {
    pub fn new() -> Self {
        Self(AtomicU64::new(FIRST_DYN_INODE))
    }
    pub fn next(&self) -> u64 {
        self.0.fetch_add(1, Ordering::Relaxed)
    }
}

impl Default for InodeAllocator {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute the symlink target string for `<mount>/current`.
///
/// Re-resolved on every readlink (never cached) so a daemon-side default-drive
/// change reflects immediately.
pub fn current_symlink_target(default_slug: &str) -> String {
    format!("./{}", default_slug)
}

/// Render the synthetic root readdir output. Always includes `current` even
/// when no default drive is configured (resolution may still succeed later).
pub fn root_readdir_entries(drives: &[DriveInfo]) -> Vec<(String, NodeKind)> {
    let mut out = Vec::with_capacity(drives.len() + 1);
    for d in drives {
        out.push((d.slug.clone(), NodeKind::Dir));
    }
    out.push(("current".into(), NodeKind::Symlink));
    out
}

/// Mount-side base for per-pid working copies: `${home}/mount/<pid>/`.
pub fn working_copy_dir(home: &std::path::Path, pid: u32) -> PathBuf {
    home.join("mount").join(pid.to_string())
}

/// A minimal TTL-bounded cache, used for readdir + getattr.
///
/// `moka` would be more featureful but is overkill here — we want a tiny
/// `RwLock<HashMap>` with explicit `Instant` stamps so behavior is auditable.
pub struct TtlCache<K, V> {
    inner: std::sync::RwLock<std::collections::HashMap<K, (Instant, V)>>,
    ttl: Duration,
}

impl<K, V> TtlCache<K, V>
where
    K: std::hash::Hash + Eq + Clone,
    V: Clone,
{
    pub fn new(ttl: Duration) -> Self {
        Self {
            inner: std::sync::RwLock::new(std::collections::HashMap::new()),
            ttl,
        }
    }

    pub fn get(&self, k: &K) -> Option<V> {
        let map = self.inner.read().ok()?;
        let (stamp, v) = map.get(k)?;
        if stamp.elapsed() < self.ttl {
            Some(v.clone())
        } else {
            None
        }
    }

    pub fn insert(&self, k: K, v: V) {
        if let Ok(mut map) = self.inner.write() {
            map.insert(k, (Instant::now(), v));
        }
    }

    pub fn invalidate(&self, k: &K) {
        if let Ok(mut map) = self.inner.write() {
            map.remove(k);
        }
    }

    pub fn clear(&self) {
        if let Ok(mut map) = self.inner.write() {
            map.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_readdir_has_current_symlink() {
        let drives = vec![
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
        ];
        let entries = root_readdir_entries(&drives);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].0, "alpha");
        assert_eq!(entries[1].0, "beta");
        assert_eq!(entries[2].0, "current");
        assert_eq!(entries[2].1, NodeKind::Symlink);
    }

    #[test]
    fn current_target_uses_slug() {
        assert_eq!(current_symlink_target("brain"), "./brain");
    }

    #[test]
    fn inode_allocator_starts_at_2() {
        let a = InodeAllocator::new();
        assert_eq!(a.next(), 2);
        assert_eq!(a.next(), 3);
    }

    #[test]
    fn ttl_cache_expires() {
        let c: TtlCache<&str, u32> = TtlCache::new(Duration::from_millis(10));
        c.insert("k", 7);
        assert_eq!(c.get(&"k"), Some(7));
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(c.get(&"k"), None);
    }
}
