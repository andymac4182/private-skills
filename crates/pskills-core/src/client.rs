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
        })
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

    pub fn search(&self, query: &str) -> Result<Vec<SkillVersion>, ApiError> {
        let mut url = self.endpoint(&["v1", "skills"])?;
        url.query_pairs_mut().append_pair("q", query);
        let value: Value = self.get_json(&url, true)?;
        if let Ok(response) = serde_json::from_value::<SearchResponse>(value.clone()) {
            return Ok(response.skills);
        }
        extract(value, "skills")
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
            if let Ok(resolution) = serde_json::from_value::<Resolution>(value.clone()) {
                return Ok(resolution);
            }
            if let Some(resolution) = value.get("resolution") {
                return serde_json::from_value(resolution.clone())
                    .map_err(|e| ApiError::Response(e.to_string()));
            }
            let operation = value.get("operation").unwrap_or(&value);
            if let Some(resolution) = operation.get("resolution") {
                return serde_json::from_value(resolution.clone())
                    .map_err(|e| ApiError::Response(e.to_string()));
            }
            let state = operation
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(state, "failed" | "error") {
                return Err(ApiError::OperationFailed(
                    operation
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("operation failed")
                        .into(),
                ));
            }
            if matches!(state, "completed" | "succeeded" | "done") {
                // The registry operation only records that its scan/import
                // finished.  The immutable resolution is obtained by
                // repeating the fenced resolve request after completion.
                return self.resolve_until(request, deadline);
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
            if let Ok(resolution) = extract_resolution(value.clone()) {
                return Ok(resolution);
            }
            let operation = value.get("operation").unwrap_or(&value);
            if let Some(resolution) = operation.get("resolution") {
                return serde_json::from_value(resolution.clone())
                    .map_err(|e| ApiError::Response(e.to_string()));
            }
            let state = operation
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(state, "failed" | "error") {
                return Err(ApiError::OperationFailed(
                    operation
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("proxy operation failed")
                        .into(),
                ));
            }
            if matches!(state, "completed" | "succeeded" | "done") {
                return self.proxy_resolve_until(request, deadline);
            }
            if std::time::Instant::now() >= deadline {
                return Err(ApiError::OperationTimeout(operation_id.into()));
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            std::thread::sleep(remaining.min(Duration::from_millis(250)));
        }
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
