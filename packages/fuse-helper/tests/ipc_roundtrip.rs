//! IPC round-trip integration test.
//!
//! Spawns a stub Unix server in-test that decodes msgpack length-prefixed
//! frames and replies with a canned response. Asserts the client multiplexes
//! 100 concurrent requests correctly by id.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use agent_fs_fuse::ipc::{IpcTrait, Request, Response, UnixIpcClient};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

#[derive(Debug, Serialize, Deserialize)]
struct Envelope<T> {
    id: u64,
    body: T,
}

async fn run_server(listener: UnixListener, served: Arc<AtomicU64>) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => return,
        };
        let served = served.clone();
        tokio::spawn(async move {
            let (mut read_half, write_half) = stream.into_split();
            let write_half = Arc::new(tokio::sync::Mutex::new(write_half));
            let mut len_buf = [0u8; 4];
            while read_half.read_exact(&mut len_buf).await.is_ok() {
                let len = u32::from_be_bytes(len_buf) as usize;
                let mut body = vec![0u8; len];
                if read_half.read_exact(&mut body).await.is_err() {
                    return;
                }
                let env: Envelope<Request> = match rmp_serde::from_slice(&body) {
                    Ok(v) => v,
                    Err(_) => return,
                };
                let resp = match env.body {
                    Request::Ping => Response::Pong,
                    Request::ListDrives => Response::Drives(vec![]),
                    _ => Response::Ok,
                };
                let out = Envelope {
                    id: env.id,
                    body: resp,
                };
                let bytes = rmp_serde::to_vec_named(&out).unwrap();
                let len = (bytes.len() as u32).to_be_bytes();
                let mut w = write_half.lock().await;
                w.write_all(&len).await.ok();
                w.write_all(&bytes).await.ok();
                w.flush().await.ok();
                served.fetch_add(1, Ordering::Relaxed);
            }
        });
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multiplexes_100_concurrent_pings() {
    let tmp = TempDir::new().unwrap();
    let sock = tmp.path().join("ipc.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let served = Arc::new(AtomicU64::new(0));
    let served_for_server = served.clone();
    tokio::spawn(async move { run_server(listener, served_for_server).await });

    // Tiny pause for the listener to be ready (not strictly necessary on
    // Linux, but the bind→accept handshake is cheap so it's fine).
    tokio::task::yield_now().await;

    let client = Arc::new(UnixIpcClient::new(&sock));
    let mut handles = Vec::new();
    for _ in 0..100 {
        let c = client.clone();
        handles.push(tokio::spawn(async move {
            let r = c.send(Request::Ping).await.unwrap();
            assert!(matches!(r, Response::Pong));
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    assert_eq!(served.load(Ordering::Relaxed), 100);
}
