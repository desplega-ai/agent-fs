//! agent-fs FUSE helper library surface.
//!
//! Re-exports the modules so integration tests under `tests/` can drive the
//! filesystem and IPC client directly with a `MockIpc` / stub Unix server.
//!
//! The binary entry point lives in `main.rs`.

pub mod errno;
pub mod fs;
pub mod ipc;
pub mod layout;
pub mod sidecar;
