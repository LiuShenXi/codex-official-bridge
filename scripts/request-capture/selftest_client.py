import base64,gzip,http.client,json,pathlib,socket,ssl,struct,time,os
ROOT=pathlib.Path(os.environ.get('CAPTURE_SELFTEST_ROOT',pathlib.Path(__file__).parent))
ctx=ssl.create_default_context(cafile=str(ROOT/'proxy-state-selftest/mitmproxy-ca-cert.pem'))
body=gzip.compress(json.dumps({'unknown':{'retained':True},'secret':'SELFTEST_ONLY_NEVER_PLAIN'}).encode(),mtime=0)
conn=http.client.HTTPSConnection('127.0.0.1',18880,context=ctx); conn.set_tunnel('127.0.0.1',18443)
conn.putrequest('POST','/selftest/sse'); conn.putheader('Content-Type','application/json'); conn.putheader('Content-Encoding','gzip'); conn.putheader('Content-Length',str(len(body))); conn.putheader('Authorization','Bearer SELFTEST_ONLY_NEVER_PLAIN'); conn.putheader('X-Unknown-Protocol','first'); conn.putheader('X-Unknown-Protocol','second'); conn.endheaders(body)
response=conn.getresponse(); assert response.status==200; assert [v for k,v in response.getheaders() if k=='X-Unknown-Response']==['first','second']; data=response.read(); assert b'response.completed' in data; conn.close()
s=socket.create_connection(('127.0.0.1',18880)); s.sendall(b'CONNECT 127.0.0.1:18443 HTTP/1.1\r\nHost: 127.0.0.1:18443\r\n\r\n')
header=b''
while not header.endswith(b'\r\n\r\n'): header+=s.recv(1)
assert b' 200 ' in header
s=ctx.wrap_socket(s,server_hostname='127.0.0.1'); s.sendall(b'GET /selftest/ws HTTP/1.1\r\nHost: 127.0.0.1:18443\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Unknown-Protocol: websocket-test\r\n\r\n')
header=b''
while not header.endswith(b'\r\n\r\n'): header+=s.recv(1)
assert b' 101 ' in header
payload=b'{"type":"response.create","probe":"SELFTEST_ONLY_NEVER_PLAIN"}'
mask=b'1234'; s.sendall(bytes([0x81,0x80|len(payload)])+mask+bytes(b^mask[i%4] for i,b in enumerate(payload)))
def exact(n):
    data=b''
    while len(data)<n:
        d=s.recv(n-len(data))
        if not d: raise EOFError()
        data+=d
    return data
first=exact(2); length=first[1]&127; reply=exact(length); assert reply==payload
first=exact(2); assert first[0]&15==8; exact(first[1]&127); s.close()
(ROOT/'selftest-state/expected.json').write_text(json.dumps({'request_body_b64':base64.b64encode(body).decode(),'response_body_b64':base64.b64encode(data).decode(),'ws_payload_b64':base64.b64encode(payload).decode()}))
print('TLS proxy HTTP/SSE and WebSocket client round trips: passed')
