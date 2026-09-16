param([string]$Python)
$ErrorActionPreference = 'Stop'
if (-not $Python) {
    $configPath = Join-Path $PSScriptRoot '..\..\.runtime\request-capture\capture-config.json'
    if (Test-Path -LiteralPath $configPath) {
        $Python = (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json).python
    } else {
        $Python = (Get-Command python -ErrorAction Stop).Source
    }
}
# These unit tests use temporary synthetic data and do not change active routes.
& $Python -B -m unittest discover -s $PSScriptRoot -p 'test_*.py'
exit $LASTEXITCODE
