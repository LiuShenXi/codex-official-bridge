import base64, datetime, gzip, hashlib, http.server, ipaddress, json, os, pathlib, socket, ssl, struct, sys, time
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
ROOT=pathlib.Path(os.environ.get('CAPTURE_SELFTEST_ROOT',pathlib.Path(__file__).parent))/'selftest-state'; ROOT.mkdir(parents=True,exist_ok=True)
def certs():
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Codex Capture Selftest')])
    cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(days=1)).not_valid_after(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(days=2)).add_extension(x509.BasicConstraints(ca=True,path_length=None),True).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1')),x509.DNSName('localhost')]),False).sign(key,hashes.SHA256())
    (ROOT/'server-key.pem').write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    (ROOT/'server-cert.pem').write_bytes(cert.public_bytes(serialization.Encoding.PEM))
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*a): pass
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        content=gzip.decompress(body)
        assert json.loads(content)['unknown']['retained']==True
        assert self.headers.get_all('X-Unknown-Protocol')==['first','second']
        event=b'event: response.completed\ndata: {"type":"response.completed","response":{"model":"selftest-only","output":[]}}\n\n'
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.send_header('X-Unknown-Response','first'); self.send_header('X-Unknown-Response','second'); self.send_header('Content-Length',str(len(event))); self.end_headers()
        for chunk in [event[:20],event[20:50],event[50:]]: self.wfile.write(chunk); self.wfile.flush(); time.sleep(.05)
    def do_GET(self):
        if self.path!='/selftest/ws': self.send_error(404); return
        accept=base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        self.send_response(101); self.send_header('Upgrade','websocket'); self.send_header('Connection','Upgrade'); self.send_header('Sec-WebSocket-Accept',accept); self.end_headers()
        first=self.rfile.read(2); length=first[1]&127
        if length==126: length=struct.unpack('!H',self.rfile.read(2))[0]
        mask=self.rfile.read(4); body=self.rfile.read(length); clear=bytes(v^mask[i%4] for i,v in enumerate(body))
        self.wfile.write(bytes([0x81,len(clear)])+clear); self.wfile.flush()
        self.wfile.write(b'\x88\x02\x03\xe8'); self.wfile.flush(); self.close_connection=True
if __name__=='__main__':
    certs(); server=http.server.ThreadingHTTPServer(('127.0.0.1',18443),Handler); context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(str(ROOT/'server-cert.pem'),str(ROOT/'server-key.pem')); server.socket=context.wrap_socket(server.socket,server_side=True); server.serve_forever()
