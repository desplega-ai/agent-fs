//! `agent-fs-fuse` binary entry point.
//!
//! Builds a tokio multi-thread runtime, instantiates the IPC client and
//! `AgentFsFs`, and hands them to `fuser::mount2` running on the main thread.
//! A SIGTERM/SIGINT handler unmounts cleanly.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;

use agent_fs_fuse::fs::{AgentFsFs, FuserAdapter};
use agent_fs_fuse::ipc::{IpcTrait, UnixIpcClient};

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

    fuser::mount2(adapter, &args.mountpoint, &config).context("fuser::mount2")?;
    Ok(())
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
    // SAFETY: registering a process-wide signal handler. The handler only
    // calls async-signal-safe libc::_exit-equivalent via exiting via the
    // libfuse auto-unmount path.
    unsafe {
        signal::signal(Signal::SIGTERM, SigHandler::Handler(handle_signal))
            .context("register SIGTERM")?;
        signal::signal(Signal::SIGINT, SigHandler::Handler(handle_signal))
            .context("register SIGINT")?;
    }
    Ok(())
}

extern "C" fn handle_signal(_sig: libc::c_int) {
    // fuser's AutoUnmount option unmounts the filesystem when the session
    // drops, so simply exiting cleanly is sufficient. We use _exit to avoid
    // running destructors from a signal context.
    // SAFETY: _exit is async-signal-safe.
    unsafe { libc::_exit(0) };
}
