//! `doty-watch` — the harness watcher CLI (M8a).
//!
//! Emits one normalized [`HarnessEvent`] per line (NDJSON) so the desktop view
//! and any other consumer can subscribe without knowing harness specifics. The
//! LOCAL-ONLY `text` field is omitted unless `--include-text` is passed.

use anyhow::{bail, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use doty_harness::{
    Adapter, CodexAdapter, DigestBuilder, Harness, SessionRef, StreamOptions,
};
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser)]
#[command(name = "doty-watch", version, about = "Doty harness watcher (M8a)")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Watch a harness live; print one normalized HarnessEvent per line (NDJSON).
    Watch(WatchArgs),
    /// List discovered sessions.
    List(ListArgs),
    /// Print a structurally-derived SessionDigest (never raw text).
    Digest(DigestArgs),
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum HarnessArg {
    Codex,
    Opencode,
    T3,
}

impl HarnessArg {
    fn harness(self) -> Harness {
        match self {
            HarnessArg::Codex => Harness::Codex,
            HarnessArg::Opencode => Harness::Opencode,
            HarnessArg::T3 => Harness::T3,
        }
    }
}

#[derive(Args)]
struct WatchArgs {
    #[arg(value_enum)]
    harness: HarnessArg,
    /// Watch this rollout file instead of the newest discovered session.
    #[arg(long)]
    file: Option<PathBuf>,
    /// Skip existing content; only stream lines written after startup.
    #[arg(long)]
    no_replay: bool,
    /// Print the replay and exit instead of tailing.
    #[arg(long)]
    no_follow: bool,
    /// Seconds of silence after which the session is marked `stale`.
    #[arg(long, default_value_t = 120)]
    stale_after_secs: u64,
    /// Maximum wait between file reads, in milliseconds.
    #[arg(long, default_value_t = 250)]
    poll_ms: u64,
    /// Include the LOCAL-ONLY `text` field in the output.
    #[arg(long)]
    include_text: bool,
}

#[derive(Args)]
struct ListArgs {
    #[arg(value_enum)]
    harness: HarnessArg,
}

#[derive(Args)]
struct DigestArgs {
    #[arg(value_enum)]
    harness: HarnessArg,
    /// Digest this rollout file instead of the newest discovered session.
    #[arg(long)]
    file: Option<PathBuf>,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("doty-watch: {err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Watch(args) => cmd_watch(args),
        Command::List(args) => cmd_list(args),
        Command::Digest(args) => cmd_digest(args),
    }
}

fn adapter_for(harness: HarnessArg) -> Result<CodexAdapter> {
    match harness {
        HarnessArg::Codex => Ok(CodexAdapter::new()),
        other => bail!(
            "the {} adapter is not implemented yet (SA-3 ships Codex first)",
            other.harness()
        ),
    }
}

fn resolve_session(adapter: &CodexAdapter, file: &Option<PathBuf>) -> Result<SessionRef> {
    if let Some(path) = file {
        if !path.exists() {
            bail!("no such file: {}", path.display());
        }
        return Ok(adapter.session_ref_for_path(path));
    }
    adapter.latest()?.ok_or_else(|| {
        anyhow::anyhow!(
            "no Codex rollout files found under {}",
            adapter.root().display()
        )
    })
}

fn cmd_watch(args: WatchArgs) -> Result<()> {
    let adapter = adapter_for(args.harness)?;
    let session = resolve_session(&adapter, &args.file)?;
    let options = StreamOptions {
        replay: !args.no_replay,
        follow: !args.no_follow,
        stale_after: Duration::from_secs(args.stale_after_secs),
        poll: Duration::from_millis(args.poll_ms),
    };
    eprintln!(
        "doty-watch: watching {} (session {}, replay={}, follow={})",
        session.path.display(),
        session.session_id,
        options.replay,
        options.follow
    );

    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    adapter.stream(&session, &options, &mut |event| {
        let line = if args.include_text {
            serde_json::to_string(&event)
        } else {
            serde_json::to_string(&event.to_wire_value())
        };
        if let Ok(line) = line {
            let _ = writeln!(lock, "{line}");
            let _ = lock.flush();
        }
    })
}

fn cmd_list(args: ListArgs) -> Result<()> {
    let adapter = adapter_for(args.harness)?;
    for session in adapter.discover()? {
        let value = serde_json::json!({
            "harness": session.harness,
            "sessionId": session.session_id,
            "project": session.project,
            "path": session.path.to_string_lossy(),
            "bytes": session.bytes,
        });
        println!("{}", serde_json::to_string(&value)?);
    }
    Ok(())
}

fn cmd_digest(args: DigestArgs) -> Result<()> {
    let adapter = adapter_for(args.harness)?;
    let session = resolve_session(&adapter, &args.file)?;
    let options = StreamOptions {
        replay: true,
        follow: false,
        ..StreamOptions::default()
    };
    let mut builder = DigestBuilder::new();
    adapter.stream(&session, &options, &mut |event| builder.observe(&event))?;
    let digest = builder.finish();
    println!("{}", serde_json::to_string_pretty(&digest)?);
    Ok(())
}
