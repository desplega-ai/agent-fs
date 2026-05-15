//! Conflict + error NDJSON sidecars under `<mount>/.agent-fs/`.
//!
//! NOTE: in v1 the actual writer lives in the Bun daemon (Phase 3). This
//! module models the on-disk schema so:
//! 1. Phase 5 integration tests can deserialize sidecar lines.
//! 2. If the daemon is unreachable the helper has a fallback path for
//!    appending `errors.ndjson` locally.
//!
//! Append-only, ULID-keyed, size-rotated (10 MB → `.1` → `.2` → `.3`),
//! plus an atomically rewritten `conflicts.latest.json` and a single-line
//! `status` file.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const ROTATE_THRESHOLD_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_ROTATIONS: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "schema")]
pub enum SidecarRecord {
    #[serde(rename = "agent-fs.conflict/v1")]
    Conflict(ConflictRecord),
    #[serde(rename = "agent-fs.error/v1")]
    Error(ErrorRecord),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConflictRecord {
    pub id: String,
    pub timestamp: String,
    pub drive: String,
    pub path: String,
    pub base_version: u64,
    pub head_version: u64,
    pub base_hash: String,
    pub attempted_hash: String,
    pub bytes: u64,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorRecord {
    pub id: String,
    pub timestamp: String,
    pub drive: Option<String>,
    pub path: Option<String>,
    pub errno: i32,
    pub http_status: Option<u16>,
    pub code: Option<String>,
    pub message: String,
    pub pid: u32,
}

/// Layout helper. Holds the sidecar directory (`<mount>/.agent-fs/`).
pub struct Sidecar {
    pub dir: PathBuf,
}

impl Sidecar {
    pub fn new(mount: impl AsRef<Path>) -> Self {
        Self {
            dir: mount.as_ref().join(".agent-fs"),
        }
    }

    fn ensure_dir(&self) -> Result<()> {
        fs::create_dir_all(&self.dir)
            .with_context(|| format!("create sidecar dir {}", self.dir.display()))?;
        Ok(())
    }

    /// Append one NDJSON line to `conflicts.ndjson` or `errors.ndjson`,
    /// rotating once size crosses 10 MB.
    pub fn append(&self, record: &SidecarRecord) -> Result<()> {
        self.ensure_dir()?;
        let file_name = match record {
            SidecarRecord::Conflict(_) => "conflicts.ndjson",
            SidecarRecord::Error(_) => "errors.ndjson",
        };
        let target = self.dir.join(file_name);
        if let Ok(meta) = fs::metadata(&target) {
            if meta.len() >= ROTATE_THRESHOLD_BYTES {
                rotate(&target)?;
            }
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&target)
            .with_context(|| format!("open {}", target.display()))?;
        let mut line = serde_json::to_string(record).context("serialize sidecar record")?;
        line.push('\n');
        f.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Atomically rewrite `conflicts.latest.json` with the most recent
    /// conflict. The daemon owns this in production; this helper exists for
    /// the integration tests + local fallback.
    pub fn write_latest_conflict(&self, conflict: &ConflictRecord) -> Result<()> {
        self.ensure_dir()?;
        let target = self.dir.join("conflicts.latest.json");
        let tmp = self.dir.join("conflicts.latest.json.tmp");
        let body = serde_json::to_vec_pretty(conflict)?;
        fs::write(&tmp, body)?;
        fs::rename(&tmp, &target)?;
        Ok(())
    }

    /// Replace `<mount>/.agent-fs/status` with a single-line summary. Caller
    /// is responsible for keeping it short (one line).
    pub fn write_status(&self, line: &str) -> Result<()> {
        self.ensure_dir()?;
        let target = self.dir.join("status");
        let tmp = self.dir.join("status.tmp");
        let mut body = String::from(line);
        if !body.ends_with('\n') {
            body.push('\n');
        }
        fs::write(&tmp, body)?;
        fs::rename(&tmp, &target)?;
        Ok(())
    }

    /// Iterate every line of a sidecar file (test helper).
    pub fn read_lines(&self, file_name: &str) -> Result<Vec<String>> {
        let target = self.dir.join(file_name);
        if !target.exists() {
            return Ok(Vec::new());
        }
        let mut buf = String::new();
        fs::File::open(&target)?.read_to_string(&mut buf)?;
        Ok(buf.lines().map(|s| s.to_string()).collect())
    }
}

fn rotate(target: &Path) -> Result<()> {
    // ndjson → ndjson.1 → ndjson.2 → ndjson.3 (oldest dropped).
    let max = MAX_ROTATIONS;
    let oldest = path_with_suffix(target, max);
    if oldest.exists() {
        fs::remove_file(&oldest).ok();
    }
    for i in (1..max).rev() {
        let src = path_with_suffix(target, i);
        let dst = path_with_suffix(target, i + 1);
        if src.exists() {
            fs::rename(src, dst).ok();
        }
    }
    let first = path_with_suffix(target, 1);
    fs::rename(target, first).ok();
    Ok(())
}

fn path_with_suffix(target: &Path, n: u32) -> PathBuf {
    let mut s = target.as_os_str().to_owned();
    s.push(format!(".{}", n));
    PathBuf::from(s)
}

/// Generate a ULID for a sidecar record id. Tiny helper so call-sites stay
/// terse.
pub fn new_id() -> String {
    ulid::Ulid::new().to_string()
}

/// RFC3339 timestamp for *now*.
pub fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // Minimal RFC3339 without pulling in chrono. Seconds precision is fine for
    // sidecar timestamps; the ULID provides finer ordering.
    let secs = now.as_secs() as i64;
    humantime_seconds_to_rfc3339(secs)
}

fn humantime_seconds_to_rfc3339(secs: i64) -> String {
    // Days from epoch (1970-01-01) using the civil-from-days algorithm.
    let (y, m, d, hh, mm, ss) = civil_from_unix(secs);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, hh, mm, ss)
}

/// Howard Hinnant's days-from-civil algorithm, inverted.
fn civil_from_unix(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400) as u32;
    let hh = rem / 3600;
    let mm = (rem % 3600) / 60;
    let ss = rem % 60;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i32 + era as i32 * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, hh, mm, ss)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn append_creates_file_and_writes_ndjson() {
        let tmp = TempDir::new().unwrap();
        let sc = Sidecar::new(tmp.path());
        sc.append(&SidecarRecord::Error(ErrorRecord {
            id: new_id(),
            timestamp: now_rfc3339(),
            drive: Some("brain".into()),
            path: Some("/x.md".into()),
            errno: libc::EIO,
            http_status: Some(500),
            code: Some("INTERNAL".into()),
            message: "boom".into(),
            pid: 123,
        }))
        .unwrap();
        let lines = sc.read_lines("errors.ndjson").unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("\"schema\":\"agent-fs.error/v1\""));
        assert!(lines[0].contains("\"path\":\"/x.md\""));
    }

    #[test]
    fn write_latest_conflict_is_atomic() {
        let tmp = TempDir::new().unwrap();
        let sc = Sidecar::new(tmp.path());
        let rec = ConflictRecord {
            id: new_id(),
            timestamp: now_rfc3339(),
            drive: "brain".into(),
            path: "/scratch.md".into(),
            base_version: 5,
            head_version: 6,
            base_hash: "aaa".into(),
            attempted_hash: "bbb".into(),
            bytes: 123,
            pid: 99,
        };
        sc.write_latest_conflict(&rec).unwrap();
        let target = tmp.path().join(".agent-fs/conflicts.latest.json");
        assert!(target.exists());
        let buf = fs::read_to_string(target).unwrap();
        let parsed: ConflictRecord = serde_json::from_str(&buf).unwrap();
        assert_eq!(parsed.base_version, 5);
        assert_eq!(parsed.head_version, 6);
    }

    #[test]
    fn rotate_renames_files() {
        let tmp = TempDir::new().unwrap();
        let sc = Sidecar::new(tmp.path());
        sc.ensure_dir().unwrap();
        let target = sc.dir.join("conflicts.ndjson");
        fs::write(&target, b"x").unwrap();
        rotate(&target).unwrap();
        assert!(sc.dir.join("conflicts.ndjson.1").exists());
        assert!(!target.exists());
    }

    #[test]
    fn civil_calendar_known_dates() {
        // 1970-01-01 00:00:00 UTC
        let (y, m, d, _, _, _) = civil_from_unix(0);
        assert_eq!((y, m, d), (1970, 1, 1));
        // 2000-02-29 12:34:56 UTC — leap day sanity.
        let leap = 951_827_696_i64;
        let (y, m, d, hh, mm, ss) = civil_from_unix(leap);
        assert_eq!((y, m, d, hh, mm, ss), (2000, 2, 29, 12, 34, 56));
        // Round-trip: encode an arbitrary recent epoch and confirm format.
        let s = humantime_seconds_to_rfc3339(1_705_276_800);
        assert_eq!(s, "2024-01-15T00:00:00Z");
    }
}
