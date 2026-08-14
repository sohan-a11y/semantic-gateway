$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$port = 8787
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  exit 0
}

$requiredVariables = @(
  "SEMANTIC_GATEWAY_TOKEN",
  "SEMANTIC_INTELLIGENCE_PROVIDER",
  "SEMANTIC_INTELLIGENCE_API_KEY",
  "SEMANTIC_INTELLIGENCE_BASE_URL",
  "SEMANTIC_INTELLIGENCE_MODEL"
)

foreach ($name in $requiredVariables) {
  $value = [Environment]::GetEnvironmentVariable($name, "User")
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "$name must be configured as a user environment variable before starting the gateway."
  }
  Set-Item -LiteralPath "Env:$name" -Value $value
}

$nodePath = Join-Path $env:ProgramFiles "nodejs\node.exe"
if (-not (Test-Path -LiteralPath $nodePath)) {
  $nodePath = (Get-Command node.exe).Source
}

$runtimeDirectory = Join-Path $repositoryRoot ".semantic-gateway"
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

Start-Process -FilePath $nodePath -ArgumentList "dist/server.js" -WorkingDirectory $repositoryRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDirectory "server.stdout.log") -RedirectStandardError (Join-Path $runtimeDirectory "server.stderr.log")
