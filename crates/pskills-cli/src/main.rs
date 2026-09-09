use clap::{Args, Parser, Subcommand};
use pskills_core::bundle::{
    bundle_digest, bundle_from_directory, decode_bundle_bytes, tree_digest, BundleLimits,
};
use pskills_core::client::{publish_request, ApiClient, ApiError};
use pskills_core::credentials::{CredentialError, CredentialStore, RegistryConfig};
use pskills_core::install::{InstallError, InstallPlan, LocalState};
use pskills_core::model::*;
use pskills_core::paths::{resolve_directory, Agent, InstallScope, PathError};
use pskills_core::{SERVICE, VERSION};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Parser)]
#[command(name = "pskills", version = VERSION, about = "Private Skills registry client")]
struct Cli {
    /// Registry origin. Credentials are bound to this exact origin.
    #[arg(long, global = true, env = "PSKILLS_REGISTRY")]
    registry: Option<String>,
    /// Emit machine-readable JSON on stdout.
    #[arg(long, global = true)]
    json: bool,
    /// Validate and preview a mutation without changing local or remote state.
    #[arg(long, global = true)]
    dry_run: bool,
    /// Explicit skill root. Must be absolute.
    #[arg(long, global = true)]
    directory: Option<PathBuf>,
    /// Install into the user-wide root.
    #[arg(long, global = true)]
    global: bool,
    /// Agent adapter for install/list/verify/remove.
    #[arg(long, global = true, default_value = "codex")]
    agent: AgentArg,
    /// Never resolve a new version; use the matching committed lock entry.
    #[arg(long, global = true)]
    frozen_lockfile: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
enum AgentArg {
    Codex,
    Claude,
    Universal,
}
impl From<AgentArg> for Agent {
    fn from(value: AgentArg) -> Self {
        match value {
            AgentArg::Codex => Agent::Codex,
            AgentArg::Claude => Agent::Claude,
            AgentArg::Universal => Agent::Universal,
        }
    }
}

#[derive(Debug, Subcommand)]
enum Command {
    Health,
    Login(LoginArgs),
    Logout,
    Whoami,
    Search {
        query: String,
    },
    /// Discover registry-approved entries from the directory index.
    Directory {
        #[command(subcommand)]
        command: DirectoryCommand,
    },
    Show {
        reference: String,
    },
    Versions {
        reference: String,
    },
    Publish(PublishArgs),
    /// Request an approved upstream import through the registry, then install it.
    Proxy(ProxyArgs),
    Install(InstallArgs),
    List,
    Verify,
    Remove {
        reference: String,
    },
    Update {
        reference: Option<String>,
    },
    Doctor,
    Scan {
        #[command(subcommand)]
        command: ScanCommand,
    },
    Pack {
        #[command(subcommand)]
        command: PackCommand,
    },
}

#[derive(Debug, Args)]
struct LoginArgs {
    #[arg(long)]
    registry: String,
    #[arg(long = "token-stdin")]
    token_stdin: bool,
}

#[derive(Debug, Args)]
struct PublishArgs {
    path: PathBuf,
    #[arg(long)]
    name: String,
    #[arg(long)]
    version: String,
    #[arg(long, default_value = "")]
    description: String,
}

#[derive(Debug, Args)]
struct ProxyArgs {
    /// Destination skill reference with an exact version, for example
    /// `@team/review@1.2.3`.
    reference: String,
    /// Registry-configured upstream identifier.
    #[arg(long)]
    upstream: String,
    /// Skill path within the configured upstream source.
    #[arg(long)]
    path: String,
    /// Optional immutable source revision, branch, or tag accepted by the upstream mapping.
    #[arg(long = "ref")]
    source_ref: Option<String>,
    /// Optional source repository in `owner/repository` form.
    #[arg(long)]
    repository: Option<String>,
}

#[derive(Debug, Args)]
struct InstallArgs {
    reference: String,
}

#[derive(Debug, Subcommand)]
enum ScanCommand {
    Status { digest: Option<String> },
}

#[derive(Debug, Subcommand)]
enum PackCommand {
    List,
    Show { reference: String },
    Install { reference: String },
    Publish { path: PathBuf },
    Remove { reference: String },
}

#[derive(Debug, Subcommand)]
enum DirectoryCommand {
    /// List one bounded leaderboard page.
    List(DirectoryListArgs),
    /// Search the registry's directory index.
    Search(DirectorySearchArgs),
    /// Show bounded metadata for one directory identifier.
    Show { id: String },
    /// Show the registry's first-party directory grouping.
    Official,
    /// Show external audit evidence for one directory identifier.
    Audits { id: String },
    /// Request a registry-managed import for one directory identifier.
    Import(DirectoryImportArgs),
}

#[derive(Debug, Args)]
struct DirectoryListArgs {
    /// Directory leaderboard view.
    #[arg(long, default_value = "all-time")]
    view: String,
    /// Zero-indexed page number.
    #[arg(long, default_value_t = 0)]
    page: u32,
    /// Number of records to request, bounded to 1..500.
    #[arg(long = "per-page", default_value_t = 100)]
    per_page: u32,
}

#[derive(Debug, Args)]
struct DirectorySearchArgs {
    /// At least two non-whitespace characters.
    query: String,
    /// Optional GitHub owner filter.
    #[arg(long)]
    owner: Option<String>,
    /// Number of records to request, bounded to 1..200.
    #[arg(long, default_value_t = 50)]
    limit: u32,
}

#[derive(Debug, Args)]
struct DirectoryImportArgs {
    /// Directory identifier returned by the registry directory endpoints.
    id: String,
    /// Private skill name to use for the imported entry.
    #[arg(long)]
    name: String,
    /// Exact SemVer for the private skill.
    #[arg(long)]
    version: String,
    /// Optional registry-configured upstream identifier.
    #[arg(long = "upstream-id")]
    upstream_id: Option<String>,
}

#[derive(Debug, Error)]
enum CliError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Credentials(#[from] CredentialError),
    #[error(transparent)]
    Api(#[from] ApiError),
    #[error(transparent)]
    Install(#[from] InstallError),
    #[error(transparent)]
    Path(#[from] PathError),
    #[error("cannot read `{path}`: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("invalid JSON in `{path}`: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
}

#[derive(Debug, Clone)]
struct Context {
    credentials: CredentialStore,
    registry: Option<RegistryConfig>,
    json: bool,
    dry_run: bool,
    agent: Agent,
    scope: InstallScope,
    directory: Option<PathBuf>,
    frozen: bool,
}

fn main() {
    let cli = Cli::parse();
    let result = run(cli);
    if let Err(error) = result {
        eprintln!("pskills: {error}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), CliError> {
    let credentials = CredentialStore::default();
    if let Command::Login(args) = &cli.command {
        return login(&credentials, args, cli.json, cli.dry_run);
    }
    let registry_not_required = matches!(
        &cli.command,
        Command::Doctor
            | Command::List
            | Command::Verify
            | Command::Remove { .. }
            | Command::Pack {
                command: PackCommand::Remove { .. }
            }
    );
    let local_dry_run = cli.dry_run
        && matches!(
            &cli.command,
            Command::Publish(_)
                | Command::Proxy(_)
                | Command::Directory {
                    command: DirectoryCommand::Import(_),
                }
                | Command::Pack {
                    command: PackCommand::Publish { .. }
                }
        );
    let context = Context {
        registry: if local_dry_run || (registry_not_required && cli.registry.is_none()) {
            None
        } else {
            Some(credentials.registry(cli.registry.as_deref())?)
        },
        credentials,
        json: cli.json,
        dry_run: cli.dry_run,
        agent: cli.agent.into(),
        scope: if cli.global {
            InstallScope::Global
        } else {
            InstallScope::Project
        },
        directory: cli.directory,
        frozen: cli.frozen_lockfile,
    };
    match cli.command {
        Command::Health => health(&context),
        Command::Login(_) => unreachable!("login handled before context construction"),
        Command::Logout => logout(&context),
        Command::Whoami => whoami(&context),
        Command::Search { query } => search(&context, &query),
        Command::Directory { command } => directory(&context, command),
        Command::Show { reference } => show(&context, &reference),
        Command::Versions { reference } => versions(&context, &reference),
        Command::Publish(args) => publish(&context, &args),
        Command::Proxy(args) => proxy(&context, &args),
        Command::Install(args) => install_skill(&context, &args.reference, "direct"),
        Command::List => list_local(&context),
        Command::Verify => verify_local(&context),
        Command::Remove { reference } => remove_local(&context, &reference, "direct"),
        Command::Update { reference } => update(&context, reference.as_deref()),
        Command::Doctor => doctor(&context),
        Command::Scan { command } => scan(&context, command),
        Command::Pack { command } => pack(&context, command),
    }
}

fn login(
    store: &CredentialStore,
    args: &LoginArgs,
    json_output: bool,
    dry_run: bool,
) -> Result<(), CliError> {
    if !args.token_stdin {
        return Err(CliError::Message("login requires --token-stdin; interactive browser login is not available in this build".into()));
    }
    let registry = normalize_registry(&args.registry)?;
    let mut token = String::new();
    io::stdin()
        .read_to_string(&mut token)
        .map_err(|source| CliError::Read {
            path: PathBuf::from("<stdin>"),
            source,
        })?;
    if token.trim().is_empty() {
        return Err(CliError::Message("token-stdin was empty".into()));
    }
    if !dry_run {
        store.save_token(&registry, token.trim())?;
        store.set_registry(RegistryConfig {
            url: registry.clone(),
            organization: None,
        })?;
    }
    emit(
        json_output,
        json!({ "ok": true, "registry": registry, "stored": !dry_run }),
    )
}

fn logout(context: &Context) -> Result<(), CliError> {
    let registry = context.registry.as_ref().ok_or_else(|| {
        CliError::Message("logout requires --registry or a configured registry".into())
    })?;
    if !context.dry_run {
        context.credentials.delete_token(&registry.url)?;
        context.credentials.remove_registry(&registry.url)?;
    }
    emit(
        context.json,
        json!({ "ok": true, "registry": registry.url, "removed": !context.dry_run }),
    )
}

fn health(context: &Context) -> Result<(), CliError> {
    let registry = context.registry.as_ref().ok_or_else(|| {
        CliError::Message("health requires --registry URL when no registry is configured".into())
    })?;
    let client = ApiClient::new(&registry.url, None)?;
    emit(
        context.json,
        serde_json::to_value(client.health()?).map_err(|e| CliError::Message(e.to_string()))?,
    )
}

fn whoami(context: &Context) -> Result<(), CliError> {
    let client = client(context)?;
    emit(
        context.json,
        serde_json::to_value(client.whoami()?).map_err(|e| CliError::Message(e.to_string()))?,
    )
}

fn search(context: &Context, query: &str) -> Result<(), CliError> {
    let client = client(context)?;
    emit(
        context.json,
        serde_json::to_value(client.search(query)?)
            .map_err(|e| CliError::Message(e.to_string()))?,
    )
}

fn directory(context: &Context, command: DirectoryCommand) -> Result<(), CliError> {
    match command {
        DirectoryCommand::List(args) => {
            let view = directory_view(&args.view)?;
            if args.per_page == 0 || args.per_page > 500 {
                return Err(CliError::Message(
                    "directory --per-page must be between 1 and 500".into(),
                ));
            }
            emit(
                context.json,
                client(context)?.directory_list(view, args.page, args.per_page)?,
            )
        }
        DirectoryCommand::Search(args) => {
            let query = directory_query(&args.query)?;
            if args.limit == 0 || args.limit > 200 {
                return Err(CliError::Message(
                    "directory search --limit must be between 1 and 200".into(),
                ));
            }
            let owner = args.owner.as_deref().map(directory_owner).transpose()?;
            emit(
                context.json,
                client(context)?.directory_search(&query, owner.as_deref(), args.limit)?,
            )
        }
        DirectoryCommand::Show { id } => emit(
            context.json,
            client(context)?.directory_detail(directory_identifier(&id)?)?,
        ),
        DirectoryCommand::Official => emit(context.json, client(context)?.directory_official()?),
        DirectoryCommand::Audits { id } => emit(
            context.json,
            client(context)?.directory_audits(directory_identifier(&id)?)?,
        ),
        DirectoryCommand::Import(args) => directory_import(context, &args),
    }
}

fn directory_import(context: &Context, args: &DirectoryImportArgs) -> Result<(), CliError> {
    let id = directory_identifier(&args.id)?.to_string();
    let (name, embedded_version) = split_reference(&args.name)?;
    if embedded_version.is_some() {
        return Err(CliError::Message(
            "directory import --name must not include a version; use --version".into(),
        ));
    }
    semver::Version::parse(&args.version)
        .map_err(|_| CliError::Message(format!("invalid SemVer `{}`", args.version)))?;
    let request = DirectoryImportRequest {
        id,
        name,
        version: args.version.clone(),
        upstream_id: args
            .upstream_id
            .as_deref()
            .map(directory_identifier)
            .transpose()?
            .map(str::to_string),
    };
    if context.dry_run {
        return emit(
            context.json,
            json!({
                "dryRun": true,
                "endpoint": "/v1/directory/import",
                "request": serde_json::to_value(&request)
                    .map_err(|error| CliError::Message(error.to_string()))?,
            }),
        );
    }
    // The registry owns import approval and any asynchronous operation.  The
    // directory command reports that response; installation remains the
    // existing explicit install/proxy flow after an approved resolution.
    emit(context.json, client(context)?.directory_import(&request)?)
}

fn directory_view(value: &str) -> Result<&str, CliError> {
    match value.trim() {
        "all-time" => Ok("all-time"),
        "trending" => Ok("trending"),
        "hot" => Ok("hot"),
        other => Err(CliError::Message(format!(
            "invalid directory view `{other}`; expected all-time, trending, or hot"
        ))),
    }
}

fn directory_query(value: &str) -> Result<String, CliError> {
    let value = value.trim();
    if value.chars().count() < 2 {
        return Err(CliError::Message(
            "directory search query must contain at least two characters".into(),
        ));
    }
    if value.len() > 16 * 1024 {
        return Err(CliError::Message(
            "directory search query is too large".into(),
        ));
    }
    Ok(value.into())
}

fn directory_owner(value: &str) -> Result<String, CliError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CliError::Message(
            "directory search --owner must not be empty".into(),
        ));
    }
    if value.len() > 512 {
        return Err(CliError::Message(
            "directory search --owner is too large".into(),
        ));
    }
    Ok(value.into())
}

fn directory_identifier(value: &str) -> Result<&str, CliError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CliError::Message(
            "directory identifier must not be empty".into(),
        ));
    }
    if value.len() > 2 * 1024 || value.chars().any(char::is_control) {
        return Err(CliError::Message(
            "directory identifier is invalid or too large".into(),
        ));
    }
    Ok(value)
}

fn show(context: &Context, reference: &str) -> Result<(), CliError> {
    let (reference, version) = split_reference(reference)?;
    let client = client(context)?;
    emit(
        context.json,
        serde_json::to_value(client.show_skill(&reference, version.as_deref())?)
            .map_err(|e| CliError::Message(e.to_string()))?,
    )
}

fn versions(context: &Context, reference: &str) -> Result<(), CliError> {
    let (reference, requested_version) = split_reference(reference)?;
    let client = client(context)?;
    let skills = client.search(&reference)?;
    let values: Vec<Value> = skills
        .into_iter()
        .filter(|skill| {
            (skill.name == reference || skill.name.starts_with(&format!("{reference}@")))
                && requested_version
                    .as_deref()
                    .map(|version| skill.version == version)
                    .unwrap_or(true)
        })
        .map(|skill| {
            json!({ "version": skill.version, "state": skill.state, "digest": skill.artifact.digest })
        })
        .collect();
    emit(context.json, Value::Array(values))
}

fn publish(context: &Context, args: &PublishArgs) -> Result<(), CliError> {
    let (name, embedded_version) = split_reference(&args.name)?;
    if embedded_version.is_some() {
        return Err(CliError::Message(
            "publish --name must not include a version; use --version".into(),
        ));
    }
    semver::Version::parse(&args.version)
        .map_err(|_| CliError::Message(format!("invalid SemVer `{}`", args.version)))?;
    let path = normalize_skill_source(&args.path)?;
    let bundle = bundle_from_directory(&path, BundleLimits::default())
        .map_err(|e| CliError::Message(e.to_string()))?;
    let digest = bundle_digest(&bundle).map_err(|e| CliError::Message(e.to_string()))?;
    if context.dry_run {
        return emit(
            context.json,
            json!({ "dryRun": true, "name": name, "version": args.version, "digest": digest, "files": bundle.files.len() }),
        );
    }
    let client = client(context)?;
    let request = publish_request(
        name,
        args.version.clone(),
        args.description.clone(),
        &bundle,
    )?;
    emit(context.json, client.publish(&request)?)
}

fn proxy(context: &Context, args: &ProxyArgs) -> Result<(), CliError> {
    let (reference, version) = split_reference(&args.reference)?;
    let version = version.ok_or_else(|| {
        CliError::Message("proxy requires an exact reference such as @team/name@1.0.0".into())
    })?;
    if args.upstream.trim().is_empty() {
        return Err(CliError::Message("--upstream must not be empty".into()));
    }
    if args.path.trim().is_empty() {
        return Err(CliError::Message("--path must not be empty".into()));
    }
    if context.dry_run {
        return emit(
            context.json,
            json!({
                "dryRun": true,
                "upstreamId": args.upstream,
                "path": args.path,
                "ref": args.source_ref,
                "repository": args.repository,
                "name": reference,
                "version": version,
            }),
        );
    }
    if context.registry.is_none() {
        return Err(CliError::Message("proxy requires a registry".into()));
    }
    let resolution = client(context)?.proxy_resolve(&ImportRequest {
        upstream_id: args.upstream.clone(),
        repository: args.repository.clone(),
        path: args.path.clone(),
        reference: args.source_ref.clone(),
        name: reference.clone(),
        version: version.clone(),
    })?;
    if resolution.kind != "skill" || resolution.name != reference || resolution.version != version {
        return Err(CliError::Message(
            "proxy resolution did not match the requested skill reference".into(),
        ));
    }
    // The normal authenticated install path performs authorization, transfer
    // digest checks, bundle validation, final revalidation, and lock/journal
    // activation.  The proxy request above only asks the registry to acquire
    // and approve the upstream bytes.
    install_skill(context, &format!("{reference}@{version}"), "direct")
}

fn install_skill(
    context: &Context,
    raw_reference: &str,
    owner_prefix: &str,
) -> Result<(), CliError> {
    let (reference, requested_version) = split_reference(raw_reference)?;
    let registry = context
        .registry
        .as_ref()
        .ok_or_else(|| CliError::Message("install requires a registry".into()))?;
    let frozen_entry = if context.frozen {
        Some(frozen_skill_entry(
            context,
            registry,
            &reference,
            requested_version.as_deref(),
        )?)
    } else {
        None
    };
    let version = frozen_entry
        .as_ref()
        .map(|entry| entry.version.clone())
        .or(requested_version.clone());
    let client = client(context)?;
    let resolution = client.resolve(&ResolveRequest {
        kind: "skill".into(),
        reference: reference.clone(),
        version,
    })?;
    let skill = resolution.members.first().cloned();
    let skill_name = skill
        .as_ref()
        .map(|value| {
            if value.skill_name.is_empty() {
                last_name(&value.name)
            } else {
                value.skill_name.clone()
            }
        })
        .unwrap_or_else(|| last_name(&resolution.name));
    let resource_id = skill
        .as_ref()
        .map(|value| value.id.clone())
        .unwrap_or_else(|| resolution.resource_id.clone());
    let artifact_digest = skill
        .as_ref()
        .map(|value| value.artifact.digest.clone())
        .unwrap_or_else(|| resolution.digest.clone());
    if let Some(expected) = frozen_entry.as_ref() {
        if resolution.version != expected.version
            || resolution.digest != expected.artifact_digest
            || skill_name != expected.skill_name
        {
            return Err(CliError::Message(format!(
                "frozen lock entry for {reference} does not match the registry resolution"
            )));
        }
    }
    let authorization = client.authorize(&resolution)?;
    let descriptor =
        client.download_descriptor(&artifact_digest, &resource_id, &authorization.id)?;
    if descriptor.digest != artifact_digest {
        return Err(CliError::Message(
            "transfer descriptor digest does not match resolved skill".into(),
        ));
    }
    let bytes = client.download_transfer(&descriptor)?;
    let bundle = decode_bundle_bytes(&bytes).map_err(|e| CliError::Message(e.to_string()))?;
    if let Some(expected) = frozen_entry.as_ref() {
        let actual_tree = tree_digest(&bundle).map_err(|e| CliError::Message(e.to_string()))?;
        if actual_tree != expected.tree_digest {
            return Err(CliError::Message(format!(
                "frozen lock tree digest mismatch for {reference}: expected {}, received {actual_tree}",
                expected.tree_digest
            )));
        }
    }
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    reject_agent_reserved_files(context.agent, &bundle)?;
    let second = client.validate_authorization(&authorization.id)?;
    if !same_resolution(&second.resolution, &authorization.resolution) {
        return Err(CliError::Message(
            "install authorization changed during transfer".into(),
        ));
    }
    let state = local_state(&root, context.scope);
    let owner = owner_for_reference(owner_prefix, registry, &reference);
    let plan = InstallPlan {
        root: root.clone(),
        skill_name: skill_name.clone(),
        bundle: bundle.clone(),
        artifact_digest: artifact_digest.clone(),
        owner: owner.clone(),
        dry_run: context.dry_run,
    };
    let old_lock = state.read_lock()?;
    let mut new_lock = old_lock.clone();
    update_lock_for_skill(
        &mut new_lock,
        registry,
        context,
        &reference,
        &skill_name,
        &resolution,
        &bundle,
        &owner,
    )?;
    let result = state
        .install_many_with_lock(&[plan], Some(&old_lock), Some(&new_lock))?
        .into_iter()
        .next()
        .ok_or_else(|| CliError::Message("installer returned no result".into()))?;
    report_install_receipt(context, &client, &authorization.id, result.changed);
    emit(
        context.json,
        json!({ "ok": true, "dryRun": context.dry_run, "reference": reference, "version": resolution.version, "digest": artifact_digest, "destination": result.destination, "changed": result.changed }),
    )
}

fn pack(context: &Context, command: PackCommand) -> Result<(), CliError> {
    match command {
        PackCommand::List => {
            let client = client(context)?;
            emit(
                context.json,
                serde_json::to_value(client.list_packs()?)
                    .map_err(|e| CliError::Message(e.to_string()))?,
            )
        }
        PackCommand::Show { reference } => {
            let (reference, version) = split_reference(&reference)?;
            let client = client(context)?;
            emit(
                context.json,
                serde_json::to_value(client.show_pack(&reference, version.as_deref())?)
                    .map_err(|e| CliError::Message(e.to_string()))?,
            )
        }
        PackCommand::Publish { path } => publish_pack(context, &path),
        PackCommand::Install { reference } => install_pack(context, &reference),
        PackCommand::Remove { reference } => remove_pack(context, &reference),
    }
}

fn publish_pack(context: &Context, path: &Path) -> Result<(), CliError> {
    let bytes = fs::read(path).map_err(|source| CliError::Read {
        path: path.into(),
        source,
    })?;
    let draft: PackDraft = serde_json::from_slice(&bytes).map_err(|source| CliError::Json {
        path: path.into(),
        source,
    })?;
    validate_pack_draft(&draft)?;
    if context.dry_run {
        return emit(
            context.json,
            json!({ "dryRun": true, "name": draft.name, "version": draft.version, "members": draft.skills.len() }),
        );
    }
    emit(context.json, client(context)?.publish_pack(&draft)?)
}

fn install_pack(context: &Context, raw_reference: &str) -> Result<(), CliError> {
    let (reference, requested_version) = split_reference(raw_reference)?;
    let registry = context
        .registry
        .as_ref()
        .ok_or_else(|| CliError::Message("pack install requires a registry".into()))?;
    let frozen_pack = if context.frozen {
        Some(frozen_pack_entry(
            context,
            registry,
            &reference,
            requested_version.as_deref(),
        )?)
    } else {
        None
    };
    let version = frozen_pack
        .as_ref()
        .map(|pack| pack.version.clone())
        .or(requested_version);
    let client = client(context)?;
    let resolution = client.resolve(&ResolveRequest {
        kind: "pack".into(),
        reference: reference.clone(),
        version,
    })?;
    if resolution.kind != "pack" || resolution.members.is_empty() {
        return Err(CliError::Message(
            "pack resolution did not contain pinned members".into(),
        ));
    }
    let frozen_members = if let Some(expected_pack) = frozen_pack.as_ref() {
        if resolution.version != expected_pack.version
            || resolution.digest != expected_pack.manifest_digest
            || resolution.members.len() != expected_pack.members.len()
        {
            return Err(CliError::Message(format!(
                "frozen lock pack entry for {reference} does not match the registry resolution"
            )));
        }
        Some(
            expected_pack
                .members
                .iter()
                .map(|key| {
                    let skill = frozen_skill_by_key(context, registry, key)?;
                    Ok(skill)
                })
                .collect::<Result<Vec<_>, CliError>>()?,
        )
    } else {
        None
    };
    let authorization = client.authorize(&resolution)?;
    let mut downloaded = Vec::with_capacity(resolution.members.len());
    for (index, skill) in resolution.members.iter().enumerate() {
        if let Some(expected) = frozen_members
            .as_ref()
            .and_then(|members| members.get(index))
        {
            if expected.version != skill.version
                || expected.artifact_digest != skill.artifact.digest
                || expected.reference != skill.name
            {
                return Err(CliError::Message(format!(
                    "frozen lock member {} does not match the registry resolution",
                    skill.name
                )));
            }
        }
        let skill_name = if skill.skill_name.is_empty() {
            last_name(&skill.name)
        } else {
            skill.skill_name.clone()
        };
        let descriptor =
            client.download_descriptor(&skill.artifact.digest, &skill.id, &authorization.id)?;
        if descriptor.digest != skill.artifact.digest {
            return Err(CliError::Message(format!(
                "member {} transfer digest does not match resolution",
                skill.name
            )));
        }
        let bytes = client.download_transfer(&descriptor)?;
        let bundle = decode_bundle_bytes(&bytes).map_err(|e| CliError::Message(e.to_string()))?;
        if let Some(expected) = frozen_members
            .as_ref()
            .and_then(|members| members.get(index))
        {
            let actual_tree = tree_digest(&bundle).map_err(|e| CliError::Message(e.to_string()))?;
            if actual_tree != expected.tree_digest {
                return Err(CliError::Message(format!(
                    "frozen lock tree digest mismatch for {}: expected {}, received {actual_tree}",
                    skill.name, expected.tree_digest
                )));
            }
        }
        reject_agent_reserved_files(context.agent, &bundle)?;
        downloaded.push((skill.clone(), skill_name, bundle));
    }
    validate_pack_destinations(&downloaded)?;
    let second = client.validate_authorization(&authorization.id)?;
    if !same_resolution(&second.resolution, &authorization.resolution) {
        return Err(CliError::Message(
            "pack authorization changed during transfer".into(),
        ));
    }
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let state = local_state(&root, context.scope);
    let owner = format!(
        "pack:{registry_url}:{reference}@{}",
        resolution.version,
        registry_url = registry.url
    );
    let old_lock = state.read_lock()?;
    let mut new_lock = old_lock.clone();
    let members: Vec<String> = downloaded
        .iter()
        .map(|(skill, _, _)| format!("{}:{}@{}", registry.url, skill.name, skill.version))
        .collect();
    new_lock.packs.retain(|pack| {
        !(pack.registry == registry.url
            && pack.reference == reference
            && pack.version == resolution.version)
    });
    new_lock.packs.push(LockPack {
        registry: registry.url.clone(),
        reference: reference.clone(),
        version: resolution.version.clone(),
        manifest_digest: resolution.digest.clone(),
        members,
    });
    for (skill, skill_name, bundle) in &downloaded {
        update_lock_for_skill(
            &mut new_lock,
            registry,
            context,
            &skill.name,
            skill_name,
            &Resolution {
                kind: "skill".into(),
                resource_id: skill.id.clone(),
                organization_id: skill.organization_id.clone(),
                name: skill.name.clone(),
                version: skill.version.clone(),
                digest: skill.artifact.digest.clone(),
                members: vec![skill.clone()],
            },
            bundle,
            &owner,
        )?;
    }
    // A pack is one logical activation.  Preflight all members and hand the
    // complete plan to the installer so a conflict in any member prevents
    // every member from being activated.
    let plans: Vec<InstallPlan> = downloaded
        .iter()
        .map(|(skill, skill_name, bundle)| InstallPlan {
            root: root.clone(),
            skill_name: skill_name.clone(),
            bundle: bundle.clone(),
            artifact_digest: skill.artifact.digest.clone(),
            owner: owner.clone(),
            dry_run: context.dry_run,
        })
        .collect();
    let activated = state.install_many_with_lock(&plans, Some(&old_lock), Some(&new_lock))?;
    let results: Vec<Value> = downloaded
        .iter()
        .zip(activated.iter())
        .map(|((skill, _, _), result)| {
            json!({
                "name": skill.name,
                "version": skill.version,
                "digest": skill.artifact.digest,
                "destination": result.destination,
                "changed": result.changed,
            })
        })
        .collect();
    report_install_receipt(
        context,
        &client,
        &authorization.id,
        activated.iter().any(|result| result.changed),
    );
    emit(
        context.json,
        json!({ "ok": true, "dryRun": context.dry_run, "pack": reference, "version": resolution.version, "members": results }),
    )
}

fn remove_pack(context: &Context, raw_reference: &str) -> Result<(), CliError> {
    let (reference, requested_version) = split_reference(raw_reference)?;
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let state = local_state(&root, context.scope);
    let mut lock = state.read_lock()?;
    let packs: Vec<LockPack> = lock
        .packs
        .iter()
        .filter(|pack| {
            context
                .registry
                .as_ref()
                .map(|registry| pack.registry == registry.url)
                .unwrap_or(true)
                && pack.reference == reference
                && requested_version
                    .as_deref()
                    .map(|v| v == pack.version)
                    .unwrap_or(true)
        })
        .cloned()
        .collect();
    if packs.is_empty() {
        return Err(CliError::Message(format!(
            "pack {reference} is not installed"
        )));
    }
    let mut removed = Vec::new();
    for pack in &packs {
        let owner = format!("pack:{}:{}@{}", pack.registry, pack.reference, pack.version);
        let mut member_names = Vec::new();
        for member in &pack.members {
            if let Some(skill) = lock
                .skills
                .iter()
                .find(|skill| {
                    format!("{}:{}@{}", skill.registry, skill.reference, skill.version) == *member
                })
                .cloned()
            {
                member_names.push(skill.skill_name);
            } else {
                return Err(CliError::Message(format!(
                    "pack lock member `{member}` is missing from the skill lock"
                )));
            }
        }
        member_names.sort();
        member_names.dedup();
        let old_lock = lock.clone();
        let mut new_lock = old_lock.clone();
        new_lock.packs.retain(|candidate| {
            !(candidate.registry == pack.registry
                && candidate.reference == pack.reference
                && candidate.version == pack.version)
        });
        for skill in &mut new_lock.skills {
            skill.owners.retain(|candidate| candidate != &owner);
        }
        new_lock.skills.retain(|skill| !skill.owners.is_empty());
        // Remove all members belonging to this pack in one installer
        // transaction.  Shared members retain their other owners.
        let removed_entries = state.remove_owner_with_lock(
            &owner,
            &member_names,
            context.dry_run,
            Some(&old_lock),
            Some(&new_lock),
        )?;
        removed.extend(removed_entries.into_iter().map(|entry| entry.skill_name));
        if !context.dry_run {
            lock = new_lock;
        }
    }
    emit(
        context.json,
        json!({ "ok": true, "dryRun": context.dry_run, "pack": reference, "removed": removed }),
    )
}

fn list_local(context: &Context) -> Result<(), CliError> {
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let entries = local_state(&root, context.scope).entries()?;
    emit(
        context.json,
        serde_json::to_value(entries).map_err(|e| CliError::Message(e.to_string()))?,
    )
}

fn verify_local(context: &Context) -> Result<(), CliError> {
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let results = local_state(&root, context.scope).verify()?;
    let ok = results.iter().all(|result| result.ok);
    emit(context.json, json!({ "ok": ok, "entries": results }))?;
    if ok {
        Ok(())
    } else {
        Err(CliError::Message(
            "one or more installed skills failed verification".into(),
        ))
    }
}

fn remove_local(
    context: &Context,
    raw_reference: &str,
    owner_prefix: &str,
) -> Result<(), CliError> {
    let (reference, _) = split_reference(raw_reference)?;
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let state = local_state(&root, context.scope);
    let skill_name = last_name(&reference);
    let mut lock = state.read_lock()?;
    let owner = if owner_prefix == "direct" {
        if let Some(registry) = context.registry.as_ref() {
            owner_for_reference(owner_prefix, registry, &reference)
        } else {
            let mut candidates = lock
                .skills
                .iter()
                .filter(|skill| skill.skill_name == skill_name)
                .flat_map(|skill| skill.owners.iter())
                .filter(|candidate| {
                    candidate.starts_with("direct:")
                        && candidate.ends_with(&format!(":{reference}"))
                })
                .cloned()
                .collect::<Vec<_>>();
            candidates.sort();
            candidates.dedup();
            match candidates.as_slice() {
                [candidate] => candidate.clone(),
                [] => {
                    return Err(CliError::Message(format!(
                        "skill {reference} has no direct owner in the local lock"
                    )))
                }
                _ => {
                    return Err(CliError::Message(format!(
                        "skill {reference} is installed from multiple registries; pass --registry to remove one"
                    )))
                }
            }
        }
    } else {
        format!("{owner_prefix}:{reference}")
    };
    let old_lock = lock.clone();
    for skill in &mut lock.skills {
        if skill.skill_name == skill_name {
            skill.owners.retain(|candidate| candidate != &owner);
        }
    }
    lock.skills.retain(|skill| !skill.owners.is_empty());
    let result = state
        .remove_owner_with_lock(
            &owner,
            std::slice::from_ref(&skill_name),
            context.dry_run,
            Some(&old_lock),
            Some(&lock),
        )?
        .into_iter()
        .next()
        .ok_or_else(|| CliError::Message("installer returned no removal result".into()))?;
    emit(
        context.json,
        json!({ "ok": true, "dryRun": context.dry_run, "removed": result.skill_name }),
    )
}

fn update(context: &Context, reference: Option<&str>) -> Result<(), CliError> {
    if let Some(reference) = reference {
        return install_skill(context, reference, "direct");
    }
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let lock = local_state(&root, context.scope).read_lock()?;
    let mut references = lock
        .skills
        .iter()
        .filter(|skill| {
            skill
                .owners
                .iter()
                .any(|owner| owner.starts_with("direct:"))
        })
        .map(|skill| skill.reference.clone())
        .collect::<Vec<_>>();
    references.sort();
    references.dedup();
    if references.is_empty() {
        return emit(context.json, json!({ "ok": true, "updated": [] }));
    }
    for reference in references {
        install_skill(context, &reference, "direct")?;
    }
    Ok(())
}

fn doctor(context: &Context) -> Result<(), CliError> {
    let mut report = BTreeMap::new();
    report.insert("version", Value::String(VERSION.into()));
    report.insert("service", Value::String(SERVICE.into()));
    report.insert("agent", Value::String(context.agent.as_str().into()));
    report.insert("scope", Value::String(context.scope.as_str().into()));
    if let Some(registry) = &context.registry {
        report.insert("registry", Value::String(registry.url.clone()));
    }
    if context.registry.is_some() && std::env::var("PSKILLS_TOKEN").is_ok() {
        report.insert("tokenSource", Value::String("environment".into()));
    } else {
        report.insert(
            "tokenSource",
            Value::String("os-keyring-or-unavailable".into()),
        );
    }
    emit(
        context.json,
        Value::Object(
            report
                .into_iter()
                .map(|(key, value)| (key.to_string(), value))
                .collect(),
        ),
    )
}

fn scan(context: &Context, command: ScanCommand) -> Result<(), CliError> {
    match command {
        ScanCommand::Status { digest } => emit(
            context.json,
            client(context)?.scan_status(digest.as_deref())?,
        ),
    }
}

fn client(context: &Context) -> Result<ApiClient, CliError> {
    let registry = context.registry.as_ref().ok_or_else(|| {
        CliError::Message("this command requires --registry URL or a configured registry".into())
    })?;
    let token = context.credentials.token(&registry.url)?;
    Ok(ApiClient::new(&registry.url, Some(token))?)
}

fn report_install_receipt(
    context: &Context,
    client: &ApiClient,
    authorization_id: &str,
    changed: bool,
) {
    if context.dry_run {
        return;
    }
    let request = InstallReceiptRequest {
        authorization_id: authorization_id.into(),
        changed,
        agent: context.agent.as_str().into(),
        platform: receipt_platform().into(),
        client_version: VERSION.into(),
    };
    if let Err(error) = submit_receipt_with_retry(|| client.submit_install_receipt(&request)) {
        eprintln!("pskills: install analytics receipt unavailable: {error}");
    }
}

fn submit_receipt_with_retry<F>(mut submit: F) -> Result<(), ApiError>
where
    F: FnMut() -> Result<Value, ApiError>,
{
    for attempt in 0..2 {
        match submit() {
            Ok(_) => return Ok(()),
            Err(error) if attempt == 0 && receipt_error_retryable(&error) => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("receipt retry loop always returns")
}

fn receipt_error_retryable(error: &ApiError) -> bool {
    match error {
        ApiError::Transport(_) => true,
        ApiError::Http { status, .. } => {
            matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504)
        }
        _ => false,
    }
}

fn receipt_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => "other",
    }
}

fn local_state(root: &Path, scope: InstallScope) -> LocalState {
    match scope {
        InstallScope::Project => LocalState::for_project(root.to_path_buf()),
        InstallScope::Global => LocalState::for_global(root.to_path_buf()),
    }
}

fn owner_for_reference(owner_prefix: &str, registry: &RegistryConfig, reference: &str) -> String {
    if owner_prefix == "direct" {
        format!("direct:{}:{reference}", registry.url)
    } else {
        format!("{owner_prefix}:{reference}")
    }
}

#[allow(clippy::too_many_arguments)]
fn update_lock_for_skill(
    lock: &mut LockFile,
    registry: &RegistryConfig,
    context: &Context,
    reference: &str,
    skill_name: &str,
    resolution: &Resolution,
    bundle: &SkillBundle,
    owner: &str,
) -> Result<(), CliError> {
    let tree = tree_digest(bundle).map_err(|e| CliError::Message(e.to_string()))?;
    lock.registries.insert(
        registry.url.clone(),
        LockRegistry {
            url: registry.url.clone(),
            organization: resolution.organization_id.clone(),
        },
    );
    let target = LockTarget {
        agent: context.agent.as_str().into(),
        adapter_version: "1".into(),
        scope: context.scope.as_str().into(),
    };
    if !lock.targets.iter().any(|existing| existing == &target) {
        lock.targets.push(target);
        lock.targets.sort_by(|left, right| {
            (&left.agent, &left.scope, &left.adapter_version).cmp(&(
                &right.agent,
                &right.scope,
                &right.adapter_version,
            ))
        });
    }
    for existing in &mut lock.skills {
        if existing.registry == registry.url
            && existing.reference == reference
            && existing.version != resolution.version
        {
            existing
                .owners
                .retain(|existing_owner| existing_owner != owner);
        }
    }
    lock.skills.retain(|skill| !skill.owners.is_empty());
    let key = format!("{}:{}@{}", registry.url, reference, resolution.version);
    if let Some(existing) = lock.skills.iter_mut().find(|skill| skill.key == key) {
        if existing.skill_name != skill_name {
            return Err(CliError::Message(format!(
                "lock identity {key} maps to conflicting install destinations `{}` and `{skill_name}`",
                existing.skill_name
            )));
        }
        existing
            .owners
            .retain(|existing_owner| existing_owner != owner);
        existing.owners.push(owner.into());
        existing.artifact_digest = resolution.digest.clone();
        existing.tree_digest = tree;
    } else {
        lock.skills.push(LockSkill {
            key,
            registry: registry.url.clone(),
            reference: reference.into(),
            version: resolution.version.clone(),
            skill_name: skill_name.into(),
            artifact_digest: resolution.digest.clone(),
            tree_digest: tree,
            owners: vec![owner.into()],
            provenance: resolution
                .members
                .first()
                .map(|member| member.provenance.clone())
                .unwrap_or_default(),
        });
    }
    Ok(())
}

fn frozen_skill_entry(
    context: &Context,
    registry: &RegistryConfig,
    reference: &str,
    requested: Option<&str>,
) -> Result<LockSkill, CliError> {
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let lock = local_state(&root, context.scope).read_lock()?;
    validate_frozen_target(&lock, context)?;
    validate_frozen_registry(&lock, registry)?;
    let entry = lock
        .skills
        .iter()
        .find(|skill| {
            lock_registry_matches(&lock, &skill.registry, registry) && skill.reference == reference
        })
        .cloned()
        .ok_or_else(|| {
            CliError::Message(format!("frozen lockfile has no entry for {reference}"))
        })?;
    if let Some(requested) = requested {
        if requested != entry.version {
            return Err(CliError::Message(format!(
                "frozen lockfile pins {reference}@{}, requested {requested}",
                entry.version
            )));
        }
    }
    Ok(entry)
}

fn frozen_pack_entry(
    context: &Context,
    registry: &RegistryConfig,
    reference: &str,
    requested: Option<&str>,
) -> Result<LockPack, CliError> {
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let lock = local_state(&root, context.scope).read_lock()?;
    validate_frozen_target(&lock, context)?;
    validate_frozen_registry(&lock, registry)?;
    let entry = lock
        .packs
        .iter()
        .find(|pack| {
            lock_registry_matches(&lock, &pack.registry, registry) && pack.reference == reference
        })
        .cloned()
        .ok_or_else(|| {
            CliError::Message(format!("frozen lockfile has no pack entry for {reference}"))
        })?;
    if let Some(requested) = requested {
        if requested != entry.version {
            return Err(CliError::Message(format!(
                "frozen lockfile pins pack {reference}@{}, requested {requested}",
                entry.version
            )));
        }
    }
    Ok(entry)
}

fn frozen_skill_by_key(
    context: &Context,
    registry: &RegistryConfig,
    key: &str,
) -> Result<LockSkill, CliError> {
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let lock = local_state(&root, context.scope).read_lock()?;
    validate_frozen_target(&lock, context)?;
    validate_frozen_registry(&lock, registry)?;
    lock.skills
        .iter()
        .find(|skill| lock_registry_matches(&lock, &skill.registry, registry) && skill.key == key)
        .cloned()
        .ok_or_else(|| CliError::Message(format!("frozen lockfile has no member {key}")))
}

fn validate_frozen_target(lock: &LockFile, context: &Context) -> Result<(), CliError> {
    if !lock.targets.iter().any(|target| {
        target.agent == context.agent.as_str()
            && target.adapter_version == "1"
            && target.scope == context.scope.as_str()
    }) {
        return Err(CliError::Message(format!(
            "frozen lockfile does not target agent {} in {} scope",
            context.agent.as_str(),
            context.scope.as_str()
        )));
    }
    Ok(())
}

fn validate_frozen_registry(lock: &LockFile, registry: &RegistryConfig) -> Result<(), CliError> {
    if !lock
        .registries
        .values()
        .any(|entry| entry.url == registry.url)
    {
        return Err(CliError::Message(format!(
            "frozen lockfile does not contain registry {}",
            registry.url
        )));
    }
    Ok(())
}

fn lock_registry_matches(lock: &LockFile, value: &str, registry: &RegistryConfig) -> bool {
    value == registry.url
        || lock
            .registries
            .get(value)
            .map(|entry| entry.url == registry.url)
            .unwrap_or(false)
}

fn same_resolution(left: &Resolution, right: &Resolution) -> bool {
    left.kind == right.kind
        && left.resource_id == right.resource_id
        && left.organization_id == right.organization_id
        && left.name == right.name
        && left.version == right.version
        && left.digest == right.digest
        && left.members.len() == right.members.len()
        && left.members.iter().zip(&right.members).all(|(a, b)| {
            a.id == b.id
                && a.organization_id == b.organization_id
                && a.name == b.name
                && a.skill_name == b.skill_name
                && a.version == b.version
                && a.artifact.digest == b.artifact.digest
        })
}

fn validate_pack_destinations(
    members: &[(SkillVersion, String, SkillBundle)],
) -> Result<(), CliError> {
    let mut destinations = HashMap::<String, String>::new();
    for (skill, skill_name, _) in members {
        let key = skill_name.to_ascii_lowercase();
        if let Some(previous) = destinations.insert(key, skill.name.clone()) {
            return Err(CliError::Message(format!(
                "pack members `{previous}` and `{}` resolve to the same install destination `{skill_name}`",
                skill.name
            )));
        }
    }
    Ok(())
}

fn reject_agent_reserved_files(agent: Agent, bundle: &SkillBundle) -> Result<(), CliError> {
    if agent == Agent::Claude
        && bundle.files.iter().any(|file| {
            file.path == ".claude-plugin/plugin.json" || file.path.starts_with(".claude-plugin/")
        })
    {
        return Err(CliError::Message(
            "Claude adapter rejects plugin-enabling .claude-plugin files".into(),
        ));
    }
    if agent == Agent::Claude
        && bundle
            .files
            .iter()
            .any(|file| file.path.eq_ignore_ascii_case("synced"))
    {
        return Err(CliError::Message(
            "Claude adapter reserves the `synced` destination".into(),
        ));
    }
    Ok(())
}

fn normalize_skill_source(path: &Path) -> Result<PathBuf, CliError> {
    let metadata = fs::metadata(path).map_err(|source| CliError::Read {
        path: path.into(),
        source,
    })?;
    if metadata.is_file() {
        return Ok(path.parent().unwrap_or(path).to_path_buf());
    }
    if metadata.is_dir() {
        Ok(path.to_path_buf())
    } else {
        Err(CliError::Message(format!(
            "skill source is not a directory: {}",
            path.display()
        )))
    }
}

fn split_reference(raw: &str) -> Result<(String, Option<String>), CliError> {
    let at = raw.rfind('@').filter(|index| *index > 0);
    let (reference, version) = if let Some(index) = at {
        (&raw[..index], Some(raw[index + 1..].to_string()))
    } else {
        (raw, None)
    };
    if !is_valid_reference(reference) {
        return Err(CliError::Message(format!(
            "invalid reference `{raw}`; expected @namespace/skill[@version]"
        )));
    }
    if let Some(version) = version.as_deref() {
        if semver::Version::parse(version).is_err() {
            return Err(CliError::Message(format!(
                "invalid SemVer `{version}` in reference `{raw}`"
            )));
        }
    }
    Ok((reference.to_string(), version))
}

fn is_valid_reference(reference: &str) -> bool {
    let mut parts = reference.split('/');
    let Some(namespace) = parts.next() else {
        return false;
    };
    let Some(skill) = parts.next() else {
        return false;
    };
    if parts.next().is_some()
        || !namespace.starts_with('@')
        || namespace.len() < 2
        || skill.is_empty()
        || namespace[1..].len() > 64
        || skill.len() > 128
    {
        return false;
    }
    let valid = |value: &str| {
        value.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
    };
    valid(&namespace[1..])
        && valid(skill)
        && !namespace[1..].starts_with(['.', '_', '-'])
        && !skill.starts_with(['.', '_', '-'])
}

fn last_name(reference: &str) -> String {
    reference
        .rsplit('/')
        .next()
        .unwrap_or(reference)
        .to_string()
}
fn normalize_registry(url: &str) -> Result<String, CliError> {
    let url = url.trim().trim_end_matches('/');
    let parsed = url::Url::parse(url)
        .map_err(|e| CliError::Message(format!("invalid registry URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(CliError::Message(
            "registry URL must be an http(s) origin without credentials, query, or fragment".into(),
        ));
    }
    if parsed.scheme() == "http"
        && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
    {
        return Err(CliError::Message(
            "HTTP registries are allowed only on loopback; use HTTPS for remote registries".into(),
        ));
    }
    Ok(url.into())
}
fn validate_pack_draft(draft: &PackDraft) -> Result<(), CliError> {
    if draft.schema_version != 1 || draft.kind != "pack" {
        return Err(CliError::Message(
            "pack draft must have schemaVersion 1 and kind `pack`".into(),
        ));
    }
    if draft.skills.is_empty() || draft.skills.len() > 100 {
        return Err(CliError::Message(
            "pack must contain between 1 and 100 skills".into(),
        ));
    }
    let (_, embedded_version) = split_reference(&draft.name)?;
    if embedded_version.is_some() {
        return Err(CliError::Message(
            "pack name must not include a version".into(),
        ));
    }
    semver::Version::parse(&draft.version)
        .map_err(|_| CliError::Message(format!("invalid pack SemVer `{}`", draft.version)))?;
    for member in &draft.skills {
        split_reference(&member.reference)?;
        if member.version.trim().is_empty() {
            return Err(CliError::Message(format!(
                "pack member {} has no version selector",
                member.reference
            )));
        }
    }
    Ok(())
}

fn emit(json_output: bool, value: Value) -> Result<(), CliError> {
    if json_output {
        println!(
            "{}",
            serde_json::to_string(&value).map_err(|e| CliError::Message(e.to_string()))?
        );
    } else if let Some(message) = value.get("message").and_then(Value::as_str) {
        println!("{message}");
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&value).map_err(|e| CliError::Message(e.to_string()))?
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_retry_recovers_transient_failure() {
        let mut attempts = 0;
        let result = submit_receipt_with_retry(|| {
            attempts += 1;
            if attempts == 1 {
                Err(ApiError::Transport("temporary network error".into()))
            } else {
                Ok(Value::Null)
            }
        });
        assert!(result.is_ok());
        assert_eq!(attempts, 2);
    }

    #[test]
    fn receipt_failure_is_bounded_and_non_retryable_errors_are_not_repeated() {
        let mut attempts = 0;
        let result = submit_receipt_with_retry(|| {
            attempts += 1;
            Err(ApiError::Http {
                status: 400,
                message: "invalid receipt".into(),
            })
        });
        assert!(result.is_err());
        assert_eq!(attempts, 1);
    }

    #[test]
    fn directory_subcommands_parse_with_global_json_and_import_options() {
        let cli = Cli::try_parse_from([
            "pskills",
            "--json",
            "directory",
            "import",
            "vercel-labs/skills/find-skills",
            "--name",
            "@team/find-skills",
            "--version",
            "1.0.0",
            "--upstream-id",
            "skills-sh",
        ])
        .expect("directory import arguments");
        assert!(cli.json);
        match cli.command {
            Command::Directory {
                command: DirectoryCommand::Import(args),
            } => {
                assert_eq!(args.id, "vercel-labs/skills/find-skills");
                assert_eq!(args.name, "@team/find-skills");
                assert_eq!(args.version, "1.0.0");
                assert_eq!(args.upstream_id.as_deref(), Some("skills-sh"));
            }
            _ => panic!("expected directory import"),
        }
    }

    #[test]
    fn directory_input_validation_matches_directory_limits() {
        assert_eq!(directory_view("hot").expect("hot view"), "hot");
        assert!(directory_view("recent").is_err());
        assert_eq!(directory_query("  ab  ").expect("query"), "ab");
        assert!(directory_query("a").is_err());
        assert!(directory_owner("   ").is_err());
        assert!(directory_identifier(" \n ").is_err());
    }
}
