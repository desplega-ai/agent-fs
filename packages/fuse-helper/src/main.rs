//! `agent-fs-fuse` binary entry point.
//!
//! Builds a tokio multi-thread runtime, instantiates the IPC client and
//! `AgentFsFs`, and hands them to `fuser::spawn_mount2`. The main thread
//! then watches a shutdown flag toggled by the SIGTERM/SIGINT handler.
//! When tripped (or when the FUSE event loop exits on its own), we
//! `umount_and_join` the background session, run cleanup (remove our
//! per-pid working-copy dir), and exit normally — so Drop runs on stack
//! values, atexit hooks fire, and `${AGENT_FS_HOME}/mount/<pid>/` is
//! removed even when `agent-fs umount` SIGTERMs us mid-event-loop.
//!
//! Previously the handler called `libc::_exit(0)` from the signal
//! context, which is async-signal-safe but skips Drop and atexit
//! handlers entirely — leaving the per-pid working dir behind and
//! occasionally leaving the kernel mountpoint busy because the FUSE
//! session never had a chance to unwind.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;

use agent_fs_fuse::fs::{AgentFsFs, FuserAdapter};
use agent_fs_fuse::ipc::{IpcTrait, UnixIpcClient};

/// Set by the SIGTERM/SIGINT handler. The main thread polls this flag
/// and, when set, unmounts the FUSE session and runs cleanup. Using an
/// atomic flag (rather than `_exit`) is the standard async-signal-safe
/// pattern: storing to an `AtomicBool` is safe from a signal handler,
/// and the actual unmount + Drop chain runs in normal context where it
/// can free resources properly.
static SHUTDOWN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Parser)]
#[command(
    name = "agent-fs-fuse",
    about = "FUSE helper for agent-fs. Mounts agent-fs drives as a Linux filesystem.",
    version
)]
struct Args {
    /// Directory to mount the filesystem at.
    #[arg(long)]
    mountpoint: PathBuf,

    /// Unix socket path to talk to the agent-fs daemon.
    /// Defaults to `${AGENT_FS_HOME}/agent-fs.sock` or `~/.agent-fs/agent-fs.sock`.
    #[arg(long)]
    socket: Option<PathBuf>,

    /// Allow other users to access the mount (requires user_allow_other in
    /// /etc/fuse.conf on most distros).
    #[arg(long, default_value_t = false)]
    allow_other: bool,

    /// Optional log file path. Defaults to `${AGENT_FS_HOME}/mount.log`.
    #[arg(long)]
    log_file: Option<PathBuf>,
}

fn home_dir() -> PathBuf {
    if let Ok(home) = std::env::var("AGENT_FS_HOME") {
        return PathBuf::from(home);
    }
    if let Ok(h) = std::env::var("HOME") {
        return PathBuf::from(h).join(".agent-fs");
    }
    PathBuf::from("/tmp/.agent-fs")
}

fn main() -> Result<()> {
    let args = Args::parse();
    let home = home_dir();
    std::fs::create_dir_all(&home).ok();

    init_tracing(
        args.log_file
            .clone()
            .unwrap_or_else(|| home.join("mount.log")),
    )?;

    let socket = args
        .socket
        .clone()
        .unwrap_or_else(|| home.join("agent-fs.sock"));

    // GC dead-PID working-copy dirs left behind by previous mounts.
    AgentFsFs::<UnixIpcClient>::gc_dead_pid_dirs(&home);

    // Build a multi-thread runtime separate from the FUSE thread.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .thread_name("agent-fs-fuse-io")
        .build()
        .context("build tokio runtime")?;
    let handle = runtime.handle().clone();

    let ipc = Arc::new(UnixIpcClient::new(socket));
    // Smoke-test the connection with a Ping; failures here are warned but
    // don't block the mount (the daemon may come up after us).
    let ipc_for_ping = ipc.clone();
    let handle_for_ping = handle.clone();
    handle_for_ping.spawn(async move {
        match ipc_for_ping.send(agent_fs_fuse::ipc::Request::Ping).await {
            Ok(_) => tracing::info!("ipc ping ok"),
            Err(e) => tracing::warn!(error = %e, "ipc ping failed (daemon down?)"),
        }
    });

    let pid = std::process::id();
    let workdir = agent_fs_fuse::layout::working_copy_dir(&home, pid);
    std::fs::create_dir_all(&workdir).context("create per-pid mount workdir")?;

    let fs = AgentFsFs::new(handle, ipc, workdir, pid);

    // Build mount options. fuser 0.17 uses a Config struct; `AllowOther` is
    // represented via SessionACL::All on `Config::acl`. AutoUnmount requires
    // a non-Owner ACL, so we flip to RootAndOwner when AutoUnmount is on but
    // `--allow-other` was not requested.
    let mount_options = vec![
        fuser::MountOption::FSName("agent-fs".into()),
        fuser::MountOption::Subtype("agent-fs".into()),
        fuser::MountOption::DefaultPermissions,
        fuser::MountOption::AutoUnmount,
    ];
    let acl = if args.allow_other {
        fuser::SessionACL::All
    } else {
        fuser::SessionACL::RootAndOwner
    };
    let mut config = fuser::Config::default();
    config.mount_options = mount_options;
    config.acl = acl;
    config.n_threads = None;
    config.clone_fd = false;

    install_signal_handler()?;

    tracing::info!(
        mountpoint = %args.mountpoint.display(),
        ?config,
        "mounting"
    );

    // Adapter from our inner FS state to the fuser::Filesystem trait. The
    // trait impl delegates each callback into AgentFsFs's typed helpers via
    // runtime.block_on. See `fs.rs` for the wired callbacks.
    let adapter = FuserAdapter::new(fs);

    // We use `spawn_mount2` rather than `mount2` so the FUSE event loop
    // runs on a background thread. That frees the main thread to poll the
    // shutdown flag and to react to a signal *without* tripping the
    // async-signal-safety rules (we never touch the mount handle from
    // inside the signal handler — only an AtomicBool).
    let bg =
        fuser::spawn_mount2(adapter, &args.mountpoint, &config).context("fuser::spawn_mount2")?;

    // Wait for either: (a) the signal handler to set the shutdown flag,
    // or (b) the background FUSE thread to exit on its own (e.g.
    // somebody ran `fusermount -u` from the outside).
    loop {
        if SHUTDOWN.load(Ordering::SeqCst) {
            tracing::info!("shutdown flag tripped — unmounting");
            break;
        }
        if bg.guard.is_finished() {
            tracing::info!("background FUSE thread exited on its own");
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    // Explicitly unmount + join. If the bg thread already exited, the
    // inner `mount.umount()` is still safe (idempotent — `Option::take`
    // guards against a double-umount). If the umount itself fails we
    // still want to clean up the per-pid workdir, so we log + continue.
    if let Err(e) = bg.umount_and_join() {
        tracing::warn!(error = %e, "umount_and_join failed; proceeding with cleanup");
    }

    cleanup_pid_dir(&home, pid);

    // Normal exit. atexit hooks run; nothing important relies on Drop of
    // stack values past this point (we already explicitly cleaned up the
    // workdir + unmounted the session).
    std::process::exit(0);
}

/// Remove this process's per-pid working-copy dir at
/// `${AGENT_FS_HOME}/mount/<pid>/`. Best-effort; failures are logged but
/// not fatal — the next helper start runs `gc_dead_pid_dirs` and will
/// sweep us up anyway once our PID is gone.
fn cleanup_pid_dir(home: &Path, pid: u32) {
    let dir = agent_fs_fuse::layout::working_copy_dir(home, pid);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => tracing::info!(dir = %dir.display(), "removed per-pid workdir"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Already gone (e.g. FUSE `destroy` callback won the race).
        }
        Err(e) => tracing::warn!(error = %e, dir = %dir.display(), "remove per-pid workdir failed"),
    }
}

fn init_tracing(log_file: PathBuf) -> Result<()> {
    use tracing_subscriber::fmt;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .with_context(|| format!("open log file {}", log_file.display()))?;
    let _ = fmt()
        .with_writer(move || file.try_clone().expect("clone log fd"))
        .with_ansi(false)
        .try_init();
    Ok(())
}

fn install_signal_handler() -> Result<()> {
    use nix::sys::signal::{self, SigHandler, Signal};
    // SAFETY: registering a process-wide signal handler. The handler is
    // async-signal-safe: it only stores into a `static AtomicBool`, which
    // is documented as safe to mutate from a signal context.
    unsafe {
        signal::signal(Signal::SIGTERM, SigHandler::Handler(handle_signal))
            .context("register SIGTERM")?;
        signal::signal(Signal::SIGINT, SigHandler::Handler(handle_signal))
            .context("register SIGINT")?;
    }
    Ok(())
}

extern "C" fn handle_signal(_sig: libc::c_int) {
    // Async-signal-safe: only flip an atomic flag. The main thread polls
    // it, then unmounts the FUSE session and runs cleanup in normal
    // (non-signal) context. This is the standard pattern for getting
    // proper Drop / atexit semantics out of a signal handler — `_exit`
    // here would skip both and leave the per-pid working dir behind.
    SHUTDOWN.store(true, Ordering::SeqCst);
}
