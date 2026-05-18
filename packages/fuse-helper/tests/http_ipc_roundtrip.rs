//! Integration tests for `HttpIpcClient` (remote-mount transport).
//!
//! Spins up a `wiremock` server per test and asserts the HTTP shape the
//! Rust helper produces for each `Request` variant matches what the
//! `agent-fs` daemon exposes (`packages/server/src/{routes,ipc/handlers}.ts`).
//!
//! Phase 3 landed read-only ops: `Ping`, `Hello`, `ListDrives`,
//! `DefaultDriveSlug`, `GetAttr`, `ReadDir`, `OpenRead`.
//! Phase 4 lights up writes: `OpenWrite`, `CreateFile`, `Truncate`,
//! `Unlink`, `Rename`, `Mkdir`, `Rmdir`, including 409 EDIT_CONFLICT
//! propagation and the cross-drive rename short-circuit to EXDEV.

use agent_fs_fuse::ipc::{HttpIpcClient, IpcTrait, NodeKind, Request, Response};
use serde_json::json;
use wiremock::matchers::{body_json, header, header_exists, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Helper: stand up a wiremock server, mount `/auth/me` + `/orgs` + per-org
/// `/drives` responses so the `HttpIpcClient` can resolve drives.
async fn server_with_default_drive(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/auth/me"))
        .and(header_exists("Authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "userId": "u1",
            "email": "test@example.com",
            "defaultOrgId": "org1",
            "defaultDriveId": "d1",
        })))
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/orgs"))
        .and(header_exists("Authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "orgs": [{ "id": "org1", "name": "Default Org" }],
        })))
        .mount(server)
        .await;

    Mock::given(method("GET"))
        .and(path("/orgs/org1/drives"))
        .and(header_exists("Authorization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "drives": [{ "id": "d1", "name": "brain", "isDefault": true }],
        })))
        .mount(server)
        .await;
}

#[tokio::test]
async fn ping_hits_health_with_bearer_auth() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/health"))
        .and(header("Authorization", "Bearer test-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "ok": true })))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client.send(Request::Ping).await.unwrap();
    assert!(matches!(resp, Response::Pong));
}

#[tokio::test]
async fn list_drives_walks_orgs_then_drives_per_org() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client.send(Request::ListDrives).await.unwrap();
    match resp {
        Response::Drives(drives) => {
            assert_eq!(drives.len(), 1);
            assert_eq!(drives[0].slug, "brain");
            assert_eq!(drives[0].id, "d1");
            assert_eq!(drives[0].org_id, "org1");
        }
        other => panic!("expected Drives, got {:?}", other),
    }
}

#[tokio::test]
async fn default_drive_slug_resolves_via_auth_me_plus_drive_table() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client.send(Request::DefaultDriveSlug).await.unwrap();
    match resp {
        Response::DefaultDriveSlug(Some(slug)) => assert_eq!(slug, "brain"),
        other => panic!("expected DefaultDriveSlug(Some), got {:?}", other),
    }
}

#[tokio::test]
async fn hello_validates_creds_against_auth_me() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Hello {
            client_version: "0.7.0".into(),
            pid: std::process::id(),
        })
        .await
        .unwrap();
    assert!(matches!(resp, Response::Ok));
}

#[tokio::test]
async fn get_attr_posts_stat_op_with_drive_id() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("POST"))
        .and(path("/orgs/org1/ops"))
        .and(header("Authorization", "Bearer test-key"))
        .and(body_json(json!({
            "op": "stat",
            "driveId": "d1",
            "path": "/x.txt",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "path": "/x.txt",
            "size": 42,
            "currentVersion": 3,
            "modifiedAt": "2026-05-18T18:30:00.000Z",
            "author": "test",
            "createdAt": "2026-05-18T18:30:00.000Z",
            "isDeleted": false,
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::GetAttr {
            drive: "brain".into(),
            path: "/x.txt".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::Attr(a) => {
            assert_eq!(a.size, 42);
            assert_eq!(a.kind, NodeKind::File);
            assert_eq!(a.version, Some(3));
        }
        other => panic!("expected Attr, got {:?}", other),
    }
}

#[tokio::test]
async fn read_dir_posts_ls_op_and_maps_entries() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("POST"))
        .and(path("/orgs/org1/ops"))
        .and(body_json(json!({
            "op": "ls",
            "driveId": "d1",
            "path": "/",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "entries": [
                { "name": "a.txt", "type": "file", "size": 10, "modifiedAt": "2026-05-18T18:30:00.000Z" },
                { "name": "sub", "type": "directory", "size": 0 },
            ],
        })))
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::ReadDir {
            drive: "brain".into(),
            path: "/".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::DirEntries(entries) => {
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[0].name, "a.txt");
            assert_eq!(entries[0].kind, NodeKind::File);
            assert_eq!(entries[0].size, 10);
            assert_eq!(entries[1].name, "sub");
            assert_eq!(entries[1].kind, NodeKind::Dir);
        }
        other => panic!("expected DirEntries, got {:?}", other),
    }
}

#[tokio::test]
async fn open_read_hits_files_raw_and_parses_version_headers() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    let body = b"hello world".to_vec();
    Mock::given(method("GET"))
        .and(path("/orgs/org1/drives/d1/files/x.txt/raw"))
        .and(header("Authorization", "Bearer test-key"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(body.clone())
                .insert_header("ETag", "\"7\"")
                .insert_header("X-Agent-FS-Version", "7")
                .insert_header("X-Agent-FS-Content-Hash", "abc123"),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::OpenRead {
            drive: "brain".into(),
            path: "/x.txt".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::OpenRead {
            bytes,
            version,
            content_hash,
            size,
            ..
        } => {
            assert_eq!(bytes, b"hello world");
            assert_eq!(version, 7);
            assert_eq!(content_hash, "abc123");
            assert_eq!(size, 11);
        }
        other => panic!("expected OpenRead, got {:?}", other),
    }
}

#[tokio::test]
async fn open_read_404_returns_error_with_not_found_code() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("GET"))
        .and(path("/orgs/org1/drives/d1/files/missing.txt/raw"))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "error": "NOT_FOUND",
            "message": "File not found",
        })))
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::OpenRead {
            drive: "brain".into(),
            path: "/missing.txt".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::Error {
            http_status, code, ..
        } => {
            assert_eq!(http_status, 404);
            assert_eq!(code.as_deref(), Some("NOT_FOUND"));
        }
        other => panic!("expected Error, got {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// Phase 4: write ops + conflict handling
// ---------------------------------------------------------------------------

#[tokio::test]
async fn open_write_happy_path_returns_new_version() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("PUT"))
        .and(path("/orgs/org1/drives/d1/files/x.txt/raw"))
        .and(header("Authorization", "Bearer test-key"))
        .and(header("If-Match", "3"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("ETag", "\"4\"")
                .insert_header("X-Agent-FS-Version", "4")
                .insert_header("X-Agent-FS-Content-Hash", "newhash")
                .insert_header("X-Agent-FS-Deduped", "0")
                .set_body_json(json!({
                    "path": "/x.txt",
                    "version": 4,
                    "contentHash": "newhash",
                    "deduped": false,
                })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::OpenWrite {
            drive: "brain".into(),
            path: "/x.txt".into(),
            base_version: Some(3),
            content_hash: "oldhash".into(),
            bytes: b"hello world".to_vec(),
        })
        .await
        .unwrap();
    match resp {
        Response::OpenWrite {
            version,
            content_hash,
            deduped,
        } => {
            assert_eq!(version, 4);
            assert_eq!(content_hash, "newhash");
            assert!(!deduped);
        }
        other => panic!("expected OpenWrite, got {:?}", other),
    }
}

#[tokio::test]
async fn open_write_409_returns_edit_conflict_error() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("PUT"))
        .and(path("/orgs/org1/drives/d1/files/x.txt/raw"))
        .and(header("If-Match", "2"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "error": "EDIT_CONFLICT",
            "message": "expected version 2 but head is 3",
            "path": "/x.txt",
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::OpenWrite {
            drive: "brain".into(),
            path: "/x.txt".into(),
            base_version: Some(2),
            content_hash: "h".into(),
            bytes: b"stale".to_vec(),
        })
        .await
        .unwrap();
    match resp {
        Response::Error {
            http_status,
            code,
            message,
        } => {
            assert_eq!(http_status, 409);
            assert_eq!(code.as_deref(), Some("EDIT_CONFLICT"));
            assert!(message.contains("expected version"));
        }
        other => panic!("expected Error(EDIT_CONFLICT), got {:?}", other),
    }
}

#[tokio::test]
async fn create_file_uses_if_none_match_star() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("PUT"))
        .and(path("/orgs/org1/drives/d1/files/new.txt/raw"))
        .and(header("If-None-Match", "*"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("ETag", "\"1\"")
                .insert_header("X-Agent-FS-Version", "1")
                .insert_header("X-Agent-FS-Content-Hash", "empty")
                .insert_header("X-Agent-FS-Deduped", "0")
                .set_body_json(json!({ "version": 1 })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::CreateFile {
            drive: "brain".into(),
            path: "/new.txt".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::OpenWrite { version, .. } => assert_eq!(version, 1),
        other => panic!("expected OpenWrite, got {:?}", other),
    }
}

#[tokio::test]
async fn create_file_409_returns_edit_conflict_error() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("PUT"))
        .and(path("/orgs/org1/drives/d1/files/exists.txt/raw"))
        .and(header("If-None-Match", "*"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "error": "EDIT_CONFLICT",
            "message": "file already exists",
            "path": "/exists.txt",
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::CreateFile {
            drive: "brain".into(),
            path: "/exists.txt".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::Error {
            http_status, code, ..
        } => {
            assert_eq!(http_status, 409);
            assert_eq!(code.as_deref(), Some("EDIT_CONFLICT"));
        }
        other => panic!("expected Error(EDIT_CONFLICT), got {:?}", other),
    }
}

#[tokio::test]
async fn unlink_posts_rm_op() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("POST"))
        .and(path("/orgs/org1/ops"))
        .and(body_json(json!({
            "op": "rm",
            "driveId": "d1",
            "path": "/doomed.txt",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "path": "/doomed.txt",
            "deleted": true,
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Unlink {
            drive: "brain".into(),
            path: "/doomed.txt".into(),
        })
        .await
        .unwrap();
    assert!(matches!(resp, Response::Ok));
}

#[tokio::test]
async fn rename_same_drive_posts_mv_op() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("POST"))
        .and(path("/orgs/org1/ops"))
        .and(body_json(json!({
            "op": "mv",
            "driveId": "d1",
            "from": "/a.txt",
            "to": "/b.txt",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "from": "/a.txt",
            "to": "/b.txt",
            "version": 2,
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Rename {
            drive: "brain".into(),
            from_path: "/a.txt".into(),
            to_drive: "brain".into(),
            to_path: "/b.txt".into(),
        })
        .await
        .unwrap();
    assert!(matches!(resp, Response::Ok));
}

#[tokio::test]
async fn rename_across_drives_short_circuits_to_exdev() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    // Note: NO mv mock — the helper must not hit the server when the
    // rename crosses drives. wiremock will reject any unmatched POST.
    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Rename {
            drive: "brain".into(),
            from_path: "/a.txt".into(),
            to_drive: "other".into(),
            to_path: "/b.txt".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::Error { code, .. } => assert_eq!(code.as_deref(), Some("EXDEV")),
        other => panic!("expected Error(EXDEV), got {:?}", other),
    }
}

#[tokio::test]
async fn mkdir_is_local_noop() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    // No mkdir-shaped mock — `do_mkdir` must not touch the network.
    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Mkdir {
            drive: "brain".into(),
            path: "/newdir".into(),
        })
        .await
        .unwrap();
    assert!(matches!(resp, Response::Ok));
}

#[tokio::test]
async fn rmdir_empty_succeeds() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("POST"))
        .and(path("/orgs/org1/ops"))
        .and(body_json(json!({
            "op": "ls",
            "driveId": "d1",
            "path": "/empty",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "entries": [] })))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Rmdir {
            drive: "brain".into(),
            path: "/empty".into(),
        })
        .await
        .unwrap();
    assert!(matches!(resp, Response::Ok));
}

#[tokio::test]
async fn rmdir_non_empty_returns_validation_error() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    Mock::given(method("POST"))
        .and(path("/orgs/org1/ops"))
        .and(body_json(json!({
            "op": "ls",
            "driveId": "d1",
            "path": "/full",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "entries": [
                { "name": "child.txt", "type": "file", "size": 1 },
            ],
        })))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Rmdir {
            drive: "brain".into(),
            path: "/full".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::Error {
            http_status, code, ..
        } => {
            assert_eq!(http_status, 409);
            assert_eq!(code.as_deref(), Some("VALIDATION"));
        }
        other => panic!("expected Error(VALIDATION), got {:?}", other),
    }
}

#[tokio::test]
async fn truncate_round_trips_via_open_read_then_open_write() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    // GET leg: returns 11-byte body + ETag/version headers.
    Mock::given(method("GET"))
        .and(path("/orgs/org1/drives/d1/files/big.txt/raw"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_bytes(b"hello world".to_vec())
                .insert_header("ETag", "\"5\"")
                .insert_header("X-Agent-FS-Version", "5")
                .insert_header("X-Agent-FS-Content-Hash", "h5"),
        )
        .expect(1)
        .mount(&server)
        .await;

    // PUT leg: must carry the truncated payload (`"hello"`, 5 bytes) and
    // If-Match: 5 from the read.
    Mock::given(method("PUT"))
        .and(path("/orgs/org1/drives/d1/files/big.txt/raw"))
        .and(header("If-Match", "5"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("ETag", "\"6\"")
                .insert_header("X-Agent-FS-Version", "6")
                .insert_header("X-Agent-FS-Content-Hash", "h6")
                .insert_header("X-Agent-FS-Deduped", "0")
                .set_body_json(json!({ "version": 6 })),
        )
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Truncate {
            drive: "brain".into(),
            path: "/big.txt".into(),
            size: 5,
        })
        .await
        .unwrap();
    match resp {
        Response::OpenWrite { version, .. } => assert_eq!(version, 6),
        other => panic!("expected OpenWrite, got {:?}", other),
    }
}

#[tokio::test]
async fn get_attr_404_falls_back_to_dir_probe_via_ls() {
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    // stat returns 404...
    Mock::given(method("POST"))
        .and(path("/orgs/org1/ops"))
        .and(body_json(json!({
            "op": "stat",
            "driveId": "d1",
            "path": "/dir",
        })))
        .respond_with(ResponseTemplate::new(404).set_body_json(json!({
            "error": "NOT_FOUND",
            "message": "stat not a file",
        })))
        .mount(&server)
        .await;

    // ...then the client probes via `ls` and finds children → directory.
    Mock::given(method("POST"))
        .and(path("/orgs/org1/ops"))
        .and(body_json(json!({
            "op": "ls",
            "driveId": "d1",
            "path": "/dir",
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "entries": [
                { "name": "child.txt", "type": "file", "size": 1 },
            ],
        })))
        .mount(&server)
        .await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::GetAttr {
            drive: "brain".into(),
            path: "/dir".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::Attr(a) => {
            assert_eq!(a.kind, NodeKind::Dir);
            assert_eq!(a.size, 0);
        }
        other => panic!("expected Attr(Dir), got {:?}", other),
    }
}
