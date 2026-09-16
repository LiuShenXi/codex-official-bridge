#!/usr/bin/env bash
# Reusable, root-owned remote capture lifecycle. No credentials or raw flows are printed.
# Install beside capture_addon.py, capture_vault.py, connect_to_socks.py,
# capture-public.pem and capture.compose.yml under the deployment's .runtime-capture.
# Usage: remote_capture.sh {start|stop|status|collect} RUN_ID
# collect writes an encrypted-record archive and prints only its absolute path.
set -Eeuo pipefail
umask 077
export CAPTURE_HOME="${CAPTURE_HOME:-/opt/codex-official-bridge/.runtime-capture}"
PROJECT_ROOT="${CAPTURE_PROJECT_ROOT:-/opt/codex-official-bridge}"
PROJECT_NAME=codex-official-bridge
BASE="$PROJECT_ROOT/docker-compose.yml"
OVERRIDE="$CAPTURE_HOME/capture.compose.yml"
ACTION="${1:-}"
RUN_ID="${2:-}"
[[ "$ACTION" =~ ^(start|stop|status|collect)$ && "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$ ]] || {
  printf '%s\n' 'Usage: remote_capture.sh {start|stop|status|collect} RUN_ID' >&2; exit 2;
}
[[ "$EUID" == 0 ]] || { printf '%s\n' 'Run as root to manage this deployment.' >&2; exit 2; }
[[ "$CAPTURE_HOME" == /* && "$PROJECT_ROOT" == /* ]] || exit 2
[[ -d "$CAPTURE_HOME" && -f "$BASE" ]] || { printf '%s\n' 'Capture installation or base Compose file is missing.' >&2; exit 2; }
RUN="$CAPTURE_HOME/runs/$RUN_ID"
ACTIVE="$CAPTURE_HOME/active-run"
mkdir -p "$CAPTURE_HOME/runs" "$CAPTURE_HOME/archives" "$CAPTURE_HOME/ca"
chmod 700 "$CAPTURE_HOME" "$CAPTURE_HOME/runs" "$CAPTURE_HOME/archives" "$CAPTURE_HOME/ca"
exec 9>"$CAPTURE_HOME/lifecycle.lock"
flock -w 15 9 || { printf '%s\n' 'Another capture lifecycle operation is running.' >&2; exit 3; }

fail() { printf '%s\n' "$1" >&2; return 1; }
base_hash() { sha256sum "$BASE" | cut -d' ' -f1; }
# Hash private dotenv bytes without emitting or archiving their contents.
dotenv_hash() { if [[ -f "$PROJECT_ROOT/.env" ]]; then sha256sum "$PROJECT_ROOT/.env" | cut -d' ' -f1; else printf '%s\n' absent; fi; }
phase() { printf '%s\n' "$1" >"$RUN/phase"; }
step() { printf '%s\n' "$1" >"$RUN/step"; }
assert_active() {
  [[ -f "$ACTIVE" && "$(cat "$ACTIVE")" == "$RUN_ID" ]] || fail 'This run is not the active capture run.'
}
base_unchanged() {
  [[ -f "$RUN/base.sha256" && "$(cat "$RUN/base.sha256")" == "$(base_hash)" ]] || { fail 'Base Compose changed; leave capture running and reconcile before stopping.'; return 1; }
  [[ -f "$RUN/dotenv.sha256" && "$(cat "$RUN/dotenv.sha256")" == "$(dotenv_hash)" ]] || { fail 'Deployment environment changed; leave capture running and reconcile before stopping.'; return 1; }
}
idle() {
  [[ -z "$(ss -Htn state established '( sport = :8879 )')" ]] || fail 'Bridge has an established client connection; wait until requests finish.'
  if [[ -f "$RUN/status.json" ]]; then
    python3 - "$RUN/status.json" <<'PY'
import json,sys
try:
    s=json.load(open(sys.argv[1])); n=s.get('active_flows')
    if not isinstance(n,int) or isinstance(n,bool) or n != 0: sys.exit(1)
except (OSError,ValueError,TypeError): sys.exit(1)
PY
  fi
}
compose() {
  local capture="$1"; shift
  local args=(--project-directory "$PROJECT_ROOT" --project-name "$PROJECT_NAME" -f "$BASE")
  if [[ "$capture" == yes ]]; then args+=(-f "$OVERRIDE"); fi
  # Read diagnostic text only in memory. Persist fixed categories, never raw
  # Compose output, because interpolation failures may include credentials.
  python3 - "$RUN" "$capture" "${args[@]}" "$@" <<'PY'
import json,pathlib,subprocess,sys,time
run=pathlib.Path(sys.argv[1]); capture=sys.argv[2]
p=subprocess.run(['docker','compose',*sys.argv[3:]],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if p.returncode:
    text=(p.stdout+b'\n'+p.stderr).decode('utf-8','replace').lower()
    patterns={'mount':('mount','not a directory','bind source'), 'permission':('permission denied','operation not permitted'), 'missing_file':('no such file','does not exist'), 'image':('pull access denied','no such image','manifest unknown'), 'compose_config':('invalid compose','invalid interpolation','required variable','validating '), 'port':('address already in use','port is already allocated'), 'daemon':('cannot connect to the docker daemon','daemon is not running'), 'resource':('no space left','out of memory','cannot allocate memory')}
    categories=[name for name,terms in patterns.items() if any(term in text for term in terms)] or ['unclassified']
    result={'capture_route':capture=='yes','exit_code':p.returncode,'categories':categories,'timestamp_ns':time.time_ns()}
    with (run/'compose-errors.jsonl').open('a') as f: f.write(json.dumps(result)+'\n')
    print(json.dumps({'compose_failed':True,**result}),file=sys.stderr)
sys.exit(p.returncode)
PY
}
health() {
  local deadline=$((SECONDS + 150)) cid
  while (( SECONDS < deadline )); do
    cid="$(docker compose --project-directory "$PROJECT_ROOT" --project-name "$PROJECT_NAME" -f "$BASE" ps -q bridge 2>/dev/null)"
    if [[ -n "$cid" ]] && docker exec "$cid" node -e "fetch('http://127.0.0.1:8879/healthz',{headers:{authorization:'Bearer '+process.env.BRIDGE_API_KEY},signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# Own session/process identities; never signal an unrelated/reused PID.
# stdout/stderr of both proxies are discarded: only the encrypted vault stores flows.
process() {
  python3 - "$1" "$RUN" "$CAPTURE_HOME" <<'PY'
import json,os,pathlib,signal,subprocess,sys,time
action,run,home=sys.argv[1:]; run=pathlib.Path(run); home=pathlib.Path(home)
def ident(pid):
    p=pathlib.Path('/proc')/str(pid)
    try:
        fields=(p/'stat').read_text().rsplit(')',1)[1].split()
        if fields[0]=='Z': return None
        return {'pid':pid,'start':fields[19],'exe':os.readlink(p/'exe'),'sid':os.getsid(pid),'cmdline':(p/'cmdline').read_bytes().hex()}
    except (FileNotFoundError,ProcessLookupError): return None
def checked(name):
    path=run/(name+'.process.json')
    if not path.exists(): return None
    saved=json.loads(path.read_text()); current=ident(saved['pid'])
    if current is None: return None
    if current!=saved or current['sid']!=current['pid']: raise RuntimeError('Process identity changed; refusing signal')
    return current
def launch(name,args,env):
    p=subprocess.Popen(args,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,close_fds=True)
    time.sleep(.4)
    info=ident(p.pid)
    if info is None or info['sid']!=p.pid: raise RuntimeError('Sidecar failed to start')
    (run/(name+'.process.json')).write_text(json.dumps(info))
if action=='start-shim':
    launch('shim',['python3',str(home/'connect_to_socks.py'),'--port','18890','--socks-host','172.30.80.1','--socks-port','11080'],os.environ.copy())
elif action=='start-mitm':
    env=os.environ.copy(); env.update(CAPTURE_ROOT=str(run/'records'),CAPTURE_LABEL='bridge-upstream',CAPTURE_PUBLIC_KEY=str(home/'capture-public.pem'),CAPTURE_STOP_FILE=str(run/'stop'),CAPTURE_STATUS_FILE=str(run/'status.json'))
    launch('mitm',[str(home/'bin/mitmdump'),'--listen-host','127.0.0.1','--listen-port','18889','--mode','upstream:http://127.0.0.1:18890','--set','confdir='+str(home/'ca'),'--set','flow_detail=0','--set','termlog_verbosity=error','-q','-s',str(home/'capture_addon.py')],env)
elif action=='alive':
    sys.exit(0 if checked('shim') and checked('mitm') else 1)
elif action=='stop':
    (run/'stop').touch()
    # The addon observes stop and flushes its final encrypted session record.
    for name in ('mitm','shim'):
        current=checked(name)
        if current is None: continue
        if name=='mitm':
            end=time.monotonic()+4
            while time.monotonic()<end and checked(name): time.sleep(.2)
        for sig,seconds in ((signal.SIGINT,10),(signal.SIGTERM,5),(signal.SIGKILL,2)):
            current=checked(name)
            if current is None: break
            if sig!=signal.SIGINT: (run/'forced-stop').touch()
            os.killpg(current['pid'],sig)
            end=time.monotonic()+seconds
            while time.monotonic()<end and checked(name): time.sleep(.2)
        if checked(name): raise RuntimeError('Sidecar did not stop')
else: raise RuntimeError('Unknown process action')
PY
}

ready() {
  process alive >/dev/null 2>&1 || return 1
  [[ -s "$CAPTURE_HOME/ca/mitmproxy-ca-cert.pem" && -f "$RUN/status.json" ]] || return 1
  python3 - "$RUN/status.json" <<'PY'
import json,socket,sys,time
try:
    s=json.load(open(sys.argv[1])); assert s.get('ready') is True and s.get('failed') is False
    updated=s.get('updated_ns'); assert isinstance(updated,int) and not isinstance(updated,bool)
    age=time.time_ns()-updated; assert 0 <= age <= 5_000_000_000
    for port in (18889,18890):
        with socket.create_connection(('127.0.0.1',port),timeout=1): pass
except (OSError,ValueError,AssertionError): sys.exit(1)
PY
}

rollback() {
  local rc=$?
  (( rc != 0 )) || rc=1
  trap - ERR INT TERM
  [[ ! -f "$RUN/step" ]] || cp -- "$RUN/step" "$RUN/failed-step"
  printf '%s\n' "$rc" >"$RUN/failure-exit-code"
  phase failed
  if [[ -e "$RUN/route-change-attempted" ]]; then
    step rollback-original-route
    if ! base_unchanged || ! compose no up -d --no-build bridge || ! health; then
      phase rollback-required
      printf '%s\n' 'Capture start failed and base restoration needs attention; sidecars kept running.' >&2
      exit 1
    fi
  fi
  touch "$RUN/base-route-restored"
  process stop >/dev/null 2>&1 || { phase cleanup-required; printf '%s\n' 'Capture start failed; base route restored but sidecar cleanup needs attention.' >&2; exit 1; }
  [[ -f "$ACTIVE" && "$(cat "$ACTIVE")" == "$RUN_ID" ]] && rm -f -- "$ACTIVE"
  printf '%s\n' 'Capture start failed; original deployment restored.' >&2
  exit "${rc:-1}"
}

case "$ACTION" in
start)
  [[ ! -e "$ACTIVE" ]] || fail 'A capture run is already active. Stop it before starting another.'
  [[ ! -e "$RUN" ]] || fail 'Run ID already exists; use a new ID to preserve previous records.'
  for file in capture_addon.py capture_vault.py connect_to_socks.py capture-public.pem capture.compose.yml bin/mitmdump; do
    [[ -f "$CAPTURE_HOME/$file" ]] || fail 'A required capture installation file is missing.'
  done
  for port in 18889 18890; do
    [[ -z "$(ss -Hltn "sport = :$port")" ]] || fail 'A capture port is already occupied; no process was changed.'
  done
  # Check the live target before any restart or sidecar mutation.
  [[ -n "$(docker compose --project-directory "$PROJECT_ROOT" --project-name "$PROJECT_NAME" -f "$BASE" ps -q bridge 2>/dev/null)" ]] || fail 'Existing bridge container was not found.'
  idle
  mkdir -m 700 "$RUN" "$RUN/records"
  base_hash >"$RUN/base.sha256"
  dotenv_hash >"$RUN/dotenv.sha256"
  cp -- "$OVERRIDE" "$RUN/capture.compose.yml"
  date -u +'%Y-%m-%dT%H:%M:%SZ' >"$RUN/started-at"
  phase starting
  printf '%s\n' "$RUN_ID" >"$ACTIVE"
  trap rollback ERR INT TERM
  step start-shim
  process start-shim
  step start-mitm
  process start-mitm
  step wait-proxy-ready
  deadline=$((SECONDS + 40))
  until ready; do (( SECONDS < deadline )) || fail 'Capture proxy did not become ready.'; sleep 1; done
  chmod 644 "$CAPTURE_HOME/ca/mitmproxy-ca-cert.pem"
  step verify-original-configuration
  base_unchanged
  step verify-bridge-idle
  idle
  touch "$RUN/route-change-attempted"
  step apply-capture-compose
  compose yes up -d --no-build bridge
  step wait-bridge-health
  health
  step verify-capture-ready
  ready
  phase running
  step running
  trap - ERR INT TERM
  printf '{"run_id":"%s","state":"running","ready":true,"capture_ready":true}\n' "$RUN_ID"
  ;;
stop)
  # A failed start may already have restored and cleaned up this run. Never
  # take over, clear, or signal another run's active state during rollback.
  if [[ ! -e "$ACTIVE" ]]; then
    if [[ ! -e "$RUN" || -f "$RUN/base-route-restored" ]]; then
      printf '{"run_id":"%s","state":"stopped","already_stopped":true,"original_route_restored":true}\n' "$RUN_ID"
      exit 0
    fi
    fail 'Inactive run has no verified restoration marker; inspect before cleanup.'
  fi
  assert_active
  base_unchanged
  idle
  phase restoring
  step restore-original-route
  if ! compose no up -d --no-build bridge || ! health; then
    phase rollback-required
    fail 'Base route restoration failed; capture sidecars remain running.'
  fi
  touch "$RUN/base-route-restored"
  step stop-sidecars
  process stop
  phase stopped
  step stopped
  date -u +'%Y-%m-%dT%H:%M:%SZ' >"$RUN/stopped-at"
  rm -f -- "$ACTIVE"
  printf '{"run_id":"%s","state":"stopped","original_route_restored":true}\n' "$RUN_ID"
  ;;
status)
  [[ -d "$RUN" ]] || fail 'Run ID does not exist.'
  state="$(cat "$RUN/phase")"
  proxy_alive=false; process alive >/dev/null 2>&1 && proxy_alive=true
  capture_ready=false; if [[ "$state" == running ]] && ready >/dev/null 2>&1; then capture_ready=true; fi
  record_count="$(find "$RUN/records" -name events.cap -type f | wc -l)"
  record_bytes="$(find "$RUN/records" -name events.cap -type f -printf '%s\n' | awk '{n+=$1} END {printf "%.0f",n}')"
  printf '{"run_id":"%s","state":"%s","sidecars_alive":%s,"ready":%s,"capture_ready":%s,"vault_count":%s,"encrypted_bytes":%s}\n' "$RUN_ID" "$state" "$proxy_alive" "$capture_ready" "$capture_ready" "$record_count" "$record_bytes"
  ;;
collect)
  [[ -d "$RUN" ]] || fail 'Run ID does not exist.'
  [[ "$(cat "$RUN/phase")" == stopped ]] || fail 'Stop the run before collecting so encrypted files are complete.'
  archive="$CAPTURE_HOME/archives/${RUN_ID}-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  [[ ! -e "$archive" ]] || fail 'Archive name collision; retry after one second.'
  # Do not collect proxy CA keys, process command lines, deployment .env, or OAuth files.
  tar -czf "$archive" -C "$RUN" records phase started-at stopped-at base.sha256 dotenv.sha256 capture.compose.yml
  chmod 600 "$archive"
  printf '%s\n' "$archive"
  ;;
esac
