use crate::bundle::{canonical_bundle_bytes, decode_bundle_bytes, digest_bytes};
use crate::model::*;
use crate::{SERVICE, VERSION};
use reqwest::blocking::{Client, RequestBuilder};
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE, USER_AGENT,
};
use reqwest::redirect::Policy;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::VecDeque;
#[cfg(test)]
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use url::Url;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("registry URL is invalid: {0}")]
    InvalidUrl(String),
    #[error("cannot connect to registry: {0}")]
    Transport(String),
    #[error("registry returned HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("registry response is invalid: {0}")]
    Response(String),
    #[error("artifact digest mismatch: expected {expected}, received {actual}")]
    DigestMismatch { expected: String, actual: String },
    #[error("artifact response is larger than its declared size ({actual} > {declared})")]
    SizeMismatch { actual: u64, declared: u64 },
    #[error("operation `{0}` did not complete before the timeout")]
    OperationTimeout(String),
    #[error("registry operation failed: {0}")]
    OperationFailed(String),
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ApiClient {
    base: Url,
    token: Option<String>,
    http: Client,
    #[cfg(test)]
    mock: Option<Arc<Mutex<VecDeque<MockExchange>>>>,
}

#[cfg(test)]
#[derive(Debug)]
struct MockExchange {
    method: String,
    path: String,
    request: Option<Value>,
    status: u16,
    response: Vec<u8>,
}

impl ApiClient {
    pub fn new(base: &str, token: Option<String>) -> Result<Self, ApiError> {
        let mut url = Url::parse(base).map_err(|e| ApiError::InvalidUrl(e.to_string()))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ApiError::InvalidUrl(
                "registry URL must use http or https".into(),
            ));
        }
        if url.scheme() == "http" && !is_loopback_url(&url) {
            return Err(ApiError::InvalidUrl(
                "HTTP registries are allowed only on loopback; use HTTPS for remote registries"
                    .into(),
            ));
        }
        if url.username() != ""
            || url.password().is_some()
            || url.fragment().is_some()
            || url.query().is_some()
        {
            return Err(ApiError::InvalidUrl(
                "registry URL must be an origin without credentials, query, or fragment".into(),
            ));
        }
        while url.path().len() > 1 && url.path().ends_with('/') {
            let trimmed = url.path().trim_end_matches('/').to_string();
            url.set_path(&trimmed);
        }
        let http = Client::builder()
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| ApiError::Transport(e.to_string()))?;
        Ok(Self {
            base: url,
            token,
            http,
            #[cfg(test)]
            mock: None,
        })
    }

    #[cfg(test)]
    fn with_mock_exchanges(base: &str, exchanges: Vec<MockExchange>) -> Result<Self, ApiError> {
        let mut client = Self::new(base, None)?;
        client.mock = Some(Arc::new(Mutex::new(exchanges.into_iter().collect())));
        Ok(client)
    }

    pub fn base_url(&self) -> &Url {
        &self.base
    }

    pub fn health(&self) -> Result<HealthResponse, ApiError> {
        self.get_json(&self.endpoint(&["health"])?, false)
    }

    pub fn whoami(&self) -> Result<Principal, ApiError> {
        let value: Value = self.get_json(&self.endpoint(&["v1", "me"])?, true)?;
        if let Ok(principal) = serde_json::from_value::<Principal>(value.clone()) {
            return Ok(principal);
        }
        extract(value, "principal")
    }

    /// Discover the feeds available to the authenticated principal. The
    /// registry remains the only source of feed configuration; the CLI never
    /// contacts a feed origin directly.
    pub fn feeds(&self) -> Result<Vec<FeedInfo>, ApiError> {
        let value: Value = self.get_json(&self.endpoint(&["v1", "feeds"])?, true)?;
        if let Ok(response) = serde_json::from_value::<FeedList>(value.clone()) {
            return Ok(response.feeds);
        }
        if let Ok(feeds) = serde_json::from_value::<Vec<FeedInfo>>(value.clone()) {
            return Ok(feeds);
        }
        extract(value, "feeds")
    }

    pub fn search(&self, query: &str) -> Result<Vec<SkillVersion>, ApiError> {
        let mut url = self.endpoint(&["v1", "skills"])?;
        url.query_pairs_mut().append_pair("q", query);
        let value: Value = self.get_json(&url, true)?;
        if let Ok(response) = serde_json::from_value::<SearchResponse>(value.clone()) {
            return Ok(response.skills);
        }
        extract(value, "skills")
    }

    /// List the registry's authenticated directory view.  The registry is
    /// the only network boundary here: this client never fetches skills.sh
    /// or another directory source directly.
    pub fn directory_list(&self, view: &str, page: u32, per_page: u32) -> Result<Value, ApiError> {
        if !matches!(view, "all-time" | "trending" | "hot") {
            return Err(ApiError::Response(format!(
                "directory view must be one of all-time, trending, or hot (received `{view}`)"
            )));
        }
        if per_page == 0 || per_page > 500 {
            return Err(ApiError::Response(
                "directory per_page must be between 1 and 500".into(),
            ));
        }
        let url = self.directory_url(
            "skills",
            &[
                ("view", view.to_string()),
                ("page", page.to_string()),
                ("per_page", per_page.to_string()),
            ],
        )?;
        self.get_json(&url, true)
    }

    /// Search the registry's directory index.  Results and any source data
    /// remain owned by the registry response; the CLI does not contact the
    /// public directory or upstream repositories.
    pub fn directory_search(
        &self,
        query: &str,
        owner: Option<&str>,
        limit: u32,
    ) -> Result<Value, ApiError> {
        let query = query.trim();
        if query.chars().count() < 2 {
            return Err(ApiError::Response(
                "directory search query must contain at least two characters".into(),
            ));
        }
        if limit == 0 || limit > 200 {
            return Err(ApiError::Response(
                "directory search limit must be between 1 and 200".into(),
            ));
        }
        let owner = owner.map(str::trim).filter(|value| !value.is_empty());
        let mut query_parameters = vec![("q", query.to_string()), ("limit", limit.to_string())];
        if let Some(owner) = owner {
            query_parameters.push(("owner", owner.to_string()));
        }
        let url = self.directory_url("search", &query_parameters)?;
        self.get_json(&url, true)
    }

    /// Return the registry's first-party directory grouping.
    pub fn directory_official(&self) -> Result<Value, ApiError> {
        self.get_json(&self.directory_url("official", &[])?, true)
    }

    /// Return bounded metadata for one directory identifier.
    pub fn directory_detail(&self, id: &str) -> Result<Value, ApiError> {
        let id = id.trim();
        if id.is_empty() {
            return Err(ApiError::Response(
                "directory detail id must not be empty".into(),
            ));
        }
        let url = self.directory_url("detail", &[("id", id.to_string())])?;
        self.get_json(&url, true)
    }

    /// Return external audit evidence for one directory identifier.
    pub fn directory_audits(&self, id: &str) -> Result<Value, ApiError> {
        let id = id.trim();
        if id.is_empty() {
            return Err(ApiError::Response(
                "directory audits id must not be empty".into(),
            ));
        }
        let url = self.directory_url("audits", &[("id", id.to_string())])?;
        self.get_json(&url, true)
    }

    /// Ask the registry to import a directory entry.  The response is kept
    /// opaque because a registry may return an accepted operation, a cached
    /// resolution, or another versioned operation envelope.
    pub fn directory_import(&self, request: &DirectoryImportRequest) -> Result<Value, ApiError> {
        self.post_json(
            &self.endpoint(&["v1", "directory", "import"])?,
            request,
            true,
        )
    }

    pub fn show_skill(
        &self,
        reference: &str,
        version: Option<&str>,
    ) -> Result<SkillVersion, ApiError> {
        if reference.starts_with('@') {
            let candidates = self.search(reference)?;
            return candidates
                .into_iter()
                .filter(|skill| {
                    skill.name == reference
                        && version
                            .map(|wanted| wanted == skill.version)
                            .unwrap_or(true)
                })
                .max_by(|left, right| {
                    semver::Version::parse(&left.version)
                        .ok()
                        .cmp(&semver::Version::parse(&right.version).ok())
                })
                .ok_or_else(|| ApiError::Http {
                    status: 404,
                    message: "skill not found".into(),
                });
        }
        let mut url = self.endpoint(&["v1", "skills", reference])?;
        if let Some(version) = version {
            url.query_pairs_mut().append_pair("version", version);
        }
        let value: Value = self.get_json(&url, true)?;
        if let Ok(skill) = serde_json::from_value::<SkillVersion>(value.clone()) {
            return Ok(skill);
        }
        extract(value, "skill")
    }

    /// Fetch one already-imported skill by its registry resource id. This is
    /// used when a transparent resolve completes on a rescan job, whose
    /// operation has no import payload to pin the private name and version.
    pub fn skill_by_id(&self, resource_id: &str) -> Result<SkillVersion, ApiError> {
        let resource_id = resource_id.trim();
        if resource_id.is_empty() {
            return Err(ApiError::Response(
                "skill resource id must not be empty".into(),
            ));
        }
        let value: Value = self.get_json(&self.endpoint(&["v1", "skills", resource_id])?, true)?;
        if let Ok(skill) = serde_json::from_value::<SkillVersion>(value.clone()) {
            return Ok(skill);
        }
        extract(value, "skill")
    }

    pub fn publish(&self, request: &PublishRequest) -> Result<Value, ApiError> {
        let value: Value = self.post_json(&self.endpoint(&["v1", "publish"])?, request, true)?;
        Ok(value)
    }

    pub fn resolve(&self, request: &ResolveRequest) -> Result<Resolution, ApiError> {
        self.resolve_until(request, std::time::Instant::now() + Duration::from_secs(60))
    }

    /// Resolve a registry-managed pull-through request.  The registry may
    /// return a queued import operation; polling and the final cache lookup
    /// stay on the registry origin and never contact the upstream locally.
    pub fn proxy_resolve(&self, request: &ImportRequest) -> Result<Resolution, ApiError> {
        self.proxy_resolve_until(request, std::time::Instant::now() + Duration::from_secs(60))
    }

    /// Resolve a canonical skills.sh identity through the registry.  The
    /// registry selects the approved mapping and private release identity;
    /// this client never derives or fetches the external source itself.
    pub fn resolve_external(
        &self,
        feed: Option<&str>,
        external_id: &str,
        refresh: bool,
    ) -> Result<ExternalResolution, ApiError> {
        let external_id = external_id.trim();
        if external_id.is_empty() {
            return Err(ApiError::Response(
                "external skills.sh identity must not be empty".into(),
            ));
        }
        if let Some(feed_name) = feed {
            let feed_name = feed_name.trim();
            let feed = self
                .feeds()?
                .into_iter()
                .find(|candidate| candidate.name == feed_name)
                .ok_or_else(|| {
                    ApiError::Response(format!(
                        "configured feed `{feed_name}` was not returned by the registry"
                    ))
                })?;
            if feed.kind != "skills-sh" {
                return Err(ApiError::Response(format!(
                    "configured feed `{feed_name}` is not a skills.sh feed"
                )));
            }
            if !feed.enabled {
                return Err(ApiError::Response(format!(
                    "configured feed `{feed_name}` is disabled"
                )));
            }
        }
        let request = ExternalResolveRequest {
            feed: feed.map(str::to_owned),
            external_id: external_id.into(),
            refresh: refresh.then_some(true),
        };
        self.resolve_external_until(
            &request,
            std::time::Instant::now() + Duration::from_secs(60),
        )
    }

    fn proxy_resolve_until(
        &self,
        request: &ImportRequest,
        deadline: std::time::Instant,
    ) -> Result<Resolution, ApiError> {
        let url = self.endpoint(&["v1", "proxy", "resolve"])?;
        let response = self.send(
            self.http
                .post(url)
                .header(CONTENT_TYPE, "application/json")
                .json(request),
            true,
        )?;
        if response.status == 202 {
            let operation_value = parse_json(response.body)?;
            let operation_id = extract_operation_id(&operation_value)?;
            return self.wait_for_proxy_resolution(&operation_id, request, deadline);
        }
        ensure_success(&response)?;
        extract_resolution(parse_json(response.body)?)
    }

    fn resolve_external_until(
        &self,
        request: &ExternalResolveRequest,
        deadline: std::time::Instant,
    ) -> Result<ExternalResolution, ApiError> {
        let url = self.endpoint(&["v1", "proxy", "resolve"])?;
        let response = self.send(
            self.http
                .post(url)
                .header(CONTENT_TYPE, "application/json")
                .json(request),
            true,
        )?;
        if response.status == 202 {
            let operation_value = parse_json(response.body)?;
            let operation_id = extract_operation_id(&operation_value)?;
            return self.wait_for_external_resolution(&operation_id, request, deadline);
        }
        ensure_success(&response)?;
        let value = parse_json(response.body)?;
        let reference = value
            .get("reference")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(ExternalResolution {
            resolution: extract_resolution(value)?,
            reference,
        })
    }

    fn resolve_until(
        &self,
        request: &ResolveRequest,
        deadline: std::time::Instant,
    ) -> Result<Resolution, ApiError> {
        let url = self.endpoint(&["v1", "resolve"])?;
        let response = self.send(self.http.post(url).json(request), true)?;
        if response.status == 202 {
            let operation_value: Value = parse_json(response.body)?;
            let operation_id = extract_operation_id(&operation_value)?;
            return self.wait_for_resolution(&operation_id, request, deadline);
        }
        ensure_success(&response)?;
        let value = parse_json(response.body)?;
        if let Ok(resolution) = serde_json::from_value::<Resolution>(value.clone()) {
            return Ok(resolution);
        }
        extract(value, "resolution")
    }

    pub fn authorize(&self, resolution: &Resolution) -> Result<InstallAuthorization, ApiError> {
        let url = self.endpoint(&["v1", "install-authorizations"])?;
        let value: Value = self.post_json(&url, resolution, true)?;
        parse_install_authorization(value)
    }

    pub fn validate_authorization(&self, id: &str) -> Result<InstallAuthorization, ApiError> {
        let url = self.endpoint(&["v1", "install-authorizations", id, "validate"])?;
        let value: Value = self.post_json_no_body(&url, true)?;
        parse_install_authorization(value)
    }

    /// Record a completed install or up-to-date check.  The caller invokes
    /// this only after the local transaction commits; the server uses the
    /// authorization id as its idempotency key.
    pub fn submit_install_receipt(
        &self,
        request: &InstallReceiptRequest,
    ) -> Result<Value, ApiError> {
        self.post_json(&self.endpoint(&["v1", "install-receipts"])?, request, true)
    }

    pub fn download_descriptor(
        &self,
        artifact_digest: &str,
        resource_id: &str,
        authorization_id: &str,
    ) -> Result<TransferDescriptor, ApiError> {
        let url = self.endpoint(&["v1", "artifacts", artifact_digest, "download"])?;
        let request = DownloadRequest {
            resource_id: resource_id.into(),
            authorization_id: authorization_id.into(),
        };
        let value: Value = self.post_json(&url, &request, true)?;
        if let Ok(descriptor) = serde_json::from_value::<TransferDescriptor>(value.clone()) {
            return Ok(descriptor);
        }
        extract(value, "transfer")
    }

    /// Fetch only the opaque transfer URL and descriptor-authorized headers.
    /// The registry bearer token is deliberately never added to this request.
    pub fn download_transfer(&self, descriptor: &TransferDescriptor) -> Result<Vec<u8>, ApiError> {
        if !descriptor.method.eq_ignore_ascii_case("GET") {
            return Err(ApiError::Response(
                "transfer descriptor must use GET".into(),
            ));
        }
        let target =
            Url::parse(&descriptor.url).map_err(|e| ApiError::InvalidUrl(e.to_string()))?;
        if !matches!(target.scheme(), "http" | "https")
            || (target.scheme() == "http" && !is_loopback_url(&target))
            || target.username() != ""
            || target.password().is_some()
            || target.fragment().is_some()
        {
            return Err(ApiError::InvalidUrl("transfer URL is invalid".into()));
        }
        let mut request = self.http.get(target.clone());
        let mut headers = HeaderMap::new();
        for (name, value) in &descriptor.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|e| ApiError::Response(format!("invalid transfer header name: {e}")))?;
            let value = HeaderValue::from_str(value)
                .map_err(|e| ApiError::Response(format!("invalid transfer header value: {e}")))?;
            if name == AUTHORIZATION || name == USER_AGENT {
                return Err(ApiError::Response(
                    "transfer descriptor cannot override authorization or user-agent".into(),
                ));
            }
            if matches!(
                name,
                ref header
                    if header == reqwest::header::HOST
                        || header == reqwest::header::COOKIE
                        || header == reqwest::header::PROXY_AUTHORIZATION
                        || header == reqwest::header::PROXY_AUTHENTICATE
                        || header == reqwest::header::TRANSFER_ENCODING
            ) {
                return Err(ApiError::Response(
                    "transfer descriptor cannot override connection or proxy credentials".into(),
                ));
            }
            headers.insert(name, value);
        }
        request = request.headers(headers);
        let same_origin = same_origin(&self.base, &target);
        let authorized_gateway = descriptor.mode == "gateway" && same_origin;
        if descriptor.mode == "gateway" && !same_origin {
            return Err(ApiError::InvalidUrl(
                "gateway transfer URL must use the registry origin".into(),
            ));
        }
        if descriptor.mode != "gateway" && descriptor.mode != "signed-url" {
            return Err(ApiError::Response(
                "transfer descriptor mode must be gateway or signed-url".into(),
            ));
        }
        let response = self.send(request, authorized_gateway)?;
        ensure_success(&response)?;
        let actual = response.body.len() as u64;
        if actual != descriptor.size {
            return Err(ApiError::SizeMismatch {
                actual,
                declared: descriptor.size,
            });
        }
        let digest = digest_bytes(&response.body);
        if digest != descriptor.digest {
            return Err(ApiError::DigestMismatch {
                expected: descriptor.digest.clone(),
                actual: digest,
            });
        }
        Ok(response.body)
    }

    pub fn list_packs(&self) -> Result<Vec<PackVersion>, ApiError> {
        let value: Value = self.get_json(&self.endpoint(&["v1", "packs"])?, true)?;
        if let Ok(packs) = serde_json::from_value::<Vec<PackVersion>>(value.clone()) {
            return Ok(packs);
        }
        extract(value, "packs")
    }

    pub fn show_pack(
        &self,
        reference: &str,
        version: Option<&str>,
    ) -> Result<PackVersion, ApiError> {
        if reference.starts_with('@') {
            let candidates = self.list_packs()?;
            return candidates
                .into_iter()
                .filter(|pack| {
                    pack.name == reference
                        && version.map(|wanted| wanted == pack.version).unwrap_or(true)
                })
                .max_by(|left, right| {
                    semver::Version::parse(&left.version)
                        .ok()
                        .cmp(&semver::Version::parse(&right.version).ok())
                })
                .ok_or_else(|| ApiError::Http {
                    status: 404,
                    message: "pack not found".into(),
                });
        }
        let mut url = self.endpoint(&["v1", "packs", reference])?;
        if let Some(version) = version {
            url.query_pairs_mut().append_pair("version", version);
        }
        let value: Value = self.get_json(&url, true)?;
        if let Ok(pack) = serde_json::from_value::<PackVersion>(value.clone()) {
            return Ok(pack);
        }
        extract(value, "pack")
    }

    pub fn publish_pack(&self, draft: &PackDraft) -> Result<Value, ApiError> {
        let value: Value = self.post_json(&self.endpoint(&["v1", "packs"])?, draft, true)?;
        Ok(value)
    }

    pub fn remove_pack(&self, reference: &str, version: Option<&str>) -> Result<Value, ApiError> {
        let mut url = self.endpoint(&["v1", "packs", reference])?;
        if let Some(version) = version {
            url.query_pairs_mut().append_pair("version", version);
        }
        let value = self.send(self.authorized(self.http.delete(url)), true)?;
        ensure_success(&value)?;
        Ok(parse_json(value.body).unwrap_or(Value::Null))
    }

    pub fn scan_status(&self, digest: Option<&str>) -> Result<Value, ApiError> {
        let mut url = self.endpoint(&["v1", "scans"])?;
        if let Some(digest) = digest {
            url.query_pairs_mut().append_pair("artifactDigest", digest);
        }
        self.get_json(&url, true)
    }

    pub fn raw_get(&self, path: &[&str]) -> Result<Value, ApiError> {
        self.get_json(&self.endpoint(path)?, true)
    }

    fn wait_for_resolution(
        &self,
        operation_id: &str,
        request: &ResolveRequest,
        deadline: std::time::Instant,
    ) -> Result<Resolution, ApiError> {
        loop {
            let value: Value =
                self.get_json(&self.endpoint(&["v1", "operations", operation_id])?, true)?;
            match inspect_operation(&value, "operation failed")? {
                OperationPollAction::Resolution(resolution) => return Ok(resolution),
                OperationPollAction::Completed => {
                    // The registry operation only records that its scan/import
                    // finished.  The immutable resolution is obtained by
                    // repeating the fenced resolve request after completion.
                    return self.resolve_until(request, deadline);
                }
                OperationPollAction::Pending => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(ApiError::OperationTimeout(operation_id.into()));
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            std::thread::sleep(remaining.min(Duration::from_millis(250)));
        }
    }

    fn wait_for_proxy_resolution(
        &self,
        operation_id: &str,
        request: &ImportRequest,
        deadline: std::time::Instant,
    ) -> Result<Resolution, ApiError> {
        loop {
            let value: Value =
                self.get_json(&self.endpoint(&["v1", "operations", operation_id])?, true)?;
            match inspect_operation(&value, "proxy operation failed")? {
                OperationPollAction::Resolution(resolution) => return Ok(resolution),
                OperationPollAction::Completed => {
                    return self.proxy_resolve_until(request, deadline);
                }
                OperationPollAction::Pending => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(ApiError::OperationTimeout(operation_id.into()));
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            std::thread::sleep(remaining.min(Duration::from_millis(250)));
        }
    }

    fn wait_for_external_resolution(
        &self,
        operation_id: &str,
        request: &ExternalResolveRequest,
        deadline: std::time::Instant,
    ) -> Result<ExternalResolution, ApiError> {
        loop {
            let value: Value =
                self.get_json(&self.endpoint(&["v1", "operations", operation_id])?, true)?;
            let action = inspect_operation(&value, "external import operation failed")?;
            let operation_state = value
                .get("operation")
                .and_then(|operation| operation.get("state"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(operation_state, "completed" | "succeeded" | "done") {
                return self.resolve_completed_external_operation(&value, request, deadline);
            }
            match action {
                OperationPollAction::Resolution(resolution) => {
                    let reference = resolution
                        .members
                        .first()
                        .and_then(|member| member.provenance.source_reference.clone());
                    return Ok(ExternalResolution {
                        resolution,
                        reference,
                    });
                }
                OperationPollAction::Completed => {
                    return self.resolve_completed_external_operation(&value, request, deadline);
                }
                OperationPollAction::Pending => {}
            }
            if std::time::Instant::now() >= deadline {
                return Err(ApiError::OperationTimeout(operation_id.into()));
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            std::thread::sleep(remaining.min(Duration::from_millis(250)));
        }
    }

    fn resolve_completed_external_operation(
        &self,
        operation_value: &Value,
        request: &ExternalResolveRequest,
        deadline: std::time::Instant,
    ) -> Result<ExternalResolution, ApiError> {
        let pin = match completed_external_operation(operation_value, request)? {
            CompletedExternalPin::Import(pin) => pin,
            CompletedExternalPin::Rescan { resource_id } => {
                let skill = self.skill_by_id(&resource_id)?;
                verify_completed_external_skill(&skill, &resource_id, request)?;
                CompletedExternalOperation {
                    external_id: request.external_id.clone(),
                    feed_name: skill.provenance.feed_name.clone(),
                    name: skill.name,
                    version: skill.version,
                    resource_id: skill.id,
                }
            }
        };
        let resolution = self.resolve_until(
            &ResolveRequest {
                kind: "skill".into(),
                reference: pin.name.clone(),
                version: Some(pin.version.clone()),
            },
            deadline,
        )?;
        verify_completed_external_resolution(&resolution, &pin, request)?;
        let reference = resolution
            .members
            .first()
            .and_then(|member| member.provenance.source_reference.clone());
        Ok(ExternalResolution {
            resolution,
            reference,
        })
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url, ApiError> {
        let mut url = self.base.clone();
        let needs_slash = !url.path().ends_with('/') && !url.path().is_empty();
        if needs_slash {
            let mut path_string = url.path().to_string();
            path_string.push('/');
            url.set_path(&path_string);
        }
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| ApiError::InvalidUrl("registry URL cannot be a base".into()))?;
            path.extend(segments.iter().copied());
        }
        Ok(url)
    }

    fn directory_url(&self, resource: &str, query: &[(&str, String)]) -> Result<Url, ApiError> {
        let mut url = self.endpoint(&["v1", "directory", resource])?;
        for (key, value) in query {
            url.query_pairs_mut().append_pair(key, value);
        }
        Ok(url)
    }

    fn authorized(&self, request: RequestBuilder) -> RequestBuilder {
        let request = request.header(USER_AGENT, format!("{SERVICE}/{VERSION}"));
        if let Some(token) = self.token.as_deref() {
            request.header(AUTHORIZATION, format!("Bearer {token}"))
        } else {
            request
        }
    }

    fn send(&self, request: RequestBuilder, authorized: bool) -> Result<HttpResponse, ApiError> {
        let request = if authorized {
            self.authorized(request)
        } else {
            request.header(USER_AGENT, format!("{SERVICE}/{VERSION}"))
        };
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            let request = request
                .build()
                .map_err(|error| ApiError::Transport(error.to_string()))?;
            let exchange = mock
                .lock()
                .expect("mock exchange lock")
                .pop_front()
                .ok_or_else(|| {
                    ApiError::Response(format!(
                        "mock HTTP request queue exhausted at {} {}",
                        request.method(),
                        request.url().path()
                    ))
                })?;
            if exchange.method != request.method().as_str() || exchange.path != request.url().path()
            {
                return Err(ApiError::Response(format!(
                    "mock HTTP request mismatch: expected {} {}, received {} {}",
                    exchange.method,
                    exchange.path,
                    request.method(),
                    request.url().path()
                )));
            }
            if let Some(expected) = exchange.request {
                let actual = request
                    .body()
                    .and_then(|body| body.as_bytes())
                    .ok_or_else(|| ApiError::Response("mock request body was missing".into()))?;
                let actual: Value = serde_json::from_slice(actual)
                    .map_err(|error| ApiError::Response(error.to_string()))?;
                if actual != expected {
                    return Err(ApiError::Response(format!(
                        "mock request JSON mismatch: expected {expected}, received {actual}"
                    )));
                }
            }
            return Ok(HttpResponse {
                status: exchange.status,
                body: exchange.response,
            });
        }
        let response = request
            .send()
            .map_err(|e| ApiError::Transport(e.to_string()))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .map_err(|e| ApiError::Transport(e.to_string()))?
            .to_vec();
        Ok(HttpResponse { status, body })
    }

    fn get_json<T: DeserializeOwned>(&self, url: &Url, authorized: bool) -> Result<T, ApiError> {
        let response = self.send(self.http.get(url.clone()), authorized)?;
        ensure_success(&response)?;
        serde_json::from_slice(&response.body).map_err(|e| ApiError::Response(e.to_string()))
    }

    fn post_json<T: Serialize, R: DeserializeOwned>(
        &self,
        url: &Url,
        body: &T,
        authorized: bool,
    ) -> Result<R, ApiError> {
        let response = self.send(
            self.http
                .post(url.clone())
                .header(CONTENT_TYPE, "application/json")
                .json(body),
            authorized,
        )?;
        ensure_success(&response)?;
        serde_json::from_slice(&response.body).map_err(|e| ApiError::Response(e.to_string()))
    }

    fn post_json_no_body<R: DeserializeOwned>(
        &self,
        url: &Url,
        authorized: bool,
    ) -> Result<R, ApiError> {
        let response = self.send(
            self.http
                .post(url.clone())
                .header(CONTENT_TYPE, "application/json"),
            authorized,
        )?;
        ensure_success(&response)?;
        serde_json::from_slice(&response.body).map_err(|e| ApiError::Response(e.to_string()))
    }
}

fn ensure_success(response: &HttpResponse) -> Result<(), ApiError> {
    if (200..300).contains(&response.status) {
        return Ok(());
    }
    let message = serde_json::from_slice::<Value>(&response.body)
        .ok()
        .and_then(|value| value.get("error").cloned().or(Some(value)))
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| error.as_str().map(ToOwned::to_owned))
        })
        .unwrap_or_else(|| {
            String::from_utf8_lossy(&response.body)
                .chars()
                .take(512)
                .collect()
        });
    Err(ApiError::Http {
        status: response.status,
        message: if message.is_empty() {
            "request failed".into()
        } else {
            message
        },
    })
}

fn is_loopback_url(url: &Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn parse_json(bytes: Vec<u8>) -> Result<Value, ApiError> {
    serde_json::from_slice(&bytes).map_err(|e| ApiError::Response(e.to_string()))
}

fn extract<T: DeserializeOwned>(value: Value, field: &str) -> Result<T, ApiError> {
    let value = value
        .get(field)
        .cloned()
        .ok_or_else(|| ApiError::Response(format!("response did not contain `{field}`")))?;
    serde_json::from_value(value).map_err(|e| ApiError::Response(e.to_string()))
}

fn extract_resolution(value: Value) -> Result<Resolution, ApiError> {
    if let Ok(resolution) = serde_json::from_value::<Resolution>(value.clone()) {
        return Ok(resolution);
    }
    extract(value, "resolution")
}

fn parse_install_authorization(value: Value) -> Result<InstallAuthorization, ApiError> {
    let mut authorization =
        if let Ok(authorization) = serde_json::from_value::<InstallAuthorization>(value.clone()) {
            authorization
        } else {
            extract(value.clone(), "authorization")?
        };
    // The server keeps the receipt ticket additive to the historical
    // `{authorization: ...}` wrapper. Preserve it for callers while still
    // accepting older registries that omit it.
    if authorization.receipt.is_none() {
        if let Some(receipt) = value.get("receipt") {
            authorization.receipt = Some(
                serde_json::from_value(receipt.clone())
                    .map_err(|error| ApiError::Response(error.to_string()))?,
            );
        }
    }
    Ok(authorization)
}

fn extract_operation_id(value: &Value) -> Result<String, ApiError> {
    if let Some(id) = value
        .get("operationId")
        .and_then(Value::as_str)
        .or_else(|| value.get("id").and_then(Value::as_str))
    {
        return Ok(id.into());
    }
    if let Some(operation) = value.get("operation") {
        if let Some(id) = operation
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| operation.get("operationId").and_then(Value::as_str))
        {
            return Ok(id.into());
        }
    }
    Err(ApiError::Response(
        "202 response did not contain an operation id".into(),
    ))
}

fn operation_error_message(operation: &Value, fallback: &str) -> Option<String> {
    let error = operation.get("error").and_then(Value::as_str)?;
    if error.is_empty() {
        return None;
    }
    let sanitized: String = error
        .chars()
        .take(512)
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let sanitized = sanitized.trim();
    Some(if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized.to_string()
    })
}

enum OperationPollAction {
    Resolution(Resolution),
    Completed,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CompletedExternalOperation {
    external_id: String,
    feed_name: Option<String>,
    name: String,
    version: String,
    resource_id: String,
}

enum CompletedExternalPin {
    Import(CompletedExternalOperation),
    Rescan { resource_id: String },
}

fn completed_external_operation(
    value: &Value,
    request: &ExternalResolveRequest,
) -> Result<CompletedExternalPin, ApiError> {
    let operation = value.get("operation").unwrap_or(value);
    let Some(import) = operation.get("import") else {
        if operation.get("kind").and_then(Value::as_str) != Some("scan") {
            return Err(ApiError::OperationFailed(
                "completed external operation did not include its import identity".into(),
            ));
        }
        let resource_id = operation
            .get("resourceId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ApiError::OperationFailed(
                    "completed external operation did not include its resourceId".into(),
                )
            })?;
        return Ok(CompletedExternalPin::Rescan {
            resource_id: resource_id.into(),
        });
    };
    let external_id = import
        .get("externalId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::OperationFailed(
                "completed external operation did not include externalId".into(),
            )
        })?;
    if external_id != request.external_id {
        return Err(ApiError::OperationFailed(
            "completed external operation identity does not match the requested externalId".into(),
        ));
    }
    let feed_name = import
        .get("feedName")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if request.feed.as_deref() != feed_name.as_deref() && request.feed.is_some() {
        return Err(ApiError::OperationFailed(
            "completed external operation feed does not match the requested feed".into(),
        ));
    }
    let name = import
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::OperationFailed(
                "completed external operation did not include its server-owned name".into(),
            )
        })?;
    let version = import
        .get("version")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::OperationFailed(
                "completed external operation did not include its server-owned version".into(),
            )
        })?;
    let resource_id = operation
        .get("resourceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ApiError::OperationFailed(
                "completed external operation did not include its resourceId".into(),
            )
        })?;
    Ok(CompletedExternalPin::Import(CompletedExternalOperation {
        external_id: external_id.into(),
        feed_name,
        name: name.into(),
        version: version.into(),
        resource_id: resource_id.into(),
    }))
}

fn verify_completed_external_skill(
    skill: &SkillVersion,
    resource_id: &str,
    request: &ExternalResolveRequest,
) -> Result<(), ApiError> {
    if skill.id != resource_id || skill.name.is_empty() || skill.version.is_empty() {
        return Err(ApiError::OperationFailed(
            "completed external scan metadata did not include the expected skill identity".into(),
        ));
    }
    if skill.provenance.external_id.as_deref() != Some(request.external_id.as_str()) {
        return Err(ApiError::OperationFailed(
            "completed external scan metadata externalId does not match the requested externalId"
                .into(),
        ));
    }
    if let Some(feed_name) = request.feed.as_deref() {
        if skill.provenance.feed_name.as_deref() != Some(feed_name) {
            return Err(ApiError::OperationFailed(
                "completed external scan metadata feed does not match the requested feed".into(),
            ));
        }
    }
    Ok(())
}

fn verify_completed_external_resolution(
    resolution: &Resolution,
    operation: &CompletedExternalOperation,
    request: &ExternalResolveRequest,
) -> Result<(), ApiError> {
    if resolution.resource_id != operation.resource_id
        || resolution.name != operation.name
        || resolution.version != operation.version
    {
        return Err(ApiError::OperationFailed(
            "completed external operation resolved a different server-owned resource".into(),
        ));
    }
    let member = resolution.members.first().ok_or_else(|| {
        ApiError::OperationFailed(
            "completed external operation resolution did not include its resource member".into(),
        )
    })?;
    if member.id != operation.resource_id
        || member.provenance.external_id.as_deref() != Some(operation.external_id.as_str())
        || member.provenance.external_id.as_deref() != Some(request.external_id.as_str())
    {
        return Err(ApiError::OperationFailed(
            "completed external operation resolution provenance does not match its operation"
                .into(),
        ));
    }
    if let Some(feed_name) = operation.feed_name.as_deref() {
        if member.provenance.feed_name.as_deref() != Some(feed_name) {
            return Err(ApiError::OperationFailed(
                "completed external operation resolution feed does not match its operation".into(),
            ));
        }
    }
    Ok(())
}

fn inspect_operation(
    value: &Value,
    failure_fallback: &str,
) -> Result<OperationPollAction, ApiError> {
    let operation = value.get("operation").unwrap_or(value);
    if let Some(error) = operation_error_message(operation, failure_fallback) {
        return Err(ApiError::OperationFailed(error));
    }
    if let Ok(resolution) = serde_json::from_value::<Resolution>(value.clone()) {
        return Ok(OperationPollAction::Resolution(resolution));
    }
    if let Some(resolution) = value.get("resolution") {
        return serde_json::from_value(resolution.clone())
            .map(OperationPollAction::Resolution)
            .map_err(|error| ApiError::Response(error.to_string()));
    }
    if let Some(resolution) = operation.get("resolution") {
        return serde_json::from_value(resolution.clone())
            .map(OperationPollAction::Resolution)
            .map_err(|error| ApiError::Response(error.to_string()));
    }
    let state = operation
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(state, "failed" | "error") {
        return Err(ApiError::OperationFailed(failure_fallback.into()));
    }
    if matches!(state, "completed" | "succeeded" | "done") {
        return Ok(OperationPollAction::Completed);
    }
    Ok(OperationPollAction::Pending)
}

/// Construct a publish request and enforce the same canonical bytes the server
/// will hash.  This helper keeps callers from accidentally publishing a pretty
/// printed or otherwise non-canonical artifact.
pub fn publish_request(
    name: String,
    version: String,
    description: String,
    bundle: &SkillBundle,
) -> Result<PublishRequest, ApiError> {
    canonical_bundle_bytes(bundle).map_err(|e| ApiError::Response(e.to_string()))?;
    Ok(PublishRequest {
        name,
        version,
        description,
        bundle: bundle.clone(),
    })
}

/// Decode a transfer response after its digest has already been checked.
pub fn decode_verified_bundle(bytes: &[u8]) -> Result<SkillBundle, ApiError> {
    decode_bundle_bytes(bytes).map_err(|e| ApiError::Response(e.to_string()))
}

pub fn query_parameters(values: &[(&str, &str)]) -> BTreeMap<String, String> {
    values
        .iter()
        .map(|(key, value)| ((*key).into(), (*value).into()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_origin_does_not_loop_when_building_endpoint() {
        let client = ApiClient::new("https://registry.example/", None).expect("URL");
        assert_eq!(
            client.endpoint(&["health"]).expect("endpoint").as_str(),
            "https://registry.example/health"
        );
    }

    #[test]
    fn remote_http_requires_tls_but_loopback_is_allowed_for_development() {
        assert!(ApiClient::new("http://registry.example", None).is_err());
        assert!(ApiClient::new("http://127.0.0.1:5173", None).is_ok());
    }

    #[test]
    fn completed_operation_error_is_terminal_for_both_polling_paths() {
        let value = serde_json::json!({
            "operation": {
                "id": "op-1",
                "state": "completed",
                "error": "Required scanner cisco-skill-scanner returned scan-error"
            }
        });
        for fallback in ["operation failed", "proxy operation failed"] {
            let result = inspect_operation(&value, fallback);
            assert!(matches!(
                result,
                Err(ApiError::OperationFailed(message))
                    if message == "Required scanner cisco-skill-scanner returned scan-error"
            ));
        }
    }

    #[test]
    fn completed_operation_without_error_remains_resolvable() {
        let value = serde_json::json!({
            "operation": { "id": "op-1", "state": "completed" }
        });
        assert!(matches!(
            inspect_operation(&value, "operation failed"),
            Ok(OperationPollAction::Completed)
        ));

        let value = serde_json::json!({
            "resolution": {
                "kind": "skill",
                "resourceId": "skill-1",
                "organizationId": "org-1",
                "name": "@team/demo",
                "version": "1.0.0",
                "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "members": []
            }
        });
        assert!(matches!(
            inspect_operation(&value, "operation failed"),
            Ok(OperationPollAction::Resolution(resolution))
                if resolution.resource_id == "skill-1"
        ));
    }

    #[test]
    fn completed_external_operation_rejects_identity_mismatch() {
        let request = ExternalResolveRequest {
            feed: Some("community".into()),
            external_id: "vercel-labs/skills/find-skills".into(),
            refresh: Some(true),
        };
        let value = serde_json::json!({
            "operation": {
                "id": "op-1",
                "state": "completed",
                "resourceId": "skill-1",
                "import": {
                    "externalId": "other/skills/item",
                    "feedName": "community",
                    "name": "@community/skills-sh-1",
                    "version": "0.0.0+skills-sh.1"
                }
            }
        });
        assert!(matches!(
            completed_external_operation(&value, &request),
            Err(ApiError::OperationFailed(message))
                if message.contains("identity does not match")
        ));
    }

    #[test]
    fn completed_import_without_import_identity_remains_rejected() {
        let request = ExternalResolveRequest {
            feed: None,
            external_id: "vercel-labs/skills/find-skills".into(),
            refresh: Some(false),
        };
        let value = serde_json::json!({
            "operation": {
                "id": "op-import-1",
                "kind": "import",
                "state": "completed",
                "resourceId": "skill-1"
            }
        });
        assert!(matches!(
            completed_external_operation(&value, &request),
            Err(ApiError::OperationFailed(message))
                if message.contains("did not include its import identity")
        ));
    }

    #[test]
    fn external_refresh_pins_completed_operation_without_reposting_proxy() {
        let external_id = "vercel-labs/skills/find-skills";
        let feed = "community";
        let private_name = "@community/skills-sh-1";
        let version = "0.0.0+skills-sh.1";
        let resource_id = "skill-1";
        let resolution = serde_json::json!({
            "kind": "skill",
            "resourceId": resource_id,
            "organizationId": "org-1",
            "name": private_name,
            "version": version,
            "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "members": [{
                "id": resource_id,
                "organizationId": "org-1",
                "name": private_name,
                "skillName": "find-skills",
                "version": version,
                "description": "",
                "artifact": {
                    "key": "blob-1",
                    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "size": 1
                },
                "state": "approved",
                "policyRevision": "policy-1",
                "createdAt": "2026-01-01T00:00:00Z",
                "provenance": {
                    "kind": "skills-sh",
                    "externalId": external_id,
                    "feedName": feed,
                    "sourceReference": "@github/vercel-labs/skills/skills/find-skills"
                },
                "fileCount": 1,
                "scanIds": []
            }]
        });
        let operation = serde_json::json!({
            "operation": {
                "id": "op-1",
                "state": "completed",
                "resourceId": resource_id,
                "import": {
                    "externalId": external_id,
                    "feedName": feed,
                    "name": private_name,
                    "version": version
                }
            }
        });
        let client = ApiClient::with_mock_exchanges(
            "https://registry.example",
            vec![
                mock_exchange(
                    "POST",
                    "/v1/proxy/resolve",
                    Some(serde_json::json!({
                        "feed": feed,
                        "externalId": external_id,
                        "refresh": true
                    })),
                    202,
                    serde_json::json!({ "operation": { "id": "op-1" } }),
                ),
                mock_exchange("GET", "/v1/operations/op-1", None, 200, operation),
                mock_exchange(
                    "POST",
                    "/v1/resolve",
                    Some(serde_json::json!({
                        "kind": "skill",
                        "ref": private_name,
                        "version": version
                    })),
                    200,
                    serde_json::json!({ "resolution": resolution }),
                ),
            ],
        )
        .expect("mock client");
        let request = ExternalResolveRequest {
            feed: Some(feed.into()),
            external_id: external_id.into(),
            refresh: Some(true),
        };
        let result = client
            .resolve_external_until(&request, std::time::Instant::now() + Duration::from_secs(5))
            .expect("pinned external resolution");
        assert_eq!(result.resolution.name, private_name);
        assert_eq!(result.resolution.version, version);
        assert_eq!(
            result.reference.as_deref(),
            Some("@github/vercel-labs/skills/skills/find-skills")
        );
    }

    #[test]
    fn external_rescan_pins_completed_skill_without_reposting_proxy() {
        let external_id = "vercel-labs/skills/find-skills";
        let feed = "community";
        let private_name = "@community/skills-sh-1";
        let version = "0.0.0+skills-sh.1";
        let resource_id = "skill-1";
        let resolution = serde_json::json!({
            "kind": "skill",
            "resourceId": resource_id,
            "organizationId": "org-1",
            "name": private_name,
            "version": version,
            "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "members": [{
                "id": resource_id,
                "organizationId": "org-1",
                "name": private_name,
                "skillName": "find-skills",
                "version": version,
                "description": "",
                "artifact": {
                    "key": "blob-1",
                    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "size": 1
                },
                "state": "approved",
                "policyRevision": "policy-1",
                "createdAt": "2026-01-01T00:00:00Z",
                "provenance": {
                    "kind": "skills-sh",
                    "externalId": external_id,
                    "feedName": feed,
                    "sourceReference": "@github/vercel-labs/skills/skills/find-skills"
                },
                "fileCount": 1,
                "scanIds": []
            }]
        });
        let operation = serde_json::json!({
            "operation": {
                "id": "op-rescan-1",
                "kind": "scan",
                "state": "completed",
                "resourceId": resource_id
            }
        });
        let client = ApiClient::with_mock_exchanges(
            "https://registry.example",
            vec![
                mock_exchange(
                    "POST",
                    "/v1/proxy/resolve",
                    Some(serde_json::json!({
                        "feed": feed,
                        "externalId": external_id,
                        "refresh": true
                    })),
                    202,
                    serde_json::json!({ "operation": { "id": "op-rescan-1" } }),
                ),
                mock_exchange("GET", "/v1/operations/op-rescan-1", None, 200, operation),
                mock_exchange(
                    "GET",
                    "/v1/skills/skill-1",
                    None,
                    200,
                    serde_json::json!({ "skill": resolution["members"][0].clone() }),
                ),
                mock_exchange(
                    "POST",
                    "/v1/resolve",
                    Some(serde_json::json!({
                        "kind": "skill",
                        "ref": private_name,
                        "version": version
                    })),
                    200,
                    serde_json::json!({ "resolution": resolution }),
                ),
            ],
        )
        .expect("mock client");
        let request = ExternalResolveRequest {
            feed: Some(feed.into()),
            external_id: external_id.into(),
            refresh: Some(true),
        };
        let result = client
            .resolve_external_until(&request, std::time::Instant::now() + Duration::from_secs(5))
            .expect("pinned rescan resolution");
        assert_eq!(result.resolution.name, private_name);
        assert_eq!(result.resolution.version, version);
        assert_eq!(
            result.reference.as_deref(),
            Some("@github/vercel-labs/skills/skills/find-skills")
        );
    }

    #[test]
    fn completed_rescan_skill_rejects_metadata_identity_mismatch() {
        let skill: SkillVersion = serde_json::from_value(serde_json::json!({
            "id": "skill-1",
            "name": "@community/skills-sh-1",
            "version": "0.0.0+skills-sh.1",
            "artifact": {
                "key": "blob-1",
                "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "size": 1
            },
            "state": "approved",
            "provenance": {
                "kind": "skills-sh",
                "externalId": "other/skills/item",
                "feedName": "community"
            }
        }))
        .expect("skill metadata");
        let request = ExternalResolveRequest {
            feed: Some("community".into()),
            external_id: "vercel-labs/skills/find-skills".into(),
            refresh: Some(true),
        };
        assert!(matches!(
            verify_completed_external_skill(&skill, "skill-1", &request),
            Err(ApiError::OperationFailed(message))
                if message.contains("externalId does not match")
        ));
    }

    fn mock_exchange(
        method: &str,
        path: &str,
        request: Option<Value>,
        status: u16,
        response: Value,
    ) -> MockExchange {
        MockExchange {
            method: method.into(),
            path: path.into(),
            request,
            status,
            response: serde_json::to_vec(&response).expect("mock response JSON"),
        }
    }

    #[test]
    fn directory_list_uses_registry_route_and_query_contract() {
        let client = ApiClient::new("https://registry.example", None).expect("client");
        let url = client
            .directory_url(
                "skills",
                &[
                    ("view", "trending".into()),
                    ("page", "3".into()),
                    ("per_page", "25".into()),
                ],
            )
            .expect("directory URL");
        assert_eq!(
            url.as_str(),
            "https://registry.example/v1/directory/skills?view=trending&page=3&per_page=25"
        );
    }

    #[test]
    fn directory_import_serializes_private_import_contract() {
        let value = serde_json::to_value(DirectoryImportRequest {
            id: "owner/repo/skill".into(),
            name: "@team/demo".into(),
            version: "1.2.3".into(),
            upstream_id: Some("skills-sh".into()),
        })
        .expect("import JSON");
        assert_eq!(
            value,
            serde_json::json!({
                "id": "owner/repo/skill",
                "name": "@team/demo",
                "version": "1.2.3",
                "upstreamId": "skills-sh"
            })
        );
    }

    #[test]
    fn external_resolve_serializes_only_registry_owned_identity_fields() {
        let value = serde_json::to_value(ExternalResolveRequest {
            feed: Some("community".into()),
            external_id: "vercel-labs/skills/find-skills".into(),
            refresh: Some(true),
        })
        .expect("external resolve JSON");
        assert_eq!(
            value,
            serde_json::json!({
                "feed": "community",
                "externalId": "vercel-labs/skills/find-skills",
                "refresh": true
            })
        );
        assert!(value.get("name").is_none());
        assert!(value.get("version").is_none());
        assert!(value.get("upstreamId").is_none());
        let cached = serde_json::to_value(ExternalResolveRequest {
            feed: None,
            external_id: "vercel-labs/skills/find-skills".into(),
            refresh: None,
        })
        .expect("cached external resolve JSON");
        assert_eq!(
            cached,
            serde_json::json!({ "externalId": "vercel-labs/skills/find-skills" })
        );
    }

    #[test]
    fn receipt_request_uses_contract_field_names() {
        let request = InstallReceiptRequest {
            authorization_id: "auth-1".into(),
            changed: false,
            agent: "codex".into(),
            platform: "macos".into(),
            client_version: "0.1.3".into(),
        };
        let value = serde_json::to_value(request).expect("receipt JSON");
        assert_eq!(value["authorizationId"], "auth-1");
        assert_eq!(value["changed"], false);
        assert_eq!(value["clientVersion"], "0.1.3");
        assert!(value.get("authorization_id").is_none());
    }

    #[test]
    fn external_directory_provenance_is_preserved_in_lock_serialization() {
        let provenance = Provenance {
            kind: "skills-sh".into(),
            upstream_id: Some("skills-sh".into()),
            repository: Some("https://skills.sh".into()),
            path: Some("vercel-labs/skills/find-skills".into()),
            revision: Some("sha256:source".into()),
            source_digest: Some("sha256:bundle".into()),
            external_id: Some("vercel-labs/skills/find-skills".into()),
            external_source_type: Some("github".into()),
            external_snapshot_hash: Some("snapshot-1".into()),
            feed_id: Some("feed-1".into()),
            feed_name: Some("community".into()),
            feed_config_revision: Some("feed-config-1".into()),
            source_reference: Some("@github/vercel-labs/skills/skills/find-skills".into()),
            source_provider_origin: Some("https://registry.example".into()),
            source_resolution_kind: Some("github".into()),
            well_known_entry_name: Some("find-skills".into()),
            external_digest: Some("sha256:external".into()),
            source_url: Some("https://github.com/vercel-labs/skills".into()),
            page_url: Some("https://skills.sh/vercel-labs/skills/find-skills".into()),
            artifact_url: Some("https://github.com/vercel-labs/skills/archive/main.zip".into()),
            skill_path: Some("skills/find-skills".into()),
            requested_ref: Some("main".into()),
            resolved_commit: Some("0123456789012345678901234567890123456789".into()),
            resolved_tree: Some("abcdefabcdefabcdefabcdefabcdefabcdefabcd".into()),
            well_known_index_url: Some(
                "https://example.test/.well-known/agent-skills/index.json".into(),
            ),
            frontmatter_name: Some("Find Skills".into()),
            frontmatter_description: Some("Find available skills".into()),
            external: Some(ExternalProvenance {
                provider: "skills.sh".into(),
                external_id: "vercel-labs/skills/find-skills".into(),
                source: "vercel-labs/skills".into(),
                slug: "find-skills".into(),
                source_type: "github".into(),
                source_url: "https://github.com/vercel-labs/skills".into(),
                page_url: Some("https://skills.sh/vercel-labs/skills/find-skills".into()),
                external_snapshot_hash: Some("snapshot-1".into()),
                external_digest: Some("sha256:external".into()),
                repository: Some("vercel-labs/skills".into()),
                skill_path: Some("skills/find-skills".into()),
                requested_ref: Some("main".into()),
                resolved_commit: Some("0123456789012345678901234567890123456789".into()),
                resolved_tree: Some("abcdefabcdefabcdefabcdefabcdefabcdefabcd".into()),
                well_known_index_url: Some(
                    "https://example.test/.well-known/agent-skills/index.json".into(),
                ),
                artifact_url: Some("https://github.com/vercel-labs/skills/archive/main.zip".into()),
                frontmatter_name: Some("Find Skills".into()),
                frontmatter_description: Some("Find available skills".into()),
            }),
        };
        let lock = LockSkill {
            key: "skills-sh/@team/find-skills@1.0.0".into(),
            registry: "https://registry.example".into(),
            reference: "@team/find-skills".into(),
            version: "1.0.0".into(),
            skill_name: "find-skills".into(),
            artifact_digest: "sha256:bundle".into(),
            tree_digest: "sha256:tree".into(),
            owners: vec!["direct".into()],
            provenance,
        };
        let value = serde_json::to_value(lock).expect("lock JSON");
        assert_eq!(
            value["provenance"]["externalId"],
            "vercel-labs/skills/find-skills"
        );
        assert_eq!(value["provenance"]["externalSourceType"], "github");
        assert_eq!(value["provenance"]["externalSnapshotHash"], "snapshot-1");
        assert_eq!(value["provenance"]["feedId"], "feed-1");
        assert_eq!(value["provenance"]["feedName"], "community");
        assert_eq!(
            value["provenance"]["sourceReference"],
            "@github/vercel-labs/skills/skills/find-skills"
        );
        assert_eq!(
            value["provenance"]["sourceProviderOrigin"],
            "https://registry.example"
        );
        assert_eq!(value["provenance"]["sourceResolutionKind"], "github");
        assert_eq!(value["provenance"]["wellKnownEntryName"], "find-skills");
        assert_eq!(value["provenance"]["externalDigest"], "sha256:external");
        assert_eq!(
            value["provenance"]["resolvedCommit"],
            "0123456789012345678901234567890123456789"
        );
        assert_eq!(
            value["provenance"]["external"]["frontmatterName"],
            "Find Skills"
        );
        assert!(value["provenance"].get("external_id").is_none());

        let legacy: Provenance = serde_json::from_value(serde_json::json!({
            "kind": "native"
        }))
        .expect("legacy provenance");
        assert_eq!(legacy.external_id, None);
        assert_eq!(legacy.external_source_type, None);
        assert_eq!(legacy.external_snapshot_hash, None);
        assert_eq!(legacy.feed_name, None);
        assert_eq!(legacy.source_reference, None);
        assert_eq!(legacy.source_provider_origin, None);
        assert_eq!(legacy.source_resolution_kind, None);
        assert_eq!(legacy.well_known_entry_name, None);
    }

    #[test]
    fn additive_receipt_ticket_is_preserved_from_authorization_wrapper() {
        let value = serde_json::json!({
            "authorization": {
                "id": "auth-1",
                "subject": "user-1",
                "resolution": {
                    "kind": "skill",
                    "resourceId": "skill-1",
                    "name": "@team/demo",
                    "version": "1.0.0",
                    "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "members": []
                },
                "expiresAt": "2099-01-01T00:00:00Z"
            },
            "receipt": {
                "id": "ticket-1",
                "authorizationId": "auth-1",
                "expiresAt": "2099-01-02T00:00:00Z"
            }
        });
        let authorization = parse_install_authorization(value).expect("authorization");
        assert_eq!(
            authorization
                .receipt
                .as_ref()
                .map(|receipt| receipt.id.as_str()),
            Some("ticket-1")
        );
    }
}
