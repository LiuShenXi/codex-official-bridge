//! Internal official-source runtime extension, pinned to Codex b5bffd3e.
//!
//! The public Node gateway owns client authentication. This process binds only
//! 127.0.0.1, authenticates its internal caller with a random control-file
//! capability, and fixes the upstream to the official ChatGPT Codex provider.
//! Only the official AuthManager loads and refreshes the dedicated CODEX_HOME
//! login. No endpoint exposes credentials or accepts an upstream URL/token.
//!
//! Raw request bytes and raw response streams never enter an Agent turn or a
//! typed Responses parser. Tool declarations, opaque reasoning, unknown events,
//! and compaction therefore remain the desktop client's responsibility.

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddrV4};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::response::Response;
use axum::routing::{get, post};
use bytes::Bytes;
use codex_api::{Provider, SharedAuthProvider};
use codex_http_client::{ClientRouteClass, HttpClient, HttpClientFactory, OutboundProxyPolicy};
use codex_login::default_client;
use codex_login::{
    AuthCredentialsStoreMode, AuthKeyringBackendKind, AuthManager, AuthRouteConfig, CodexAuth,
};
use codex_model_provider::{auth_provider_from_auth_manager, create_model_provider};
use codex_model_provider_info::{CHATGPT_CODEX_BASE_URL, ModelProviderInfo};
use codex_websocket_client::WebSocketConnector;
use http::{HeaderMap, HeaderName, Method, StatusCode};
use rand::RngCore;

mod websocket;

const INTERNAL_TOKEN_HEADER: &str = "x-codex-runtime-token";
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
const EGRESS_CHECK_URL: &str = "https://api.ipify.org";

struct Runtime {
    manager: Arc<AuthManager>,
    auth: SharedAuthProvider,
    provider: Provider,
    client: HttpClient,
    websocket: WebSocketConnector,
    capability: String,
}

#[tokio::main]
async fn main() {
    // Do not install a tracing subscriber: upstream TRACE can contain request
    // bodies. All diagnostics from this executable are fixed, non-secret codes.
    if let Err(code) = run().await {
        eprintln!("native_runtime_error:{code}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), &'static str> {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--check-egress")) {
        if std::env::args_os().count() != 2 {
            return Err("unexpected_argument");
        }
        // This diagnostic exits before reading CODEX_HOME, creating the auth
        // manager, or loading any provider/default account headers.
        return check_egress().await;
    }
    let control_file = parse_control_file()?;
    reject_auth_environment_overrides()?;
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("absolute_codex_home_required")?;

    let factory = HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault);
    let auth_route = AuthRouteConfig::from_http_client_factory(factory.clone());
    let manager = AuthManager::shared(
        codex_home,
        false,
        AuthCredentialsStoreMode::File,
        None,
        None,
        AuthKeyringBackendKind::default(),
        auth_route,
    )
    .await;
    let snapshot = manager.auth().await.ok_or("official_login_required")?;
    if !matches!(&snapshot, CodexAuth::Chatgpt(_)) {
        return Err("managed_chatgpt_login_required");
    }
    let auth = auth_provider_from_auth_manager(manager.clone(), &snapshot);
    let mut provider_info =
        ModelProviderInfo::create_openai_provider(Some(CHATGPT_CODEX_BASE_URL.to_owned()));
    // Neither caller headers nor ambient organization/project environment
    // settings may replace the identity selected by the managed login.
    provider_info.env_http_headers = None;
    let model_provider = create_model_provider(provider_info, Some(manager.clone()));
    let provider = model_provider
        .api_provider()
        .await
        .map_err(|_| "official_provider_unavailable")?;
    if provider.base_url != CHATGPT_CODEX_BASE_URL {
        return Err("unexpected_official_provider_url");
    }

    // Use the official proxy/CA factory and default headers. Disable redirects
    // and automatic decompression so all upstream status codes and body bytes
    // can be returned without parsing, rewriting, or hidden follow-up requests.
    let builder = raw_http_builder().default_headers(default_client::default_headers());
    let http = factory
        .build_reqwest_client(builder, CHATGPT_CODEX_BASE_URL, ClientRouteClass::Api)
        .map_err(|_| "official_http_client_unavailable")?;
    let client = HttpClient::new_without_request_logging(http);
    let websocket = WebSocketConnector::new(&factory)
        .map_err(|_| "official_websocket_client_unavailable")?;

    let mut random = [0_u8; 32];
    rand::rng().fill_bytes(&mut random);
    let capability: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let listener = tokio::net::TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "loopback_bind_failed")?;
    let port = listener
        .local_addr()
        .map_err(|_| "loopback_address_unavailable")?
        .port();
    let state = Arc::new(Runtime {
        manager,
        auth,
        provider,
        client,
        websocket,
        capability,
    });
    let app = Router::new()
        .route("/v1/responses", post(forward_responses).get(websocket::forward_websocket))
        .route("/v1/responses/compact", post(forward_compact))
        .route("/v1/images/generations", post(forward_images))
        .route("/v1/models", get(forward_models))
        .with_state(state.clone());

    write_control_file(&control_file, port, &state.capability)?;
    eprintln!("native_runtime_ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|_| "loopback_server_failed")
}

fn raw_http_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(30))
}

async fn check_egress() -> Result<(), &'static str> {
    let factory = HttpClientFactory::new(OutboundProxyPolicy::ReqwestDefault);
    let http = factory
        .build_reqwest_client(
            raw_http_builder().timeout(Duration::from_secs(30)),
            EGRESS_CHECK_URL,
            ClientRouteClass::Api,
        )
        .map_err(|_| "egress_http_client_unavailable")?;
    let client = HttpClient::new_without_request_logging(http);
    let response = client
        .request(Method::GET, EGRESS_CHECK_URL)
        .send()
        .await
        .map_err(|_| "egress_transport_failed")?;
    if !response.status().is_success() {
        return Err("egress_http_failed");
    }
    let body = to_bytes(Body::from_stream(response.bytes_stream()), 128)
        .await
        .map_err(|_| "egress_body_invalid")?;
    let address: IpAddr = std::str::from_utf8(&body)
        .map_err(|_| "egress_address_invalid")?
        .trim()
        .parse()
        .map_err(|_| "egress_address_invalid")?;
    println!("{address}");
    Ok(())
}

fn parse_control_file() -> Result<PathBuf, &'static str> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--control-file")) {
        return Err("control_file_flag_required");
    }
    let path = args
        .next()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("absolute_control_file_required")?;
    if args.next().is_some() {
        return Err("unexpected_argument");
    }
    Ok(path)
}

fn reject_auth_environment_overrides() -> Result<(), &'static str> {
    // Fail closed instead of mutating process-wide environment after Tokio
    // worker threads exist. The Node launcher must omit these ambient inputs.
    for name in [
        "CODEX_REFRESH_TOKEN_URL_OVERRIDE",
        "CODEX_REVOKE_TOKEN_URL_OVERRIDE",
        "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
        "CODEX_ACCESS_TOKEN",
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
    ] {
        if std::env::var_os(name).is_some() {
            return Err("auth_environment_override_not_allowed");
        }
    }
    Ok(())
}

fn write_control_file(path: &Path, port: u16, token: &str) -> Result<(), &'static str> {
    let temporary = path.with_extension(format!("tmp-{}-{}", std::process::id(), &token[..16]));
    let data = serde_json::to_vec(&serde_json::json!({ "port": port, "token": token }))
        .map_err(|_| "control_encode_failed")?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| "control_create_failed")?;
        file.write_all(&data).map_err(|_| "control_write_failed")?;
        file.sync_all().map_err(|_| "control_sync_failed")?;
        std::fs::rename(&temporary, path).map_err(|_| "control_publish_failed")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

async fn forward_responses(State(state): State<Arc<Runtime>>, request: Request) -> Response {
    forward(state, request, Method::POST, "/responses", false).await
}

async fn forward_compact(State(state): State<Arc<Runtime>>, request: Request) -> Response {
    forward(state, request, Method::POST, "/responses/compact", false).await
}

async fn forward_images(State(state): State<Arc<Runtime>>, request: Request) -> Response {
    // The desktop's official image request already contains its native JSON
    // envelope. Retain every byte and stream the official response unchanged.
    forward(state, request, Method::POST, "/images/generations", false).await
}

async fn forward_models(State(state): State<Arc<Runtime>>, request: Request) -> Response {
    forward(state, request, Method::GET, "/models", true).await
}

async fn forward(
    state: Arc<Runtime>,
    request: Request,
    method: Method,
    path: &'static str,
    allow_query: bool,
) -> Response {
    let tokens: Vec<_> = request.headers().get_all(INTERNAL_TOKEN_HEADER).iter().collect();
    if tokens.len() != 1 || !same_capability(tokens[0].as_bytes(), state.capability.as_bytes()) {
        return local_error(StatusCode::UNAUTHORIZED, "internal_auth_required");
    }
    if (!allow_query && request.uri().query().is_some())
        || request.headers().contains_key(http::header::AUTHORIZATION)
        || request.headers().contains_key(http::header::PROXY_AUTHORIZATION)
    {
        return local_error(StatusCode::BAD_REQUEST, "external_auth_or_query_not_allowed");
    }
    // The route is fixed by our handler. A models query remains a query on
    // that route and cannot select a different host, scheme, or path.
    let path = match request.uri().query() {
        Some(query) => format!("{path}?{query}"),
        None => path.to_owned(),
    };
    let headers = request_headers(request.headers());
    let body = match to_bytes(request.into_body(), MAX_BODY_BYTES).await {
        Ok(body) => body,
        Err(_) => return local_error(StatusCode::PAYLOAD_TOO_LARGE, "body_unavailable_or_too_large"),
    };
    send_upstream(state, method, path, headers, body).await
}

async fn send_upstream(
    state: Arc<Runtime>,
    method: Method,
    path: String,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut recovery = state.manager.unauthorized_recovery();
    loop {
        let mut request = state.provider.build_request(method.clone(), &path).with_raw_body(body.clone());
        request.headers.extend(headers.clone());
        let request = match state.auth.apply_auth(request).await {
            Ok(request) => request,
            Err(_) => return local_error(StatusCode::BAD_GATEWAY, "official_auth_unavailable"),
        };
        let prepared = match request.prepare_body_for_send() {
            Ok(prepared) => prepared,
            Err(_) => return local_error(StatusCode::BAD_GATEWAY, "official_request_unavailable"),
        };
        let bytes = prepared.body_bytes();
        let response = match state.client
            .request(request.method, request.url)
            .headers(prepared.headers)
            .body(bytes)
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => return local_error(StatusCode::BAD_GATEWAY, "official_transport_unavailable"),
        };
        // Only explicit pre-stream 401 responses can trigger the official
        // bounded reload/refresh sequence. Never retry a successful SSE stream,
        // a connection ambiguity, 429, or tool-related model output.
        if response.status() == StatusCode::UNAUTHORIZED && recovery.has_next() {
            match recovery.next().await {
                Ok(_) => continue,
                Err(_) => eprintln!("native_runtime_auth_recovery_failed"),
            }
        }
        let status = response.status();
        let headers = response_headers(response.headers());
        let mut output = Response::new(Body::from_stream(response.bytes_stream()));
        *output.status_mut() = status;
        *output.headers_mut() = headers;
        return output;
    }
}

fn same_capability(actual: &[u8], expected: &[u8]) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    actual.iter().zip(expected).fold(0_u8, |diff, (a, b)| diff | (a ^ b)) == 0
}

fn connection_headers(headers: &HeaderMap) -> HashSet<HeaderName> {
    headers.get_all(http::header::CONNECTION).iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|name| HeaderName::from_bytes(name.trim().as_bytes()).ok())
        .collect()
}

fn hop_by_hop(name: &str) -> bool {
    matches!(name, "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
        | "te" | "trailer" | "transfer-encoding" | "upgrade")
}

fn identity_header(name: &str) -> bool {
    matches!(name, "authorization" | "cookie" | "x-api-key" | "api-key"
        | "chatgpt-account-id" | "chatgpt-user-id" | "openai-organization" | "openai-project"
        | "x-openai-actor-authorization" | "x-openai-fedramp")
}

fn request_headers(incoming: &HeaderMap) -> HeaderMap {
    let connection = connection_headers(incoming);
    let mut headers = HeaderMap::new();
    for (name, value) in incoming {
        if !hop_by_hop(name.as_str()) && !connection.contains(name)
            && !identity_header(name.as_str())
            && !matches!(name.as_str(), INTERNAL_TOKEN_HEADER | "host" | "content-length")
        {
            headers.append(name.clone(), value.clone());
        }
    }
    headers
}

fn response_headers(upstream: &HeaderMap) -> HeaderMap {
    let connection = connection_headers(upstream);
    let mut headers = HeaderMap::new();
    for (name, value) in upstream {
        // Upstream cookies belong to the runtime, never to the desktop gateway.
        if !hop_by_hop(name.as_str()) && !connection.contains(name)
            && !matches!(name.as_str(), "set-cookie" | "authorization" | "proxy-authorization")
        {
            headers.append(name.clone(), value.clone());
        }
    }
    headers
}

fn local_error(status: StatusCode, code: &'static str) -> Response {
    let mut response = Response::new(Body::from(format!("{{\"error\":{{\"code\":\"{code}\"}}}}")));
    *response.status_mut() = status;
    response.headers_mut().insert(http::header::CONTENT_TYPE, http::HeaderValue::from_static("application/json"));
    response
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        if let Ok(mut terminate) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    #[test]
    fn request_keeps_client_protocol_metadata_but_not_credentials() {
        let mut input = HeaderMap::new();
        for (name, value) in [
            ("content-encoding", "zstd"),
            ("version", "0.154.0-alpha.6.2"),
            ("session-id", "test-session"),
            ("thread-id", "test-thread"),
            ("x-codex-turn-state", "opaque-test-state"),
            ("authorization", "Bearer not-a-real-token"),
            ("chatgpt-account-id", "caller-cannot-select-account"),
            ("openai-project", "caller-cannot-select-project"),
            ("x-openai-actor-authorization", "caller-cannot-select-actor"),
            ("x-openai-fedramp", "caller-cannot-select-account-route"),
            (INTERNAL_TOKEN_HEADER, "internal-only"),
            ("cookie", "client-cookie"),
            ("connection", "x-hop-local"),
            ("x-hop-local", "connection-specific"),
        ] {
            input.insert(HeaderName::from_static(name), HeaderValue::from_static(value));
        }
        let forwarded = request_headers(&input);
        assert_eq!(forwarded["content-encoding"], "zstd");
        assert_eq!(forwarded["version"], "0.154.0-alpha.6.2");
        assert_eq!(forwarded["session-id"], "test-session");
        assert_eq!(forwarded["thread-id"], "test-thread");
        assert_eq!(forwarded["x-codex-turn-state"], "opaque-test-state");
        for name in ["authorization", "chatgpt-account-id", "openai-project", "x-openai-actor-authorization", "x-openai-fedramp", INTERNAL_TOKEN_HEADER,
            "cookie", "connection", "x-hop-local"] {
            assert!(!forwarded.contains_key(name));
        }
    }

    #[test]
    fn response_keeps_retry_and_stream_metadata_but_not_cookies() {
        let mut input = HeaderMap::new();
        input.insert("retry-after", HeaderValue::from_static("7"));
        input.insert("x-codex-turn-state", HeaderValue::from_static("opaque"));
        input.insert("content-encoding", HeaderValue::from_static("gzip"));
        input.insert("content-length", HeaderValue::from_static("123"));
        input.insert("set-cookie", HeaderValue::from_static("server-cookie"));
        let forwarded = response_headers(&input);
        assert_eq!(forwarded["retry-after"], "7");
        assert_eq!(forwarded["x-codex-turn-state"], "opaque");
        assert_eq!(forwarded["content-encoding"], "gzip");
        assert_eq!(forwarded["content-length"], "123");
        assert!(!forwarded.contains_key("set-cookie"));
    }

    #[test]
    fn capability_requires_the_complete_secret() {
        assert!(same_capability(b"test-secret", b"test-secret"));
        assert!(!same_capability(b"test-secreu", b"test-secret"));
        assert!(!same_capability(b"test", b"test-secret"));
    }
}
