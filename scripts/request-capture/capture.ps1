param(
    [Parameter(Mandatory=$true)][ValidateSet('selftest','start','status','stop','report')][string]$Command,
    [string]$Config,
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if (-not $Config) { $Config = Join-Path $PSScriptRoot '..\..\.runtime\request-capture\capture-config.json' }
$settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
$arguments = @((Join-Path $PSScriptRoot 'capturectl.py'), $Command, '--config', $Config)
if ($OutputDirectory) { $arguments += @('--output', $OutputDirectory) }
& $settings.python @arguments
exit $LASTEXITCODE
