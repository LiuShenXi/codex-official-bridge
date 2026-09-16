"""Reusable, locally encrypted three-point Codex request capture controller."""
from __future__ import annotations
import argparse, datetime, hashlib, http.client, json, os, pathlib, shutil, socket
import subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
CONFIG = None
STATE = None
HIDDEN = getattr(subprocess, 'CREATE_NO_WINDOW', 0)

def run(argv, **kw):
    return subprocess.run([str(x) for x in argv], check=True, capture_output=True, text=True, creationflags=HIDDEN, **kw)

def ps(script):
    return run(['powershell.exe','-NoProfile','-NonInteractive','-Command',script]).stdout.strip()

def q(value): return "'" + str(value).replace("'", "''") + "'"
def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp=path.with_suffix('.tmp'); tmp.write_text(json.dumps(obj, indent=2), encoding='utf-8'); os.replace(tmp,path)
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def state(): return json.loads(STATE.read_text()) if STATE.exists() else None
def remote(*args):
    # Only fixed verbs and generated run IDs enter remote shell commands.
    return run(['ssh','-o','BatchMode=yes',CONFIG['ssh_host'],'bash '+CONFIG['remote_root']+'/remote_capture.sh '+' '.join(args)], timeout=240).stdout.strip()
def listening(port):
    try:
        with socket.create_connection(('127.0.0.1',port),timeout=.3): return True
    except OSError: return False
def wait_for(fn, seconds=20):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if fn(): return
        time.sleep(.25)
    raise RuntimeError('readiness_timeout')
def ready(path):
    try:
        s=json.loads(path.read_text()); return s['ready'] and not s['failed'] and time.time_ns()-s['updated_ns']<5_000_000_000
    except (OSError,ValueError,KeyError): return False
def launch(argv, env=None, stderr=None):
    # All helpers are hidden and receive only their own explicit process environment.
    err=open(stderr,'ab') if stderr else subprocess.DEVNULL
    try:
        p=subprocess.Popen([str(x) for x in argv],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=err,creationflags=HIDDEN)
    finally:
        if stderr: err.close()
    return p
def launch_ps(path): return launch(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',path])
def app_stop(root):
    # Select GUI root by its unique --user-data-dir, then only its descendants.
    literal=q(str(root/'app-data/web/Codex'))
    script=f"""$all=@(Get-CimInstance Win32_Process); $roots=@($all | Where-Object {{$_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch ' --type=' -and $_.CommandLine.Contains({literal})}}); $ids=New-Object 'System.Collections.Generic.HashSet[int]'; foreach($p in $roots){{[void]$ids.Add([int]$p.ProcessId)}}; do {{$added=$false; foreach($p in $all){{if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){{$added=$true}}}}}} while($added); foreach($id in @($ids)){{Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}}; $ids.Count"""
    return int(ps(script) or 0)

def app_running(root):
    literal=q(str(root/'app-data/web/Codex'))
    raw=ps(f"""$all=@(Get-CimInstance Win32_Process); $roots=@($all | Where-Object {{$_.Name -eq 'ChatGPT.exe' -and $_.CommandLine -notmatch ' --type=' -and $_.CommandLine.Contains({literal})}}); $servers=@($all | Where-Object {{$_.Name -eq 'codex.exe' -and $_.ParentProcessId -in $roots.ProcessId -and $_.CommandLine -match 'app-server'}}); [int]($roots.Count -eq 1 -and $servers.Count -ge 1)""")
    return raw=='1'
def tunnel_stop(root):
    literal=q(str(root/'tunnel.ps1'))
    # Identify this profile's supervisor and its direct SSH child only.
    ps(f"""$all=@(Get-CimInstance Win32_Process); $parents=@($all | Where-Object {{$_.Name -eq 'powershell.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -match '\\s-File\\s' -and $_.CommandLine -notmatch '\\s-Command\\s' -and $_.CommandLine -like ('*'+{literal}+'*')}}); foreach($p in $parents){{Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $all | Where-Object {{$_.ParentProcessId -eq $p.ProcessId -and $_.Name -eq 'ssh.exe'}} | ForEach-Object {{Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}}}}""")

def proxy(run_dir, label, port, mode, extra=(), conf=None):
    d=run_dir/label; d.mkdir(parents=True,exist_ok=True)
    conf=pathlib.Path(conf) if conf else pathlib.Path(CONFIG['data_root'])/'ca'/label
    env=os.environ.copy()
    env.update(CAPTURE_ROOT=str(d/'records'),CAPTURE_LABEL=label,
        CAPTURE_PUBLIC_KEY=str(pathlib.Path(CONFIG['data_root'])/'private/capture-public.pem'),
        CAPTURE_STATUS_FILE=str(d/'status.json'),CAPTURE_STOP_FILE=str(d/'stop'))
    args=[CONFIG['mitmdump'],'--listen-host','127.0.0.1','--listen-port',port,'--mode',mode,
        '--set','confdir='+str(conf),'--set','flow_detail=0','--set','termlog_verbosity=error',
        '--quiet','-s',HERE/'capture_addon.py',*extra]
    p=launch(args,env=env,stderr=d/'proxy-error.log')
    dump(d/'process.json',{'pid':p.pid,'executable':CONFIG['mitmdump']})
    wait_for(lambda: ready(d/'status.json') and listening(port))
    return d

def stop_proxies(run_dir, labels):
    for label in labels:
        d=run_dir/label
        if d.exists(): (d/'stop').touch()
    for label in labels:
        d=run_dir/label
        port={'bridge-inbound':8879,'official-outbound':18881,'selftest':18880}[label]
        if (d/'status.json').exists(): wait_for(lambda: not ready(d/'status.json') and not listening(port), 20)

def selftest():
    from verify_selftest import verify
    data=pathlib.Path(CONFIG['data_root']); d=data/'selftests'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    d.mkdir(parents=True)
    if listening(18443) or listening(18880): raise RuntimeError('selftest_ports_in_use')
    env=os.environ.copy(); env['CAPTURE_SELFTEST_ROOT']=str(d)
    server=launch([sys.executable,HERE/'selftest_server.py'],env=env,stderr=d/'server-error.log')
    try:
        wait_for(lambda: listening(18443) and (d/'selftest-state/server-cert.pem').exists())
        proxy(d,'selftest',18880,'regular', ['--set','ssl_verify_upstream_trusted_ca='+str(d/'selftest-state/server-cert.pem')],conf=d/'proxy-state-selftest')
        run([sys.executable,HERE/'selftest_client.py'],env=env,timeout=30)
        stop_proxies(d,['selftest'])
        result=verify(d/'selftest/records',d/'selftest-state/expected.json',data/'private/capture-private.dpapi')
        if not result['passed'] or result['open_or_unclean_sessions']: raise RuntimeError('selftest_incomplete')
        result['verified_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        result['addon_sha256']=digest(HERE/'capture_addon.py')
        dump(data/'selftest.json',result)
        return result
    finally:
        stop_proxies(d,['selftest'])
        server.terminate(); server.wait(timeout=10)

def patch(s, path, transform):
    original=path.read_bytes(); changed=transform(original.decode('utf-8-sig')).encode('utf-8-sig')
    if original==changed: return
    dest=pathlib.Path(s['run_dir'])/'backups'/str(len(s['patches']))
    dest.parent.mkdir(exist_ok=True); dest.write_bytes(original)
    s['patches'].append({'path':str(path),'backup':str(dest),'new_sha256':hashlib.sha256(changed).hexdigest()})
    dump(STATE,s); path.write_bytes(changed)
def restore(s):
    for p in reversed(s['patches']):
        path=pathlib.Path(p['path']); original=pathlib.Path(p['backup']).read_bytes()
        if path.read_bytes()==original: continue
        if digest(path)!=p['new_sha256']: raise RuntimeError('launcher_changed_during_capture_restore_refused')
        path.write_bytes(original)

def health():
    # Read the second profile only in memory; credentials never enter argv/output.
    profile=json.loads((pathlib.Path(CONFIG['second_root'])/'codex/connection.json').read_text(encoding='utf-8-sig'))
    c=http.client.HTTPConnection('127.0.0.1',8879,timeout=10)
    try:
        c.request('GET','/healthz',headers={'Authorization':'Bearer '+profile['api_key']})
        r=c.getresponse(); r.read(); return r.status==200
    except OSError: return False
    finally: c.close()

def manifest(run_dir):
    import tomllib, platform, importlib.metadata
    profiles={}
    for label,key in (('bridge','second_root'),('official','third_root')):
        cfg=tomllib.loads((pathlib.Path(CONFIG[key])/'codex/config.toml').read_text(encoding='utf-8-sig'))
        profiles[label]={k:cfg.get(k) for k in ('model','model_reasoning_effort','model_provider','sandbox_mode','windows','features')}
    result={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'profiles':profiles,'python':platform.python_version(),
        'tool_files_sha256':{p.name:digest(p) for p in HERE.iterdir() if p.is_file() and p.suffix in ('.py','.ps1','.sh','.yml')},
        'decoders':{name:importlib.metadata.version(name) for name in ('cryptography','zstandard','brotli') if __import__('importlib.util',fromlist=['find_spec']).find_spec(name) is not None},
        'limitations':['TLS_peer_changed','parsed_HTTP_headers_not_wire_frames','WS_reassembled_messages_not_frames','buffering_and_encryption_change_timing']}
    dump(pathlib.Path(run_dir)/'experiment-manifest.json',result)
    return result

def start():
    old=state()
    if old and old['phase']!='stopped': raise RuntimeError('active_or_partial_run_exists_use_status_or_stop')
    if listening(18881) or listening(18879): raise RuntimeError('capture_ports_already_in_use')
    selftest()
    data=pathlib.Path(CONFIG['data_root']); run_id=datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    d=data/'runs'/run_id; d.mkdir(parents=True)
    s={'run_id':run_id,'run_dir':str(d),'phase':'starting','ready':False,'patches':[],
        'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'remote_started':False}
    dump(STATE,s)
    manifest(d)
    second=pathlib.Path(CONFIG['second_root']); third=pathlib.Path(CONFIG['third_root'])
    try:
        remote('start',run_id); s['remote_started']=True; dump(STATE,s)
        proxy(d,'official-outbound',18881,'upstream:'+CONFIG['official_upstream_proxy'])
        ca=data/'ca/official-outbound/mitmproxy-ca-cert.pem'
        inject="\n# Managed request capture; restored by capturectl stop.\n"+''.join('$env:'+k+' = '+q(v)+'\n' for k,v in {
            'HTTP_PROXY':'http://127.0.0.1:18881','HTTPS_PROXY':'http://127.0.0.1:18881',
            'ALL_PROXY':'http://127.0.0.1:18881','NO_PROXY':'127.0.0.1,localhost,::1',
            'CODEX_CA_CERTIFICATE':str(ca)}.items())
        def third_change(text):
            needle='$package = Get-AppxPackage'
            if needle not in text: raise RuntimeError('third_launcher_layout_changed')
            return text.replace(needle,inject+'\n'+needle,1)
        patch(s,third/'launch.ps1',third_change)
        def tunnel_change(text):
            if '-LocalPort 8879' not in text or '-L 127.0.0.1:8879:127.0.0.1:8879' not in text: raise RuntimeError('tunnel_layout_changed')
            return text.replace('-LocalPort 8879','-LocalPort 18879').replace('-L 127.0.0.1:8879:127.0.0.1:8879','-L 127.0.0.1:18879:127.0.0.1:8879')
        app_stop(second); app_stop(third); tunnel_stop(second)
        patch(s,second/'tunnel.ps1',tunnel_change)
        launch_ps(second/'tunnel.ps1'); wait_for(lambda:listening(18879),30)
        proxy(d,'bridge-inbound',8879,'reverse:http://127.0.0.1:18879',['--set','keep_host_header=true'])
        wait_for(health,30)
        s['preflight']=probe(d); dump(STATE,s)
        launch_ps(second/'launch.ps1'); launch_ps(third/'launch.ps1')
        wait_for(lambda: app_running(second) and app_running(third),45)
        s['phase']='running'; s['ready']=True; dump(STATE,s)
        return status()
    except Exception:
        s['phase']='start_failed'; s['ready']=False; dump(STATE,s)
        # Attempt exact snapshot rollback; retain state if external recovery needed.
        try: stop()
        except Exception: pass
        raise

def status():
    s=state()
    if not s: return {'ready':False,'phase':'never_started'}
    d=pathlib.Path(s['run_dir']); points={}
    for label in ('bridge-inbound','official-outbound'):
        p=d/label/'status.json'
        points[label]=json.loads(p.read_text()) if p.exists() else {'ready':False}
        points[label]['fresh_ready']=ready(p)
    try:
        raw=remote('status',s['run_id']); remote_status=json.loads(raw)
    except Exception: remote_status={'ready':False,'error':'remote_status_unavailable'}
    apps_ready=s['phase']=='running' and app_running(pathlib.Path(CONFIG['second_root'])) and app_running(pathlib.Path(CONFIG['third_root']))
    return {'run_id':s['run_id'],'phase':s['phase'],
        'ready':apps_ready and all(p['fresh_ready'] for p in points.values()) and remote_status.get('ready',False),
        'apps_running':apps_ready,
        'local':points,'remote':remote_status,'note':'Ready means capture attached; comparison requires user test samples.'}

def collect(s):
    d=pathlib.Path(s['run_dir'])/'remote'; d.mkdir(exist_ok=True)
    # SCP only encrypted event streams/envelopes and safe sidecar status; no auth/CA/private files.
    archive=remote('collect',s['run_id'])
    if not archive.startswith(CONFIG['remote_root']+'/archives/'+s['run_id']+'-') or not archive.endswith('.tar.gz') or any(c in archive for c in '\r\n \t'):
        raise RuntimeError('unexpected_remote_archive_path')
    run(['scp','-q',CONFIG['ssh_host']+':'+archive,d/'capture.tar.gz'],timeout=120)
    import tarfile
    with tarfile.open(d/'capture.tar.gz') as tar: tar.extractall(d,filter='data')
    return d

def https_probe(proxy_url, url, ca=None):
    import ssl, urllib.parse
    target=urllib.parse.urlsplit(url); proxy_url=urllib.parse.urlsplit(proxy_url)
    context=ssl.create_default_context(cafile=str(ca) if ca else None)
    c=http.client.HTTPSConnection(proxy_url.hostname,proxy_url.port,context=context,timeout=30)
    c.set_tunnel(target.hostname,443)
    try:
        c.request('GET',target.path+('?' + target.query if target.query else ''))
        r=c.getresponse(); return r.status,r.read()
    finally: c.close()

def probe(run_dir):
    import ipaddress
    data=pathlib.Path(CONFIG['data_root'])
    ca=data/'ca/official-outbound/mitmproxy-ca-cert.pem'
    before_status,before_body=https_probe(CONFIG['official_upstream_proxy'],'https://api.ipify.org')
    after_status,after_body=https_probe('http://127.0.0.1:18881','https://api.ipify.org',ca)
    if (before_status,after_status)!=(200,200): raise RuntimeError('egress_probe_http_failure')
    before=before_body.decode().strip(); after=after_body.decode().strip()
    ipaddress.ip_address(before); ipaddress.ip_address(after)
    if before != after: raise RuntimeError('official_egress_changed')
    code,_=https_probe('http://127.0.0.1:18881','https://chatgpt.com/backend-api/codex/models?client_version=0.154.0',ca)
    if code != 401: raise RuntimeError('official_tls_probe_unexpected_status')
    result=json.loads(run(['ssh','-o','BatchMode=yes',CONFIG['ssh_host'],
        'python3 '+CONFIG['remote_root']+'/probe_remote.py'],timeout=100).stdout)
    if not result.get('passed'): raise RuntimeError('remote_egress_or_tls_probe_failed')
    profile=json.loads((pathlib.Path(CONFIG['second_root'])/'codex/connection.json').read_text(encoding='utf-8-sig'))
    c=http.client.HTTPConnection('127.0.0.1',8879,timeout=40)
    try:
        c.request('GET','/v1/models?client_version=0.154.0',headers={'Authorization':'Bearer '+profile['api_key'],'X-Capture-Probe':'setup-model-catalog'})
        r=c.getresponse(); r.read(); model_status=r.status
    finally: c.close()
    if model_status != 200: raise RuntimeError('native_bridge_models_probe_failed')
    result.update(official_egress_preserved=True,official_egress=after,official_unauthenticated_status=int(code),bridge_model_catalog_status=model_status)
    dump(run_dir/'preflight.json',result)
    return result

def report(output):
    s=state()
    if not s: raise RuntimeError('no_run')
    collect(s)
    return run([sys.executable,HERE/'analyze_capture.py','--root',s['run_dir'],'--output',output,
        '--key-file',pathlib.Path(CONFIG['data_root'])/'private/capture-private.dpapi'],timeout=120).stdout.strip()

def stop():
    s=state()
    if not s or s['phase']=='stopped': return {'phase':'stopped','already_stopped':True}
    d=pathlib.Path(s['run_dir'])
    for label in ('bridge-inbound','official-outbound'):
        p=d/label/'status.json'
        if ready(p) and json.loads(p.read_text()).get('active_flows',0): raise RuntimeError('requests_still_active_finish_them_before_stop')
    second=pathlib.Path(CONFIG['second_root']); third=pathlib.Path(CONFIG['third_root'])
    # Restore the server first; never leave it pointing at a dead proxy.
    remote('stop',s['run_id'])
    app_stop(second); app_stop(third); tunnel_stop(second)
    restore(s); stop_proxies(d,['bridge-inbound','official-outbound'])
    launch_ps(second/'launch.ps1'); launch_ps(third/'launch.ps1')
    s['phase']='stopped'; s['ready']=False; s['stopped_at']=datetime.datetime.now(datetime.timezone.utc).isoformat(); dump(STATE,s)
    collect(s)
    return {'phase':'stopped','run_id':s['run_id'],'configurations_restored':True}

def main():
    global CONFIG,STATE
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('selftest','start','status','stop','report'))
    parser.add_argument('--config',type=pathlib.Path,default=HERE.parents[1]/'.runtime/request-capture/capture-config.json')
    parser.add_argument('--output',type=pathlib.Path)
    args=parser.parse_args()
    CONFIG=json.loads(args.config.read_text(encoding='utf-8-sig'))
    STATE=pathlib.Path(CONFIG['data_root'])/'state.json'
    try:
        if args.command=='report':
            if args.output is None: parser.error('report requires --output')
            args.output.mkdir(parents=True,exist_ok=True)
            result=report(args.output/'capture-comparison')
        else: result=globals()[args.command]()
        print(json.dumps(result,ensure_ascii=False))
        return 0
    except Exception as exc:
        # Never dump subprocess stdout/stderr, HTTP objects, auth material or exception data.
        code=str(exc) if isinstance(exc,RuntimeError) and str(exc).replace('_','').isalnum() else type(exc).__name__
        print(json.dumps({'ready':False,'error':code,'command':args.command}))
        return 1

if __name__=='__main__': sys.exit(main())
