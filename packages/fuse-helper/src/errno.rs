//! HTTP status / agent-fs error-code → libc errno translation.
//!
//! Centralized so the FUSE callbacks never reach for raw integers and the
//! mapping table is easy to audit against the plan.

/// agent-fs structured error code (matches the server's `errors.ts` enum).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Auth,
    PermissionDenied,
    NotFound,
    EditConflict,
    Validation,
    IndexingInProgress,
    /// Any code we don't have a specific mapping for.
    Unknown,
}

impl ErrorCode {
    /// Parse an agent-fs structured error code string.
    ///
    /// Named `parse_code` rather than `from_str` so it doesn't shadow the
    /// standard `FromStr::from_str` (we don't want infallible parsing to
    /// require importing a trait).
    pub fn parse_code(s: &str) -> Self {
        if s.starts_with("AUTH_") {
            return Self::Auth;
        }
        match s {
            "PERMISSION_DENIED" => Self::PermissionDenied,
            "NOT_FOUND" => Self::NotFound,
            "EDIT_CONFLICT" => Self::EditConflict,
            "VALIDATION" => Self::Validation,
            "INDEXING_IN_PROGRESS" => Self::IndexingInProgress,
            _ => Self::Unknown,
        }
    }
}

/// Map an agent-fs response (HTTP status + optional structured code) onto a
/// `libc::E*` value suitable for a FUSE reply.
///
/// Per the plan:
/// - 401 / AUTH_* → EACCES
/// - 403 / PERMISSION_DENIED → EACCES
/// - 404 / NOT_FOUND → ENOENT
/// - 409 / EDIT_CONFLICT → EIO (recorded in conflicts.ndjson first)
/// - 413 → EFBIG
/// - 415 / VALIDATION → EINVAL
/// - 503 / INDEXING_IN_PROGRESS → EAGAIN
/// - everything else → EIO
pub fn map(http_status: u16, code: Option<ErrorCode>) -> i32 {
    if let Some(c) = code {
        match c {
            ErrorCode::Auth | ErrorCode::PermissionDenied => return libc::EACCES,
            ErrorCode::NotFound => return libc::ENOENT,
            ErrorCode::EditConflict => return libc::EIO,
            ErrorCode::Validation => return libc::EINVAL,
            ErrorCode::IndexingInProgress => return libc::EAGAIN,
            ErrorCode::Unknown => {} // fall through to status table
        }
    }
    match http_status {
        401 | 403 => libc::EACCES,
        404 => libc::ENOENT,
        409 => libc::EIO,
        413 => libc::EFBIG,
        415 | 422 => libc::EINVAL,
        503 => libc::EAGAIN,
        _ => libc::EIO,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_prefix_maps_to_eacces() {
        assert_eq!(ErrorCode::parse_code("AUTH_EXPIRED"), ErrorCode::Auth);
        assert_eq!(map(401, Some(ErrorCode::Auth)), libc::EACCES);
    }

    #[test]
    fn known_codes_take_precedence_over_status() {
        // 500 status with NOT_FOUND code should still be ENOENT.
        assert_eq!(map(500, Some(ErrorCode::NotFound)), libc::ENOENT);
    }

    #[test]
    fn conflict_is_eio() {
        assert_eq!(map(409, Some(ErrorCode::EditConflict)), libc::EIO);
        assert_eq!(map(409, None), libc::EIO);
    }

    #[test]
    fn unknown_falls_back_to_eio() {
        assert_eq!(map(599, None), libc::EIO);
        assert_eq!(map(599, Some(ErrorCode::Unknown)), libc::EIO);
    }

    #[test]
    fn size_and_validation() {
        assert_eq!(map(413, None), libc::EFBIG);
        assert_eq!(map(415, Some(ErrorCode::Validation)), libc::EINVAL);
        assert_eq!(map(503, Some(ErrorCode::IndexingInProgress)), libc::EAGAIN);
    }
}
