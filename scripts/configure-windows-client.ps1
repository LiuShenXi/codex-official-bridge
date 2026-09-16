[CmdletBinding()]
param([string]$InstanceRoot, [switch]$DryRun)
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($InstanceRoot)) { $InstanceRoot = Join-Path $projectRoot '.runtime/windows-second' }
$InstanceRoot = [IO.Path]::GetFullPath($InstanceRoot)
$profileRoot = Join-Path $InstanceRoot 'codex'
$connectionPath = Join-Path $profileRoot 'connection.json'
$syncPath = Join-Path $PSScriptRoot 'sync-windows-client-profile.ps1'
$wrapperPath = Join-Path $InstanceRoot 'sync-profile.ps1'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Save-Text([string]$Path, [string]$Value) {
    $temporary = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
    try { [IO.File]::WriteAllText($temporary, $Value, $utf8); Move-Item -LiteralPath $temporary -Destination $Path -Force }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

try {
    if (-not (Test-Path -LiteralPath $syncPath -PathType Leaf)) { throw 'The tracked synchronization script is missing.' }
    # Validate the isolated profile and current TOML before touching its files.
    & $syncPath -InstanceRoot $InstanceRoot -DryRun | Out-Null
    try { $connection = [IO.File]::ReadAllText($connectionPath) | ConvertFrom-Json } catch { throw 'The isolated connection.json could not be read.' }
    $base = [Uri]([string]$connection.base_url)
    $health = New-Object Uri($base, '/healthz')
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $health -Headers @{ Authorization = 'Bearer ' + [string]$connection.api_key } -TimeoutSec 10 -MaximumRedirection 0
        $status = $response.Content | ConvertFrom-Json
    } catch { throw 'The bridge health check failed. No client files were changed.' }
    if ($response.StatusCode -ne 200 -or $status.ready -isnot [bool] -or $status.ready -ne $true -or $status.capabilities.websocket -isnot [bool] -or $status.capabilities.websocket -ne $true -or $status.capabilities.imageGeneration -isnot [bool] -or $status.capabilities.imageGeneration -ne $true) { throw 'The deployed bridge must report ready WebSocket and image-generation capabilities. No client files were changed.' }
    $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'desktop-image-mcp.mjs') -PathType Leaf)) { throw 'The project image MCP script is missing.' }
    $plan = [ordered]@{ dry_run = [bool]$DryRun; instance_root = $InstanceRoot; bridge_ready = $true; enable_websockets = $true; enable_bridge_images = $true; native_image_gen = $false; credentials_printed = $false; changes_global_profiles = $false; restart_performed = $false }
    if ($DryRun) { [pscustomobject]$plan | ConvertTo-Json -Compress; return }

    # Backups inherit the same private instance ACL; never put authentication
    # snapshots into tracked files, public outputs or console diagnostics.
    $backupParent = Join-Path $InstanceRoot 'backups'
    if ((Test-Path -LiteralPath $backupParent) -and ((Get-Item -LiteralPath $backupParent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Private backups must not be redirected through a junction or symbolic link.' }
    $backupRoot = Join-Path $backupParent ('enable-capabilities-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $files = @{
        'connection.json' = $connectionPath
        'config.toml' = (Join-Path $profileRoot 'config.toml')
        'auth.json' = (Join-Path $profileRoot 'auth.json')
        'sync-profile.ps1' = $wrapperPath
    }
    $existed = @{}
    foreach ($name in $files.Keys) {
        $existed[$name] = Test-Path -LiteralPath $files[$name]
        if ($existed[$name]) { Copy-Item -LiteralPath $files[$name] -Destination (Join-Path $backupRoot $name) }
    }
    $oldProcessKey = [Environment]::GetEnvironmentVariable('OPENAI_API_KEY', 'Process')
    $oldProcessBase = [Environment]::GetEnvironmentVariable('OPENAI_BASE_URL', 'Process')
    try {
        $connection | Add-Member -NotePropertyName supports_websockets -NotePropertyValue $true -Force
        $connection | Add-Member -NotePropertyName bridge_images -NotePropertyValue $true -Force
        Save-Text $connectionPath ($connection | ConvertTo-Json -Depth 100)
        $escapedScript = $syncPath.Replace("'", "''")
        $wrapper = "# Generated wrapper: connection.json is the source of connection values.`r`n. '$escapedScript' -InstanceRoot `$PSScriptRoot`r`n"
        Save-Text $wrapperPath $wrapper
        & $syncPath -InstanceRoot $InstanceRoot
    } catch {
        foreach ($name in $files.Keys) {
            if ($existed[$name]) { Copy-Item -LiteralPath (Join-Path $backupRoot $name) -Destination $files[$name] -Force }
            elseif (Test-Path -LiteralPath $files[$name]) { Remove-Item -LiteralPath $files[$name] -Force }
        }
        [Environment]::SetEnvironmentVariable('OPENAI_API_KEY', $oldProcessKey, 'Process')
        [Environment]::SetEnvironmentVariable('OPENAI_BASE_URL', $oldProcessBase, 'Process')
        throw 'Client synchronization failed; the isolated profile files were restored from their private backup.'
    }
    $plan['backup_directory'] = $backupRoot
    $plan['configured'] = $true
    [pscustomobject]$plan | ConvertTo-Json -Compress
} finally { $connection = $null; $response = $null; $status = $null; $oldProcessKey = $null; $oldProcessBase = $null }
