[CmdletBinding()]
param([string]$InstanceRoot, [switch]$DryRun)
$ErrorActionPreference = 'Stop'

# Only this isolated instance is generated. connection.json remains the source
# of connection values; no persistent Windows environment setting is changed.
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($InstanceRoot)) { $InstanceRoot = Join-Path $projectRoot '.runtime/windows-second' }
$InstanceRoot = [IO.Path]::GetFullPath($InstanceRoot)
$profileRoot = Join-Path $InstanceRoot 'codex'
$connectionPath = Join-Path $profileRoot 'connection.json'
$configPath = Join-Path $profileRoot 'config.toml'
$authPath = Join-Path $profileRoot 'auth.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Assert-IsolatedPath {
    $regularHome = [Environment]::GetFolderPath('UserProfile')
    foreach ($protected in @((Join-Path $regularHome '.codex'), (Join-Path $regularHome '.codex-vscode'))) {
        foreach ($candidate in @($InstanceRoot, $profileRoot)) {
            if ($candidate.TrimEnd('\', '/') -ieq $protected -or $candidate.StartsWith($protected + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A primary Desktop or VS Code profile cannot be configured by this script.' }
        }
    }
    foreach ($itemPath in @($InstanceRoot, $profileRoot, $connectionPath, $configPath, $authPath)) {
        if (Test-Path -LiteralPath $itemPath) {
            $item = Get-Item -LiteralPath $itemPath -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Instance profile paths must not be symbolic links or junctions.' }
        }
    }
}

function Write-AtomicText([string]$Path, [string]$Value) {
    $temporary = $Path + '.tmp-' + [guid]::NewGuid().ToString('N')
    try { [IO.File]::WriteAllText($temporary, $Value, $utf8); Move-Item -LiteralPath $temporary -Destination $Path -Force }
    finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

# Retain every unmanaged line, including comments, MCP configuration and OTEL.
# Ignore table-like text inside multiline TOML strings. Managed keys use ordinary
# tables; reject conflicting inline/dotted managed forms instead of corrupting them.
function Get-TomlStructure([string[]]$Lines) {
    $state = ''; $tables = @{}; $arrayTables = @{}; $boundaries = @{}; $activeLines = @{}
    for ($lineNumber = 0; $lineNumber -lt $Lines.Length; $lineNumber++) {
        $line = $Lines[$lineNumber]
        if (-not $state) { $activeLines[$lineNumber] = $true }
        if (-not $state -and $line -match '^\s*\[\[([^\[\]]+)\]\]\s*(?:#.*)?$') {
            $name = ($Matches[1].Trim() -replace '"([A-Za-z0-9_-]+)"', '$1') -replace "'([A-Za-z0-9_-]+)'", '$1'
            $arrayTables[$lineNumber] = $name
            $boundaries[$lineNumber] = $true
        } elseif (-not $state -and $line -match '^\s*\[([^\[\]]+)\]\s*(?:#.*)?$') {
            $name = ($Matches[1].Trim() -replace '"([A-Za-z0-9_-]+)"', '$1') -replace "'([A-Za-z0-9_-]+)'", '$1'
            $tables[$lineNumber] = $name
            $boundaries[$lineNumber] = $true
        }
        $single = ''; $escaped = $false
        for ($i = 0; $i -lt $line.Length; $i++) {
            if ($state) {
                if ($i + 2 -lt $line.Length -and $line.Substring($i, 3) -eq $state) { $state = ''; $i += 2 }
                elseif ($state -eq '"""' -and $line[$i] -eq '\') { $i++ }
                continue
            }
            if ($single) {
                if ($single -eq '"' -and -not $escaped -and $line[$i] -eq '\') { $escaped = $true; continue }
                if (-not $escaped -and [string]$line[$i] -eq $single) { $single = '' }
                $escaped = $false; continue
            }
            if ($line[$i] -eq '#') { break }
            if ($line[$i] -eq '"' -or $line[$i] -eq "'") {
                if ($i + 2 -lt $line.Length -and $line.Substring($i, 3) -eq ([string]$line[$i] * 3)) { $state = $line.Substring($i, 3); $i += 2 }
                else { $single = [string]$line[$i] }
            }
        }
    }
    if ($state) { throw 'An unterminated multiline TOML string prevents safe profile synchronization.' }
    return @{ Tables = $tables; ArrayTables = $arrayTables; Boundaries = $boundaries; ActiveLines = $activeLines }
}

function Set-TomlValue([string]$Section, [string]$Key, [string]$Literal, [switch]$OnlyIfMissing) {
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $lines.AddRange([string[]]($script:clientConfig -split '\r?\n'))
    $structure = Get-TomlStructure $lines.ToArray()
    $tables = $structure.Tables
    if ($Section -and $structure.ArrayTables.Values -contains $Section) { throw 'An array table cannot be used for a managed ordinary TOML table.' }
    $matches = @($tables.Keys | Where-Object { $tables[$_] -ceq $Section } | Sort-Object)
    if ($Section -and $matches.Count -gt 1) { throw 'Duplicate managed TOML tables prevent safe synchronization.' }
    $start = 0
    if ($Section) {
        if ($matches.Count -eq 1) { $start = [int]$matches[0] + 1 }
        else { $lines.Add(''); $lines.Add('[' + $Section + ']'); $start = $lines.Count }
    }
    $end = $lines.Count
    foreach ($position in ($structure.Boundaries.Keys | Sort-Object)) { if ([int]$position -ge $start) { $end = [int]$position; break } }
    $found = @()
    for ($i = $start; $i -lt $end; $i++) {
        if ($structure.ActiveLines.ContainsKey($i) -and $lines[$i] -match ('^\s*' + [regex]::Escape($Key) + '\s*=')) {
            $value = ($lines[$i] -split '=', 2)[1].TrimStart()
            if ($value.StartsWith('"""') -or $value.StartsWith("'''")) { throw 'Multiline managed TOML values require manual migration before synchronization.' }
            if ($value.StartsWith('[') -and $value -notmatch '\]\s*(?:#.*)?$') { throw 'Multiline managed TOML arrays require manual migration before synchronization.' }
            $found += $i
        }
    }
    if ($found.Count -gt 1) { throw 'Duplicate managed TOML keys prevent safe synchronization.' }
    if ($found.Count) { if (-not $OnlyIfMissing) { $lines[$found[0]] = $Key + ' = ' + $Literal } }
    else { $lines.Insert($end, $Key + ' = ' + $Literal) }
    $script:clientConfig = $lines -join "`r`n"
}

try {
    Assert-IsolatedPath
    try { $connection = [IO.File]::ReadAllText($connectionPath) | ConvertFrom-Json } catch { throw 'The isolated connection.json could not be read.' }
    if ($null -eq $connection -or [string]::IsNullOrWhiteSpace($connection.api_key) -or [string]$connection.api_key -match '[\r\n]') { throw 'The isolated connection.json requires a nonempty API key.' }
    $uri = $null
    if (-not [Uri]::TryCreate([string]$connection.base_url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -notmatch '^/v1/?$' -or ($uri.Scheme -eq 'http' -and -not $uri.IsLoopback)) { throw 'Use an HTTPS or loopback HTTP bridge /v1 endpoint.' }
    foreach ($field in @('supports_websockets', 'bridge_images')) { if ($connection.PSObject.Properties[$field] -and $connection.$field -isnot [bool]) { throw 'Optional bridge capability fields must be JSON booleans.' } }
    $enableWebSockets = $connection.supports_websockets -eq $true
    $enableImages = $connection.bridge_images -eq $true
    $clientConfig = if (Test-Path -LiteralPath $configPath) { [IO.File]::ReadAllText($configPath) } else { "# Connection fields generated from connection.json.`r`n" }
    $originalConfig = $clientConfig
    if ($clientConfig -match '(?m)^\s*(model_providers|mcp_servers|features)\s*=') { throw 'Inline managed TOML tables require manual migration before synchronization.' }
    if ($clientConfig -match '(?m)^\s*(?:model_providers\.official_bridge|mcp_servers\.bridge_images|features\.(?:code_mode|code_mode_host|enable_request_compression))\s*[.=]') { throw 'Dotted managed TOML keys require manual migration before synchronization.' }
    if ($connection.model) { Set-TomlValue '' 'model' (ConvertTo-Json ([string]$connection.model) -Compress) -OnlyIfMissing }
    if ($connection.model_reasoning_effort) { Set-TomlValue '' 'model_reasoning_effort' (ConvertTo-Json ([string]$connection.model_reasoning_effort) -Compress) -OnlyIfMissing }
    Set-TomlValue '' 'model_provider' '"official_bridge"'
    Set-TomlValue 'model_providers.official_bridge' 'name' '"OpenAI"'
    Set-TomlValue 'model_providers.official_bridge' 'base_url' (ConvertTo-Json ([string]$connection.base_url) -Compress)
    Set-TomlValue 'model_providers.official_bridge' 'wire_api' '"responses"'
    Set-TomlValue 'model_providers.official_bridge' 'requires_openai_auth' 'false'
    Set-TomlValue 'model_providers.official_bridge' 'supports_websockets' ($enableWebSockets.ToString().ToLowerInvariant())
    Set-TomlValue 'model_providers.official_bridge' 'experimental_bearer_token' (ConvertTo-Json ([string]$connection.api_key) -Compress)
    Set-TomlValue 'features' 'enable_request_compression' 'false'
    Set-TomlValue 'features' 'code_mode' 'true'
    Set-TomlValue 'features' 'code_mode_host' 'true'
    $generatedRoot = Join-Path $projectRoot '.runtime/generated-images'
    if ($enableImages) {
        $nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $mcpScript = Join-Path $PSScriptRoot 'desktop-image-mcp.mjs'
        if (-not (Test-Path -LiteralPath $mcpScript -PathType Leaf)) { throw 'The project image MCP script is missing.' }
        $documentsRoot = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Codex'
        $arguments = @($mcpScript, '--profile', $connectionPath, '--output-root', $generatedRoot, '--output-root', 'C:\WORK-SPACE', '--output-root', $documentsRoot)
        Set-TomlValue 'mcp_servers.bridge_images' 'command' (ConvertTo-Json $nodePath -Compress)
        Set-TomlValue 'mcp_servers.bridge_images' 'args' (ConvertTo-Json -InputObject $arguments -Compress)
        Set-TomlValue 'mcp_servers.bridge_images' 'enabled' 'true'
        Set-TomlValue 'mcp_servers.bridge_images' 'tool_timeout_sec' '660'
    } elseif ((Get-TomlStructure ([string[]]($clientConfig -split '\r?\n'))).Tables.Values -contains 'mcp_servers.bridge_images') { Set-TomlValue 'mcp_servers.bridge_images' 'enabled' 'false' }
    if ($DryRun) {
        [pscustomobject]@{ dry_run = $true; instance_root = $InstanceRoot; supports_websockets = $enableWebSockets; bridge_images = $enableImages; config_would_change = ($originalConfig -ne $clientConfig); credentials_printed = $false } | ConvertTo-Json -Compress
        return
    }
    $backupRoot = Join-Path $InstanceRoot 'backups'
    if ((Test-Path -LiteralPath $backupRoot) -and ((Get-Item -LiteralPath $backupRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Private backups must not be redirected through a junction or symbolic link.' }
    if (-not (Test-Path -LiteralPath $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot | Out-Null }
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    if ($originalConfig -ne $clientConfig -and (Test-Path -LiteralPath $configPath)) { Copy-Item -LiteralPath $configPath -Destination (Join-Path $backupRoot ('config-sync-' + $stamp + '.toml')) }
    $auth = @{ auth_mode = 'apikey'; OPENAI_API_KEY = [string]$connection.api_key } | ConvertTo-Json
    if (Test-Path -LiteralPath $authPath) { $oldAuth = [IO.File]::ReadAllText($authPath); if ($oldAuth -ne $auth) { Copy-Item -LiteralPath $authPath -Destination (Join-Path $backupRoot ('auth-sync-' + $stamp + '.json')) } }
    if ($enableImages -and -not (Test-Path -LiteralPath $generatedRoot)) { New-Item -ItemType Directory -Path $generatedRoot | Out-Null }
    Write-AtomicText $configPath $clientConfig
    Write-AtomicText $authPath $auth
    Remove-Item Env:OPENAI_BASE_URL -ErrorAction SilentlyContinue
    $env:OPENAI_API_KEY = [string]$connection.api_key
} finally { $connection = $null; $clientConfig = $null; $originalConfig = $null; $auth = $null; $oldAuth = $null }
