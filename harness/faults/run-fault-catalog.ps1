param(
  [string]$ComposeFile = "harness/infra/docker-compose.yml",
  [string]$BaseUrl = "http://127.0.0.1:3000",
  [string]$Root = (Resolve-Path ".").Path
)

$ErrorActionPreference = "Continue"
$LogPath = Join-Path $Root "harness/RUN.log"
$ScenarioRoot = Join-Path $Root "harness/captures/scenarios"
$Script:FaultRunnerBaseUrl = $BaseUrl

function Write-RunLog([string]$Message) {
  Add-Content -LiteralPath $LogPath -Value ("[{0}] {1}" -f (Get-Date -Format o), $Message)
}

function Invoke-Logged([string]$Label, [scriptblock]$Block) {
  Write-RunLog "BEGIN $Label"
  try {
    $output = & $Block 2>&1
    $code = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } else { 0 }
  } catch {
    $output = $_ | Out-String
    $code = 1
  }
  Add-Content -LiteralPath $LogPath -Value ($output | Out-String)
  Write-RunLog "END $Label :: exit=$code"
  [pscustomobject]@{ label = $Label; exitCode = $code; output = ($output | Out-String).Trim() }
}

function Count-Lines([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    return (Get-Content -LiteralPath $Path).Count
  }
  0
}

function Start-Stack {
  Invoke-Logged "fault-runner-compose-up" { docker compose -f $ComposeFile up -d conduit-api enrich-svc }
  Start-Sleep -Seconds 6
}

function Restore-Proxies {
  Invoke-Logged "fault-runner-proxy-list-before-restore" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli list }
  foreach ($proxy in @("postgres-proxy", "redis-proxy", "enrich-proxy")) {
    $inspect = docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli inspect $proxy 2>&1 | Out-String
    if ($inspect -match "enabled:\\s*false") {
      Invoke-Logged "fault-runner-toggle-$proxy-on" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toggle $proxy }
    }
    foreach ($toxic in @("f1_latency", "f1_timeout", "f2_reset", "f6_timeout", "f6_slicer", "f7_timeout")) {
      Invoke-Logged "fault-runner-remove-$proxy-$toxic" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toxic remove -n $toxic $proxy }
    }
  }
}

function Invoke-Http([string]$Method, [string]$Url, [object]$Body = $null, [int]$TimeoutSec = 12) {
  if ($null -eq $Body -or $Body -eq "") {
    & curl.exe -sS -i --max-time $TimeoutSec -X $Method $Url
  } else {
    & curl.exe -sS -i --max-time $TimeoutSec -X $Method -H "Content-Type: application/json" --data-binary $Body $Url
  }
  if ($LASTEXITCODE -ne 0) {
    "curl_exit=$LASTEXITCODE"
  }
}

function Invoke-ApiJson([string]$Method, [string]$Path, [object]$Body = $null, [string]$Token = "", [int]$TimeoutSec = 12) {
  $headers = @{ accept = "application/json" }
  if ($Token -ne "") {
    $headers.authorization = "Token $Token"
  }
  $uri = "$Script:FaultRunnerBaseUrl/api$Path"
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -TimeoutSec $TimeoutSec
  }
  $json = $Body | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -ContentType "application/json" -Body $json -TimeoutSec $TimeoutSec
}

function New-ValidationUserToken([string]$Prefix) {
  $suffix = "{0}-{1}" -f (Get-Date -Format "yyyyMMddHHmmssfff"), ([guid]::NewGuid().ToString("N").Substring(0, 8))
  $user = @{
    username = "$Prefix-$suffix"
    email = "$Prefix-$suffix@example.com"
    password = "Password-$suffix"
  }
  $response = Invoke-ApiJson POST "/users" @{ user = $user } "" 20
  return $response.user.token
}

function Save-Scenario([hashtable]$Scenario, [hashtable]$Before, [array]$Commands) {
  Start-Sleep -Seconds 7
  Restore-Proxies | Out-Null
  $after = @{}
  $dir = Join-Path $ScenarioRoot $Scenario.id
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($svc in @("conduit-api", "enrich-svc")) {
    $file = Join-Path $Root "harness/captures/$svc/events.ndjson"
    $after[$svc] = Count-Lines $file
    if (Test-Path -LiteralPath $file) {
      Copy-Item -LiteralPath $file -Destination (Join-Path $dir "$svc-events.ndjson") -Force
    }
  }
  $manifest = [ordered]@{
    scenario = $Scenario.id
    label = $Scenario.label
    fault = $Scenario.fault
    endpoint = $Scenario.endpoint
    requestsIssued = $Scenario.requestsIssued
    timestamp = Get-Date -Format o
    beforeLineCounts = $Before
    afterLineCounts = $after
    newCaptures = [ordered]@{
      conduitApi = $after["conduit-api"] - $Before["conduit-api"]
      enrichSvc = $after["enrich-svc"] - $Before["enrich-svc"]
    }
    commands = $Commands
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $dir "manifest.json")
  Write-RunLog "SCENARIO $($Scenario.id) complete; new conduit=$($manifest.newCaptures.conduitApi) enrich=$($manifest.newCaptures.enrichSvc)"
  $manifest
}

function Invoke-Scenario([hashtable]$Scenario, [scriptblock]$Action) {
  Write-RunLog "SCENARIO $($Scenario.id) begin: $($Scenario.label)"
  Start-Stack | Out-Null
  Restore-Proxies | Out-Null
  $before = @{}
  foreach ($svc in @("conduit-api", "enrich-svc")) {
    $before[$svc] = Count-Lines (Join-Path $Root "harness/captures/$svc/events.ndjson")
  }
  $commands = @(& $Action)
  Save-Scenario $Scenario $before $commands
}

$scenarios = @()

$scenarios += Invoke-Scenario @{
  id = "F1-db-latency-timeout"
  label = "DB latency and timeout toxic during /api/tags"
  fault = "toxiproxy latency=5000ms+jitter and timeout=1000ms on postgres-proxy"
  endpoint = "GET /api/tags"
  requestsIssued = 1
} {
  Invoke-Logged "F1-add-latency" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toxic add -n f1_latency -t latency -a latency=5000 -a jitter=500 postgres-proxy }
  Invoke-Logged "F1-add-timeout" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toxic add -n f1_timeout -t timeout -a timeout=1000 postgres-proxy }
  Invoke-Logged "F1-request-tags" { Invoke-Http GET "http://127.0.0.1:3000/api/tags" }
}

$scenarios += Invoke-Scenario @{
  id = "F2-db-reset-peer"
  label = "DB connection reset peer during /api/tags"
  fault = "toxiproxy reset_peer toxic on postgres-proxy"
  endpoint = "GET /api/tags"
  requestsIssued = 1
} {
  Invoke-Logged "F2-add-reset" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toxic add -n f2_reset -t reset_peer -a timeout=0 postgres-proxy }
  Invoke-Logged "F2-request-tags" { Invoke-Http GET "http://127.0.0.1:3000/api/tags" }
}

$scenarios += Invoke-Scenario @{
  id = "F3-db-outage"
  label = "Postgres container stopped during /api/tags"
  fault = "docker compose stop postgres, request, docker compose start postgres"
  endpoint = "GET /api/tags"
  requestsIssued = 1
} {
  Invoke-Logged "F3-stop-postgres" { docker compose -f $ComposeFile stop postgres }
  Start-Sleep -Seconds 2
  Invoke-Logged "F3-request-tags" { Invoke-Http GET "http://127.0.0.1:3000/api/tags" }
  Invoke-Logged "F3-start-postgres" { docker compose -f $ComposeFile start postgres }
}

$scenarios += Invoke-Scenario @{
  id = "F4-pool-exhaustion"
  label = "High concurrency DB route with latency toxic"
  fault = "40 concurrent article writes with DB_POOL_MAX=1 while postgres-proxy has 2500ms latency"
  endpoint = "POST /api/articles"
  requestsIssued = 40
} {
  $token = (Invoke-Logged "F4-create-writer-user" { New-ValidationUserToken "f4-writer" }).output.Trim()
  Invoke-Logged "F4-add-latency" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toxic add -n f1_latency -t latency -a latency=2500 -a jitter=250 postgres-proxy }
  Invoke-Logged "F4-parallel-article-writes" {
    $jobs = 1..40 | ForEach-Object {
      $i = $_
      $body = @{
        article = @{
          title = "F4 Pool Exhaustion $i $([guid]::NewGuid().ToString("N"))"
          description = "pool exhaustion validation"
          body = "concurrent database write under toxiproxy latency"
          tagList = @("errorcore", "pool", "f4")
        }
      } | ConvertTo-Json -Depth 12 -Compress
      Start-Job -ArgumentList $Script:FaultRunnerBaseUrl, $token, $body -ScriptBlock {
        param($baseUrl, $authToken, $jsonBody)
        try {
          Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/articles" -Method Post -Headers @{ authorization = "Token $authToken"; accept = "application/json" } -ContentType "application/json" -Body $jsonBody -TimeoutSec 8 | Select-Object -ExpandProperty StatusCode
        } catch {
          $_.Exception.Message
        }
      }
    }
    Wait-Job -Job $jobs -Timeout 35 | Out-Null
    Receive-Job -Job $jobs
    Remove-Job -Job $jobs -Force
  }
}

$scenarios += Invoke-Scenario @{
  id = "F5-redis-disconnect"
  label = "Redis proxy disabled during App-A to App-B enrichment"
  fault = "toxiproxy toggle redis-proxy down"
  endpoint = "GET /api/tags"
  requestsIssued = 1
} {
  Invoke-Logged "F5-disable-redis-proxy" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toggle redis-proxy }
  Invoke-Logged "F5-request-tags" { Invoke-Http GET "http://127.0.0.1:3000/api/tags" }
}

$scenarios += Invoke-Scenario @{
  id = "F6-cross-service-timeout"
  label = "A to B hop timeout through enrich-proxy"
  fault = "toxiproxy timeout toxic on enrich-proxy"
  endpoint = "GET /api/tags"
  requestsIssued = 1
} {
  Invoke-Logged "F6-add-timeout" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toxic add -n f6_timeout -t timeout -a timeout=500 enrich-proxy }
  Invoke-Logged "F6-request-tags" { Invoke-Http GET "http://127.0.0.1:3000/api/tags" }
}

$scenarios += Invoke-Scenario @{
  id = "F7-hostile-valid-traffic"
  label = "Hostile-but-valid request with secrets in query plus downstream Redis outage"
  fault = "deep query/PII request to /api/tags while redis-proxy is disabled"
  endpoint = "GET /api/tags?token=..."
  requestsIssued = 1
} {
  Invoke-Logged "F7-disable-redis-proxy" { docker compose -f $ComposeFile exec -T toxiproxy /toxiproxy-cli toggle redis-proxy }
  $url = "http://127.0.0.1:3000/api/tags?token=F7_TOKEN_SHOULD_NOT_LEAK&email=f7.person@example.com&password=F7_PASSWORD_SHOULD_NOT_LEAK&nested%5B0%5D%5B0%5D=x"
  Invoke-Logged "F7-request-hostile-tags" { Invoke-Http GET $url }
}

$scenarios += Invoke-Scenario @{
  id = "F8-memory-pressure"
  label = "Large valid JSON payload pressure on body parsing and allocation"
  fault = "Concurrent oversized-but-valid JSON user payloads through existing API"
  endpoint = "POST /api/users"
  requestsIssued = 12
} {
  Invoke-Logged "F8-large-json-users" {
    $jobs = 1..12 | ForEach-Object {
      $i = $_
      $suffix = "{0}-{1}" -f $i, ([guid]::NewGuid().ToString("N"))
      $payload = @{
        user = @{
          username = "f8-$suffix"
          email = "f8-$suffix@example.com"
          password = "Password-$suffix"
          bio = ("memory-pressure-" * 7000)
          interests = 1..2500
        }
      } | ConvertTo-Json -Depth 20 -Compress
      Start-Job -ArgumentList $Script:FaultRunnerBaseUrl, $payload -ScriptBlock {
        param($baseUrl, $jsonBody)
        try {
          Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/api/users" -Method Post -Headers @{ accept = "application/json" } -ContentType "application/json" -Body $jsonBody -TimeoutSec 10 | Select-Object -ExpandProperty StatusCode
        } catch {
          $_.Exception.Message
        }
      }
    }
    Wait-Job -Job $jobs -Timeout 30 | Out-Null
    Receive-Job -Job $jobs
    Remove-Job -Job $jobs -Force
  }
}

$out = [ordered]@{
  timestamp = Get-Date -Format o
  scenarios = $scenarios
}
$out | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $Root "harness/checkpoints/05-faults.json")
Write-RunLog "CHECKPOINT 05-faults written to harness/checkpoints/05-faults.json"
$out | ConvertTo-Json -Depth 12
