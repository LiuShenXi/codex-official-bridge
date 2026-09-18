# Codex 三点请求采集工具

Windows 控制器同时采集桌面二号的网关入站、网关服务器的官方出站、桌面三号的官方出站。工具用于自有账户和部署的请求差异实验。整个采集周期保留独立批次；停止后恢复该批次启动前的启动脚本与服务器 Compose 路由。

## 本机使用

脚本位置：`C:\WORK-SPACE\codex-official-bridge\scripts\request-capture\capture.ps1`

```powershell
# 每次启动前自动进行本地 TLS + SSE + WebSocket 合成自检，随后重启二号/三号接入采集
.\scripts\request-capture\capture.ps1 start

# 查看三点、应用进程与采集心跳状态，ready=true 才开始实验
.\scripts\request-capture\capture.ps1 status

# 请求完成后停止，正常关闭加密记录，恢复路由并收回服务器档案
.\scripts\request-capture\capture.ps1 stop

# 停止后生成安全 JSON + Markdown 差异报告
.\scripts\request-capture\capture.ps1 report -OutputDirectory '<报告目录>'

# 单独运行合成测试，无真实模型请求
.\scripts\request-capture\capture.ps1 selftest
```

`start` 会重启两个指定测试实例及专用网关。应在上一轮请求完成后运行。原有一号与 VS Code 不参与。重复 start 不会覆盖已有活动批次；先查看 status，再 stop 或排查异常。stop 遇到活动请求会拒绝终止。若持久 WebSocket 仍连接，先正常关闭该测试窗口让连接结束，再 stop。

不需要每次安装。当前机器的配置在 `.runtime/request-capture/capture-config.json`；仅包含路径、SSH 别名、代理地址，没有 API key。支持通过 `-Config` 指定另一个配置。将脚本迁移到新机器时，要安装 Python 3.11.8+（或 3.12+） 与 cryptography/zstandard/brotli，准备 mitmproxy 11.0.2、对应 SSH 部署和隔离的二号/三号，并在新 Windows 用户下生成新 DPAPI 密钥。不要复制 OAuth 登录或将私钥上传服务器。

## 数据与密钥

- `.runtime/request-capture/runs/<批次>/`：本机加密记录、恢复快照、预检证据、取回的服务器密文。
- `.runtime/request-capture/private/capture-private.dpapi`：仅当前 Windows 用户可解封的 RSA 私钥。不要删除，否则既有记录无法解密。
- 服务器 `.runtime-capture/runs/<批次>/`：官方出站密文；服务器只有 RSA 公钥。
- 每个代理使用独立 AES-256-GCM 密钥，RSA-OAEP 封装。认证头、Cookie 和未知字段的原值只写密文；分析器只在内存解密。
- 报告中的请求头值与正文值默认只有长度和 SHA-256；保留字段名、顺序、重复项和类型，能够比较相等性。正常 `response.completed` 中的模型名可显示。
- 文件不会自动删除。长期实验请检查磁盘容量；不得把运行目录或密钥提交进 Git。

## 覆盖范围

保留目标模型路径的完整请求/响应头、有序重复头、请求原始正文、压缩正文、响应流字节、trailers、WebSocket 握手与双向消息、关闭/错误、连接地址、TLS/ALPN 信息和时序。范围是 `chatgpt.com/backend-api/codex` 及其子路径，以及本机 `/v1/responses`、`/v1/responses/compact`、`/v1/models`、`/v1/images/generations`；登录和刷新端点透传，不作为模型请求抓取。

TLS 代理会改变 TLS 对端和握手；HTTP 字段是解析后的有序字段，不是原始 HTTP/2 帧。响应块是 HTTP 实体流回调块，不是 TCP 分段。WebSocket 保存重组后的消息，不保留原始 mask、分片、ping/pong 控制帧和压缩帧字节。请求缓冲、加密和同步落盘会增加时延，因此不能用本工具证明原始网络指纹或无采集时的延迟完全相同。

原始压缩数据始终保存；gzip/deflate/zstd/brotli 的字段解析取决于分析环境依赖。解码失败会报告，不能冒充字段完全相同。完整性判断要求认证解密成功、顺序连续、各流终态与 session_end；硬杀进程、断电或文件截断都必须视为不完整。活动会话的中间记录不是最终报告。

自动配对只提供候选，依据用户输入指纹和出现次序；两边应使用相同提示词、模型、推理强度与工具权限。账户、出口、请求协议、配置、上下文、工具目录仍可能不同。复用 WebSocket 的后续请求也会全部记录，但逐轮对应需核对消息序列。不能仅凭一次结果或模型请求字段认定模型身份和差异因果。

## 恢复与排错

首选 `stop`，它先恢复服务器路由，再关闭采集代理，避免服务器指向已停止的代理。启动失败会尝试相同回滚；恢复失败保留状态以便继续处理。若用户在采集期间改过相关启动脚本，工具拒绝覆盖其新改动。

独立远端控制器：`bash /opt/codex-official-bridge/.runtime-capture/remote_capture.sh status <批次>`，以及 `stop <批次>`。只处理自己的活动批次。服务器原 Compose 和 `.env` 有哈希保护；检测到更改时需人工核对后恢复。不要直接杀掉代理或删除活动状态。

不安装全系统根证书。三号的 `CODEX_CA_CERTIFICATE` 和代理只设置在该实例启动环境；服务器 CA 只读挂载到专用网关。二号入口仍为原 `127.0.0.1:8879`，临时经采集代理转到 SSH 的 `18879`。所有采集端口仅绑定回环。

## 项目入口与开发

在项目根目录可用 `npm run capture -- status`，其他动作同理。离线测试入口是 `npm run test:capture`，只验证加密存储与分析逻辑，不操作活动代理；`capture selftest` 还会启动独立的本机合成服务。两者都不会发送真实模型推理请求。

首次迁移可参考 `capture-config.example.json`，将占位符替换为绝对路径后保存到 `.runtime/request-capture/capture-config.json`，不要直接覆盖已配置文件。JSON 不会自动展开环境变量或相对路径。`python -m pip install -r scripts/request-capture/requirements.txt` 安装控制器与分析依赖；mitmdump 使用单独的 11.0.2 便携程序。当前脚本适配本文的固定端口、Windows 启动器和 Linux Compose 拓扑，首次搭建仍需准备对应的隔离配置、SSH 与远端公钥采集组件。

源码模块：`capturectl.py` 管理 Windows 生命周期；`capture_addon.py` 和 `capture_vault.py` 采集并加密；`remote_capture.sh`、`capture.compose.yml`、`connect_to_socks.py` 管理服务器采集；`analyze_capture.py` 输出安全报告；`selftest_*.py`、`verify_selftest.py` 与 `test_*.py` 提供验证。`keys.py` 生成并以 DPAPI 保护本机私钥；只将生成的公钥部署到服务器。

实际运行目录、私钥、证书、日志、Python 缓存和配置均通过 Git ignore 排除。任何采集协议升级应在一轮结束后同步本机及服务器，避免在活动批次混用格式。

## 新机器的首次准备

当前工作台已经完成安装，重复实验直接 start/status/stop/report 即可。新机器不能仅复制源码后直接 start：

1. 准备 Python 3.11.8+、上述依赖和 mitmproxy 11.0.2。Python 下限来自安全解包的 `tarfile.extractall(filter='data')`；不要改成不受限解包。
2. 准备已有且独立的二号/三号 profile 与启动器，再配置示例 JSON。工具不会复制 OAuth 登录，也不会自动创建这些桌面实例。
3. 在私有运行目录生成密钥，并将整个运行目录的 ACL 限制为当前用户和 SYSTEM。例如在项目根目录运行（`$python` 指向实际解释器）：

```powershell
$captureData = Join-Path (Get-Location) '.runtime\request-capture'
New-Item -ItemType Directory -Force -Path $captureData | Out-Null
$captureSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $captureData /inheritance:r /grant:r ('*'+$captureSid+':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F'
& $python .\scripts\request-capture\keys.py (Join-Path $captureData 'private')
```

4. 服务器需要现有 bridge Compose 部署、root SSH 管理能力，以及 bash、Python 3、Docker Compose、curl、ss、flock、sha256sum 和 tar。准备独立的 Linux `bin/mitmdump`，上传 `capture_addon.py`、`capture_vault.py`、`connect_to_socks.py`、`probe_remote.py`、`remote_capture.sh`、`capture.compose.yml` 和生成的 **capture-public.pem**。禁止上传 `capture-private.dpapi`。远端目录使用 0700；控制脚本管理该目录内的 CA 和录制。
5. 运行 `npm run test:capture` 和 `npm run capture -- selftest`，再启动三处采集；只有 status 返回 ready=true 才开始正式对照请求。

当前拓扑固定为服务器项目 `/opt/codex-official-bridge`、采集目录 `.runtime-capture`、Compose 项目名 `codex-official-bridge`、SOCKS `172.30.80.1:11080`，本机三号原有 HTTP CONNECT 代理 `127.0.0.1:7897`。配置里的 `remote_root` 仅定位脚本，不会自动修改远端 `CAPTURE_HOME` / `CAPTURE_PROJECT_ROOT` 或其他固定假设。迁移不同拓扑时需同步控制脚本、部署及探针，不应声称任意环境一键可用。

`report` 处理当前状态文件指向的最近批次；历史批次可显式运行分析器：

```powershell
& $python .\scripts\request-capture\analyze_capture.py --root '<历史批次目录>' --key-file '<对应 capture-private.dpapi>' --output '<安全报告基名>'
```
# macOS / Sub2API comparison

The addon also supports explicit reverse-proxy upstream hosts through
`CAPTURE_ALLOWED_HOSTS` (comma-separated). Only the existing model API routes
are captured on those hosts; unrelated authentication routes remain excluded.
Reverse proxies rewrite destination host/authority and introduce additional
transport overhead. Do not attribute those effects to Sub2API.

The analyzer accepts owner-only PEM private keys on macOS/Linux, in addition
to Windows DPAPI keys. Keep the private key on the analysis machine and deploy
only its public key to capture servers. `--labels direct-bridge
sub2api-inbound sub2api-outbound` selects the expected observation points.
Pairing by prompt hash is only a candidate match, not proof of causality.

The temporary, installed September 17 desktop 2/3 topology and recovery steps
are documented in `docs/chain-capture-20260917.md` at the repository root.
