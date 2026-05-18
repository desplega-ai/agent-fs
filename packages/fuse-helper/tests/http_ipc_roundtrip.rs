//! Integration tests for `HttpIpcClient` (remote-mount transport).
//!
//! Spins up a `wiremock` server per test and asserts the HTTP shape the
//! Rust helper produces for each `Request` variant matches what the
//! `agent-fs` daemon exposes (`packages/server/src/{routes,ipc/handlers}.ts`).
//!
//! Phase 3 covers read-only ops only: `Ping`, `Hello`, `ListDrives`,
//! `DefaultDriveSlug`, `GetAttr`, `ReadDir`, `OpenRead`. Write paths
//! (`OpenWrite`, `CreateFile`, `Unlink`, `Rename`, `Truncate`) return a
//! synthetic `Response::Error { code: Some("EROFS"), .. }` until Phase 4
//! lights them up — the read-only-EROFS test below pins that contract.

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

#[tokio::test]
async fn write_ops_return_synthetic_erofs_in_phase_3() {
    // Drive table needs to be reachable for the resolve step that some
    // ops would take in Phase 4 — keeping the auth/orgs stubs here makes
    // future test extensions trivial. Phase 3 short-circuits before any
    // HTTP call for mutating ops, so the stubs are unused.
    let server = MockServer::start().await;
    server_with_default_drive(&server).await;

    let client = HttpIpcClient::new(server.uri(), "test-key").unwrap();
    let resp = client
        .send(Request::Unlink {
            drive: "brain".into(),
            path: "/x.txt".into(),
        })
        .await
        .unwrap();
    match resp {
        Response::Error { code, .. } => {
            assert_eq!(code.as_deref(), Some("EROFS"));
        }
        other => panic!("expected Error (EROFS), got {:?}", other),
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
