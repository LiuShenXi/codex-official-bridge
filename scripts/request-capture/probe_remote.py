"""Safe, non-inference route/CA validation for this private deployment."""
import ipaddress,json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parent
def curl(args,url):
    return subprocess.run(['curl','--silent','--show-error','--max-time','25',*args,url],capture_output=True,text=True,check=True,timeout=30).stdout.strip()
try:
    before=curl(['--socks5-hostname','172.30.80.1:11080'],'https://api.ipify.org')
    after=curl(['--proxy','http://127.0.0.1:18889','--cacert',str(root/'ca/mitmproxy-ca-cert.pem')],'https://api.ipify.org')
    ipaddress.ip_address(before); ipaddress.ip_address(after)
    code=curl(['--proxy','http://127.0.0.1:18889','--cacert',str(root/'ca/mitmproxy-ca-cert.pem'),'-o','/dev/null','-w','%{http_code}'],
        'https://chatgpt.com/backend-api/codex/models?client_version=0.154.0')
    result={'passed':before==after and code=='401','bridge_egress_preserved':before==after,'bridge_egress':after,'bridge_unauthenticated_status':int(code)}
except Exception as exc:
    result={'passed':False,'failure_type':type(exc).__name__}
print(json.dumps(result))
sys.exit(0 if result['passed'] else 1)
