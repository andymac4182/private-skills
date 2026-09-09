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
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
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
    Show {
        reference: String,
    },
    Versions {
        reference: String,
    },
    Publish(PublishArgs),
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
                | Command::Pack {
                    command: PackCommand::Publish { .. }
                }
        );
    let registry_not_required = registry_not_required
        || (matches!(&cli.command, Command::Health) && cli.registry.is_none());
    let context = Context {
        registry: if registry_not_required || local_dry_run {
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
        Command::Show { reference } => show(&context, &reference),
        Command::Versions { reference } => versions(&context, &reference),
        Command::Publish(args) => publish(&context, &args),
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
    let client = client(context)?;
    let skills = client.search(reference)?;
    let values: Vec<Value> = skills.into_iter().filter(|skill| skill.name == reference || skill.name.starts_with(&format!("{reference}@"))).map(|skill| json!({ "version": skill.version, "state": skill.state, "digest": skill.artifact.digest })).collect();
    emit(context.json, Value::Array(values))
}

fn publish(context: &Context, args: &PublishArgs) -> Result<(), CliError> {
    let path = normalize_skill_source(&args.path)?;
    let bundle = bundle_from_directory(&path, BundleLimits::default())
        .map_err(|e| CliError::Message(e.to_string()))?;
    let digest = bundle_digest(&bundle).map_err(|e| CliError::Message(e.to_string()))?;
    if context.dry_run {
        return emit(
            context.json,
            json!({ "dryRun": true, "name": args.name, "version": args.version, "digest": digest, "files": bundle.files.len() }),
        );
    }
    let client = client(context)?;
    let request = publish_request(
        args.name.clone(),
        args.version.clone(),
        args.description.clone(),
        &bundle,
    )?;
    emit(context.json, client.publish(&request)?)
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
    let version = if context.frozen {
        frozen_version(context, &reference, requested_version.as_deref())?
    } else {
        requested_version.clone()
    };
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
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    reject_agent_reserved_files(context.agent, &bundle)?;
    let second = client.validate_authorization(&authorization.id)?;
    if second.resolution.digest != authorization.resolution.digest {
        return Err(CliError::Message(
            "install authorization changed during transfer".into(),
        ));
    }
    let state = local_state(&root, context.scope);
    let owner = format!("{owner_prefix}:{reference}");
    let result = state.install(&InstallPlan {
        root: root.clone(),
        skill_name: skill_name.clone(),
        bundle: bundle.clone(),
        artifact_digest: artifact_digest.clone(),
        owner: owner.clone(),
        dry_run: context.dry_run,
    })?;
    if !context.dry_run {
        let mut lock = state.read_lock()?;
        update_lock_for_skill(
            &mut lock,
            registry,
            context,
            &reference,
            &skill_name,
            &resolution,
            &bundle,
            &owner,
        )?;
        state.write_lock(&lock)?;
    }
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
    let version = if context.frozen {
        frozen_version(context, &reference, requested_version.as_deref())?
    } else {
        requested_version
    };
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
    let authorization = client.authorize(&resolution)?;
    let mut downloaded = Vec::with_capacity(resolution.members.len());
    for skill in &resolution.members {
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
        reject_agent_reserved_files(context.agent, &bundle)?;
        downloaded.push((skill.clone(), skill_name, bundle));
    }
    let second = client.validate_authorization(&authorization.id)?;
    if second.resolution.digest != authorization.resolution.digest {
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
    let mut results = Vec::new();
    for (skill, skill_name, bundle) in &downloaded {
        let result = state.install(&InstallPlan {
            root: root.clone(),
            skill_name: skill_name.clone(),
            bundle: bundle.clone(),
            artifact_digest: skill.artifact.digest.clone(),
            owner: owner.clone(),
            dry_run: context.dry_run,
        })?;
        results.push(json!({ "name": skill.name, "version": skill.version, "digest": skill.artifact.digest, "destination": result.destination }));
    }
    if !context.dry_run {
        let mut lock = state.read_lock()?;
        let members: Vec<String> = downloaded
            .iter()
            .map(|(skill, _, _)| format!("{}:{}@{}", registry.url, skill.name, skill.version))
            .collect();
        lock.packs
            .retain(|pack| !(pack.reference == reference && pack.version == resolution.version));
        lock.packs.push(LockPack {
            registry: registry.url.clone(),
            reference: reference.clone(),
            version: resolution.version.clone(),
            manifest_digest: resolution.digest.clone(),
            members,
        });
        for (skill, skill_name, bundle) in &downloaded {
            update_lock_for_skill(
                &mut lock,
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
        state.write_lock(&lock)?;
    }
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
            pack.reference == reference
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
        for member in &pack.members {
            if let Some(skill) = lock
                .skills
                .iter()
                .find(|skill| {
                    format!("{}:{}@{}", skill.registry, skill.reference, skill.version) == *member
                })
                .cloned()
            {
                let result = state.remove(&skill.skill_name, Some(&owner), context.dry_run)?;
                removed.push(result.skill_name);
            }
        }
    }
    if !context.dry_run {
        lock.packs.retain(|pack| {
            !packs.iter().any(|selected| {
                selected.registry == pack.registry
                    && selected.reference == pack.reference
                    && selected.version == pack.version
            })
        });
        for skill in &mut lock.skills {
            for pack in &packs {
                let owner = format!("pack:{}:{}@{}", pack.registry, pack.reference, pack.version);
                skill.owners.retain(|candidate| candidate != &owner);
            }
        }
        lock.skills.retain(|skill| !skill.owners.is_empty());
        state.write_lock(&lock)?;
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
    let result = state.remove(
        &skill_name,
        Some(&format!("{owner_prefix}:{reference}")),
        context.dry_run,
    )?;
    if !context.dry_run {
        let mut lock = state.read_lock()?;
        lock.skills.retain(|skill| {
            skill.skill_name != skill_name
                || skill
                    .owners
                    .iter()
                    .any(|owner| owner != &format!("{owner_prefix}:{reference}"))
        });
        state.write_lock(&lock)?;
    }
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

fn local_state(root: &Path, scope: InstallScope) -> LocalState {
    match scope {
        InstallScope::Project => LocalState::for_project(root.to_path_buf()),
        InstallScope::Global => LocalState::for_global(root.to_path_buf()),
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
    lock.targets = vec![LockTarget {
        agent: context.agent.as_str().into(),
        adapter_version: "1".into(),
        scope: context.scope.as_str().into(),
    }];
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

fn frozen_version(
    context: &Context,
    reference: &str,
    requested: Option<&str>,
) -> Result<Option<String>, CliError> {
    let root = resolve_directory(context.directory.as_deref(), context.agent, context.scope)?;
    let lock = local_state(&root, context.scope).read_lock()?;
    let entry = lock
        .skills
        .iter()
        .find(|skill| skill.reference == reference)
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
    Ok(Some(entry.version.clone()))
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
    if !reference.starts_with('@') || reference.matches('/').count() != 1 || reference.len() < 4 {
        return Err(CliError::Message(format!(
            "invalid reference `{raw}`; expected @namespace/skill[@version]"
        )));
    }
    Ok((reference.to_string(), version))
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
        || parsed.fragment().is_some()
    {
        return Err(CliError::Message(
            "registry URL must be an http(s) origin without credentials or a fragment".into(),
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
