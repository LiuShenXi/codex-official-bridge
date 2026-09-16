//! A Responses WebSocket is one persistent upstream session. Messages are
//! relayed without parsing JSON: warmup, previous_response_id, response.cancel,
//! future fields, binary messages and metadata all remain client/server owned.
//! Compression and ping/pong are hop-local; both legs use RFC6455 libraries.

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::response::{IntoResponse, Response};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use http::{HeaderMap, HeaderValue, Method, StatusCode};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::extensions::compression::deflate::DeflateConfig;
use tokio_tungstenite::tungstenite::extensions::ExtensionsConfig;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message as UpstreamMessage};

use crate::{INTERNAL_TOKEN_HEADER, Runtime, default_client, local_error, request_headers,
    response_headers, same_capability};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) async fn forward_websocket(
    State(state): State<Arc<Runtime>>,
    request: Request,
) -> Response {
    let tokens: Vec<_> = request.headers().get_all(INTERNAL_TOKEN_HEADER).iter().collect();
    if tokens.len() != 1 || !same_capability(tokens[0].as_bytes(), state.capability.as_bytes()) {
        return local_error(StatusCode::UNAUTHORIZED, "internal_auth_required");
    }
    if request.uri().query().is_some()
        || request.headers().contains_key(http::header::AUTHORIZATION)
        || request.headers().contains_key(http::header::PROXY_AUTHORIZATION)
    {
        return local_error(StatusCode::BAD_REQUEST, "external_auth_or_query_not_allowed");
    }
    let headers = websocket_request_headers(request.headers());
    let (mut parts, _) = request.into_parts();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let url = match state.provider.websocket_url_for_path("/responses") {
        Ok(url) => url,
        Err(_) => return local_error(StatusCode::BAD_GATEWAY, "official_websocket_url_unavailable"),
    };
    let mut recovery = state.manager.unauthorized_recovery();
    let (upstream, handshake) = loop {
        // Build through the same fixed official provider and AuthManager as HTTP.
        // Incoming credentials have already been rejected/removed, and the
        // upstream connector resolves the same SOCKS/HTTP proxy and CA policy.
        let mut authenticated = state.provider.build_request(Method::GET, "/responses");
        authenticated.headers.extend(headers.clone());
        for (name, value) in default_client::default_headers() {
            if let Some(name) = name
                && !authenticated.headers.contains_key(&name)
            {
                authenticated.headers.insert(name, value);
            }
        }
        let authenticated = match state.auth.apply_auth(authenticated).await {
            Ok(request) => request,
            Err(_) => return local_error(StatusCode::BAD_GATEWAY, "official_auth_unavailable"),
        };
        let mut outgoing = match url.as_str().into_client_request() {
            Ok(request) => request,
            Err(_) => return local_error(StatusCode::BAD_GATEWAY, "official_websocket_request_unavailable"),
        };
        outgoing.headers_mut().extend(authenticated.headers);
        let connected = tokio::time::timeout(
            HANDSHAKE_TIMEOUT,
            state.websocket.connect(outgoing, upstream_config()),
        ).await;
        match connected {
            Ok(Ok(connection)) => break connection,
            Ok(Err(WsError::Http(response))) => {
                // A pre-upgrade 401 can use the official bounded recovery.
                // No established session or generation is ever replayed here.
                if response.status() == StatusCode::UNAUTHORIZED && recovery.has_next() {
                    match recovery.next().await {
                        Ok(_) => continue,
                        Err(_) => eprintln!("native_runtime_auth_recovery_failed"),
                    }
                }
                return handshake_rejection(&response);
            }
            Ok(Err(_)) => return local_error(StatusCode::BAD_GATEWAY, "official_websocket_transport_unavailable"),
            Err(_) => return local_error(StatusCode::GATEWAY_TIMEOUT, "official_websocket_handshake_timeout"),
        }
    };
    let upgrade = match handshake.headers().get(http::header::SEC_WEBSOCKET_PROTOCOL) {
        Some(protocol) => match protocol.to_str() {
            Ok(protocol) => upgrade.protocols([protocol.to_owned()]),
            Err(_) => return local_error(StatusCode::BAD_GATEWAY, "official_websocket_protocol_invalid"),
        },
        None => upgrade,
    };
    let mut output = upgrade.on_upgrade(move |downstream| relay(downstream, upstream));
    // Forward per-connection turn state, model and rate metadata, while each
    // leg independently owns its key, extensions and upgrade response fields.
    output.headers_mut().extend(websocket_response_headers(handshake.headers()));
    output
}

fn websocket_request_headers(incoming: &HeaderMap) -> HeaderMap {
    let mut headers = request_headers(incoming);
    for name in ["sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
        "sec-websocket-accept", "content-encoding", "content-type", "accept"] {
        headers.remove(name);
    }
    if !headers.contains_key("openai-beta") {
        headers.insert("openai-beta", HeaderValue::from_static("responses_websockets=2026-02-06"));
    }
    headers
}

fn websocket_response_headers(upstream: &HeaderMap) -> HeaderMap {
    let mut headers = response_headers(upstream);
    for name in ["sec-websocket-accept", "sec-websocket-extensions", "sec-websocket-protocol",
        "content-length", "content-encoding"] {
        headers.remove(name);
    }
    headers
}

fn handshake_rejection(upstream: &http::Response<Option<Vec<u8>>>) -> Response {
    // The pinned Tungstenite returns only bytes already buffered after the
    // response head; it does not finish/dechunk a rejected handshake body. Never
    // advertise a larger Content-Length or return chunk framing as JSON.
    let body = upstream.body().as_deref().unwrap_or_default();
    let complete = !upstream.headers().contains_key(http::header::TRANSFER_ENCODING)
        && upstream.headers().get(http::header::CONTENT_LENGTH)
            .and_then(|length| length.to_str().ok())
            .and_then(|length| length.parse::<usize>().ok()) == Some(body.len());
    let mut output = if complete {
        Response::new(Body::from(body.to_vec()))
    } else {
        local_error(upstream.status(), "official_websocket_handshake_rejected")
    };
    let mut headers = response_headers(upstream.headers());
    if !complete {
        for name in ["content-length", "content-encoding", "content-type", "content-md5", "digest", "etag"] {
            headers.remove(name);
        }
        headers.insert(http::header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-codex-runtime-error-body", HeaderValue::from_static("unavailable"));
    }
    *output.status_mut() = upstream.status();
    *output.headers_mut() = headers;
    output
}

fn upstream_config() -> WebSocketConfig {
    // Match the pinned official Responses client, including compression.
    let mut extensions = ExtensionsConfig::default();
    extensions.permessage_deflate = Some(DeflateConfig::default());
    let mut config = WebSocketConfig::default();
    config.extensions = extensions;
    config
}

async fn relay<S>(downstream: WebSocket, upstream: S)
where
    S: Stream<Item = Result<UpstreamMessage, WsError>>
        + Sink<UpstreamMessage, Error = WsError> + Unpin + Send + 'static,
{
    let (mut downstream_sink, mut downstream_source) = downstream.split();
    let (mut upstream_sink, mut upstream_source) = upstream.split();

    // The independent pumps each await socket backpressure, with no unbounded
    // queue. A disconnect/error ends both halves so cancelled generations cannot
    // keep running behind a disconnected desktop. There is no session timer.
    enum End { DownstreamClose, UpstreamClose, Disconnected }
    let ended = {
    let outbound = async {
        while let Some(Ok(message)) = downstream_source.next().await {
            let message = match message {
                Message::Text(text) => UpstreamMessage::Text(text.as_str().to_owned().into()),
                Message::Binary(bytes) => UpstreamMessage::Binary(bytes),
                Message::Close(frame) => UpstreamMessage::Close(frame.map(|frame| {
                    tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: frame.code.into(), reason: frame.reason.as_str().to_owned().into(),
                    }
                })),
                // RFC6455 ping/pong is answered by the library on each leg.
                Message::Ping(_) | Message::Pong(_) => continue,
            };
            let closing = message.is_close();
            if upstream_sink.send(message).await.is_err() { return End::Disconnected; }
            if closing { return End::DownstreamClose; }
        }
        End::Disconnected
    };
    let inbound = async {
        while let Some(Ok(message)) = upstream_source.next().await {
            let message = match message {
                UpstreamMessage::Text(text) => Message::Text(text.as_str().to_owned().into()),
                UpstreamMessage::Binary(bytes) => Message::Binary(bytes),
                UpstreamMessage::Close(frame) => Message::Close(frame.map(|frame| CloseFrame {
                    code: frame.code.into(), reason: frame.reason.as_str().to_owned().into(),
                })),
                UpstreamMessage::Ping(_) | UpstreamMessage::Pong(_) | UpstreamMessage::Frame(_) => continue,
            };
            let closing = matches!(message, Message::Close(_));
            if downstream_sink.send(message).await.is_err() { return End::Disconnected; }
            if closing { return End::UpstreamClose; }
        }
        End::Disconnected
    };
    tokio::select! { ended = outbound => ended, ended = inbound => ended }
    };
    if matches!(ended, End::Disconnected) { return; }

    // Reading Close queues a same-leg acknowledgement in Tungstenite. Flush
    // both legs before dropping them, then allow the other peer to acknowledge
    // the forwarded Close. Bound this cleanup so an unresponsive peer cannot
    // prevent cancellation or hold the bridge forever.
    let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
        let _ = futures_util::future::join(downstream_sink.flush(), upstream_sink.flush()).await;
        match ended {
            End::DownstreamClose => {
                while let Some(Ok(message)) = upstream_source.next().await {
                    if message.is_close() { break; }
                }
                let _ = upstream_sink.flush().await;
            }
            End::UpstreamClose => {
                while let Some(Ok(message)) = downstream_source.next().await {
                    if matches!(message, Message::Close(_)) { break; }
                }
                let _ = downstream_sink.flush().await;
            }
            End::Disconnected => {}
        }
    }).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, routing::get};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{accept_async, client_async};

    #[test]
    fn handshake_keeps_session_metadata_but_replaces_hop_keys_and_credentials() {
        let mut input = HeaderMap::new();
        for (name, value) in [
            ("authorization", "Bearer gateway-not-upstream"),
            (INTERNAL_TOKEN_HEADER, "internal-only"),
            ("sec-websocket-key", "downstream-key"),
            ("sec-websocket-extensions", "permessage-deflate"),
            ("sec-websocket-protocol", "sample-protocol"),
            ("x-codex-turn-state", "opaque"),
            ("x-codex-routing-hint", "model=gpt-test"),
            ("x-future-unknown", "preserved"),
        ] { input.insert(http::HeaderName::from_static(name), HeaderValue::from_static(value)); }
        let headers = websocket_request_headers(&input);
        for name in ["authorization", INTERNAL_TOKEN_HEADER, "sec-websocket-key", "sec-websocket-extensions"] {
            assert!(!headers.contains_key(name));
        }
        assert_eq!(headers["x-codex-turn-state"], "opaque");
        assert_eq!(headers["x-future-unknown"], "preserved");
        assert_eq!(headers["sec-websocket-protocol"], "sample-protocol");
        assert!(upstream_config().extensions.permessage_deflate.is_some());
    }

    #[tokio::test]
    async fn rejected_handshake_preserves_complete_encoding_but_never_partial_length_or_chunking() {
        let complete = http::Response::builder().status(429)
            .header("content-length", "3").header("content-encoding", "gzip")
            .header("retry-after", "7").body(Some(vec![31, 139, 0])).unwrap();
        let output = handshake_rejection(&complete);
        assert_eq!(output.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(output.headers()["content-encoding"], "gzip");
        assert_eq!(output.headers()["content-length"], "3");
        assert_eq!(axum::body::to_bytes(output.into_body(), 100).await.unwrap().as_ref(), &[31, 139, 0]);
        for chunked in [false, true] {
            let mut incomplete = http::Response::builder().status(429)
                .header("content-length", "100").header("content-encoding", "gzip")
                .header("retry-after", "7").body(Some(vec![31, 139, 0])).unwrap();
            if chunked { incomplete.headers_mut().insert("transfer-encoding", HeaderValue::from_static("chunked")); }
            let output = handshake_rejection(&incomplete);
            assert_eq!(output.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(output.headers()["retry-after"], "7");
            assert!(!output.headers().contains_key("content-length"));
            assert!(!output.headers().contains_key("content-encoding"));
            assert!(!output.headers().contains_key("transfer-encoding"));
            assert_eq!(output.headers()["x-codex-runtime-error-body"], "unavailable");
            let body = axum::body::to_bytes(output.into_body(), 1000).await.unwrap();
            assert!(std::str::from_utf8(&body).unwrap().contains("official_websocket_handshake_rejected"));
        }
    }

    #[tokio::test]
    async fn disconnect_and_client_close_cancel_the_upstream_session() {
        for close_gracefully in [false, true] {
            let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let server_address = server.local_addr().unwrap();
            let peer = tokio::spawn(async move {
                let (tcp, _) = server.accept().await.unwrap();
                let mut socket = accept_async(tcp).await.unwrap();
                assert!(matches!(socket.next().await, Some(Ok(UpstreamMessage::Text(_)))));
                socket.send(UpstreamMessage::Text("ready".into())).await.unwrap();
                let ended = socket.next().await;
                if close_gracefully {
                    let Some(Ok(UpstreamMessage::Close(Some(frame)))) = ended else {
                        panic!("client close frame must be flushed before relay exits");
                    };
                    assert_eq!(u16::from(frame.code), 1000);
                    assert_eq!(frame.reason.as_str(), "cancel session");
                    let _ = socket.flush().await;
                } else {
                    assert!(ended.is_none() || matches!(ended, Some(Err(_))));
                }
            });
            let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy_address = proxy.local_addr().unwrap();
            let app = Router::new().route("/v1/responses", get(move |upgrade: WebSocketUpgrade| async move {
                let tcp = TcpStream::connect(server_address).await.unwrap();
                let (upstream, _) = client_async(format!("ws://{server_address}/responses"), tcp).await.unwrap();
                upgrade.on_upgrade(move |downstream| relay(downstream, upstream))
            }));
            let proxy_task = tokio::spawn(async move { axum::serve(proxy, app).await.unwrap(); });
            tokio::time::timeout(Duration::from_secs(5), async {
                let tcp = TcpStream::connect(proxy_address).await.unwrap();
                let (mut client, _) = client_async(format!("ws://{proxy_address}/v1/responses"), tcp).await.unwrap();
                client.send(UpstreamMessage::Text("start".into())).await.unwrap();
                assert_eq!(client.next().await.unwrap().unwrap(), UpstreamMessage::Text("ready".into()));
                if close_gracefully {
                    client.send(UpstreamMessage::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: 1000.into(), reason: "cancel session".into(),
                    }))).await.unwrap();
                    let Some(Ok(UpstreamMessage::Close(Some(reply)))) = client.next().await else {
                        panic!("client must receive its close acknowledgement");
                    };
                    assert_eq!(u16::from(reply.code), 1000);
                } else {
                    drop(client);
                }
                peer.await.unwrap();
            }).await.unwrap();
            proxy_task.abort();
        }
    }

    #[tokio::test]
    async fn persistent_relay_keeps_warmup_continuation_unknown_fields_binary_and_close() {
        let server = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let server_address = server.local_addr().unwrap();
        let frames = vec![
            r#"{"type":"response.create","generate":false,"extra":{"opaque":[1,2]}}"#,
            r#"{"type":"response.create","previous_response_id":"warmup-1","input":[]}"#,
            r#"{"type":"response.create","previous_response_id":"result-1","future":true}"#,
            r#"{"type":"response.cancel","response_id":"result-2"}"#,
        ];
        let expected = frames.clone();
        let peer = tokio::spawn(async move {
            let (tcp, _) = server.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            for text in expected {
                assert_eq!(socket.next().await.unwrap().unwrap(), UpstreamMessage::Text(text.into()));
                let reply = format!("{{\"type\":\"codex.response.metadata\",\"raw\":{text}}}");
                socket.send(UpstreamMessage::Text(reply.into())).await.unwrap();
            }
            assert_eq!(socket.next().await.unwrap().unwrap(), UpstreamMessage::Binary(vec![0, 1, 255].into()));
            socket.send(UpstreamMessage::Binary(vec![255, 1, 0].into())).await.unwrap();
            socket.send(UpstreamMessage::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                code: 1000.into(), reason: "done".into(),
            }))).await.unwrap();
            let Some(Ok(UpstreamMessage::Close(Some(reply)))) = socket.next().await else {
                panic!("upstream must receive its close acknowledgement");
            };
            assert_eq!(u16::from(reply.code), 1000);
        });
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = proxy.local_addr().unwrap();
        let app = Router::new().route("/v1/responses", get(move |upgrade: WebSocketUpgrade| async move {
            let tcp = TcpStream::connect(server_address).await.unwrap();
            let (upstream, _) = client_async(format!("ws://{server_address}/responses"), tcp).await.unwrap();
            upgrade.on_upgrade(move |downstream| relay(downstream, upstream))
        }));
        let proxy_task = tokio::spawn(async move { axum::serve(proxy, app).await.unwrap(); });
        let tcp = TcpStream::connect(proxy_address).await.unwrap();
        let (mut client, _) = client_async(format!("ws://{proxy_address}/v1/responses"), tcp).await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            for text in frames {
                client.send(UpstreamMessage::Text(text.into())).await.unwrap();
                let reply = format!("{{\"type\":\"codex.response.metadata\",\"raw\":{text}}}");
                assert_eq!(client.next().await.unwrap().unwrap(), UpstreamMessage::Text(reply.into()));
            }
            client.send(UpstreamMessage::Binary(vec![0, 1, 255].into())).await.unwrap();
            assert_eq!(client.next().await.unwrap().unwrap(), UpstreamMessage::Binary(vec![255, 1, 0].into()));
            let close = client.next().await.unwrap().unwrap();
            let UpstreamMessage::Close(Some(frame)) = close else { panic!("close frame required"); };
            assert_eq!(u16::from(frame.code), 1000);
            assert_eq!(frame.reason.as_str(), "done");
            let _ = client.flush().await;
            peer.await.unwrap();
        }).await.unwrap();
        proxy_task.abort();
    }
}
