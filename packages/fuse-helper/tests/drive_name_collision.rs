//! `HttpIpcClient` drive resolution when two orgs hold drives with the same
//! name (every org's first drive is named `default`).
//!
//! The user's own default drive (from `/auth/me`) must keep the bare name no
//! matter which order `GET /orgs` lists the orgs in, every drive must stay
//! addressable under a unique slug, and `current` must route to the
//! `/auth/me` default drive.

use agent_fs_fuse::ipc::{HttpIpcClient, IpcTrait, Request, Response};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const PERSONAL_ORG: &str = "org-personal";
const PERSONAL_DRIVE: &str = "drive-personal";
const OTHER_ORG: &str = "org-other";
const OTHER_DRIVE: &str = "drive-other";

/// `/auth/me` names the personal org + drive. `/orgs` lists `orgs` in the
/// given order; each org has one drive named `default`.
async fn mount_orgs(server: &MockServer, orgs: &[(&str, &str)]) {
    Mock::given(method("GET"))
        .and(path("/auth/me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "userId": "u-1",
            "email": "user@example.test",
            "defaultOrgId": PERSONAL_ORG,
            "defaultDriveId": PERSONAL_DRIVE,
        })))
        .mount(server)
        .await;

    let list: Vec<_> = orgs
        .iter()
        .map(|(org, _)| json!({ "id": org, "name": "Org", "role": "editor" }))
        .collect();
    Mock::given(method("GET"))
        .and(path("/orgs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "orgs": list })))
        .mount(server)
        .await;

    for (org, drive) in orgs {
        Mock::given(method("GET"))
            .and(path(format!("/orgs/{org}/drives")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "drives": [{ "id": drive, "name": "default", "isDefault": true }],
            })))
            .mount(server)
            .await;
    }

    for (org, drive) in orgs {
        Mock::given(method("PUT"))
            .and(path(format!(
                "/orgs/{org}/drives/{drive}/files/probe.md/raw"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "path": "/probe.md",
                "version": 1,
                "contentHash": "h",
                "deduped": false,
            })))
            .mount(server)
            .await;
    }
}

/// Write `/probe.md` through drive slug `slug` and return the path of the
/// PUT the client sent.
async fn write_target(server: &MockServer, client: &HttpIpcClient, slug: &str) -> String {
    let resp = client
        .send(Request::OpenWrite {
            drive: slug.into(),
            path: "/probe.md".into(),
            base_version: None,
            content_hash: "h0".into(),
            bytes: b"dummy".to_vec(),
        })
        .await
        .unwrap();
    assert!(
        matches!(resp, Response::OpenWrite { .. }),
        "unexpected response: {resp:?}"
    );
    let reqs = server.received_requests().await.unwrap();
    let put = reqs
        .iter()
        .rev()
        .find(|r| r.method.as_str() == "PUT")
        .expect("a PUT was sent");
    put.url.path().to_string()
}

fn personal_put() -> String {
    format!("/orgs/{PERSONAL_ORG}/drives/{PERSONAL_DRIVE}/files/probe.md/raw")
}

fn other_put() -> String {
    format!("/orgs/{OTHER_ORG}/drives/{OTHER_DRIVE}/files/probe.md/raw")
}

async fn list_slugs(client: &HttpIpcClient) -> Vec<(String, String)> {
    match client.send(Request::ListDrives).await.unwrap() {
        Response::Drives(d) => d.into_iter().map(|d| (d.slug, d.id)).collect(),
        other => panic!("expected Drives, got {other:?}"),
    }
}

async fn default_slug(client: &HttpIpcClient) -> String {
    match client.send(Request::DefaultDriveSlug).await.unwrap() {
        Response::DefaultDriveSlug(Some(s)) => s,
        other => panic!("expected DefaultDriveSlug(Some), got {other:?}"),
    }
}

/// Control: a single org, no name collision.
#[tokio::test]
async fn single_org_default_routes_to_personal_drive() {
    let server = MockServer::start().await;
    mount_orgs(&server, &[(PERSONAL_ORG, PERSONAL_DRIVE)]).await;
    let client = HttpIpcClient::new(server.uri(), "dummy-key").unwrap();

    assert_eq!(
        write_target(&server, &client, "default").await,
        personal_put()
    );
    assert_eq!(default_slug(&client).await, "default");
}

/// The other org is listed last. `default` and `current` must still reach
/// the personal drive, and the other org's drive stays reachable under its
/// own slug.
#[tokio::test]
async fn same_named_drive_in_later_org_does_not_take_over_default() {
    let server = MockServer::start().await;
    mount_orgs(
        &server,
        &[(PERSONAL_ORG, PERSONAL_DRIVE), (OTHER_ORG, OTHER_DRIVE)],
    )
    .await;
    let client = HttpIpcClient::new(server.uri(), "dummy-key").unwrap();

    assert_eq!(
        write_target(&server, &client, "default").await,
        personal_put()
    );

    let current = default_slug(&client).await;
    assert_eq!(
        write_target(&server, &client, &current).await,
        personal_put()
    );

    let slugs = list_slugs(&client).await;
    let mut seen: Vec<&str> = slugs.iter().map(|(s, _)| s.as_str()).collect();
    seen.sort();
    seen.dedup();
    assert_eq!(seen.len(), slugs.len(), "slugs must be unique: {slugs:?}");

    let other_slug = &slugs.iter().find(|(_, id)| id == OTHER_DRIVE).unwrap().0;
    assert_ne!(other_slug, "default");
    assert_eq!(
        write_target(&server, &client, other_slug).await,
        other_put()
    );
}

/// Same as above with the other org listed first.
#[tokio::test]
async fn same_named_drive_in_earlier_org_does_not_take_over_default() {
    let server = MockServer::start().await;
    mount_orgs(
        &server,
        &[(OTHER_ORG, OTHER_DRIVE), (PERSONAL_ORG, PERSONAL_DRIVE)],
    )
    .await;
    let client = HttpIpcClient::new(server.uri(), "dummy-key").unwrap();

    assert_eq!(
        write_target(&server, &client, "default").await,
        personal_put()
    );
    let current = default_slug(&client).await;
    assert_eq!(
        write_target(&server, &client, &current).await,
        personal_put()
    );
}
