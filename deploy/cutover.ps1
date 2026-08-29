#Requires -Version 7
<#
.SYNOPSIS
  One-shot cutover of recharacter.us from Supabase to qavren-auth + qavren-db + R2.

.DESCRIPTION
  Runs on the operator's machine (needs: aws CLI with the fleet creds, gh, psql,
  the qavren-db checkout with its .env holding QAVREN_DB_PROD_ADMIN_URL). The
  boxes are reached over SSM, the same way qavren-auth/infra/update-realms.ps1
  does it. Steps, in order:

    1. Preflight. Tools present; R2 token proves list+put+get+delete on the
       bucket; the auth box holds RECHARACTER_ADMIN_CLIENT_SECRET; the web box
       .env exists and still carries the values this script must keep
       (ANTHROPIC_API_KEY, AI_KEY_ENCRYPTION_SECRET, TUNNEL_TOKEN).
    2. Rotate the qavren-db prod role password (nothing connects with it yet).
    3. Upsert the web box .env: DATABASE_URL, AUTH_*, QAVREN_*, APP_BASE_URL,
       R2_*; drop the three Supabase vars. The previous file is kept beside it
       as .env.pre-qavren-<stamp> (mode 600) for rollback. The running
       containers keep their old environment until the deploy restarts them.
    4. gh secret set DATABASE_URL_MIGRATE (the deploy's migrate job gate).
    5. gh workflow run deploy.yml on main, watch it, smoke https://recharacter.us/login.

  Ordering matters: the GitHub secret is set LAST, after the box .env is
  complete, because the moment it exists a deploy will recreate the web
  container against whatever .env is on the box.

  Without -Apply only step 1 runs, then the plan is printed. No secret value
  is ever written to the console.

.EXAMPLE
  pwsh deploy/cutover.ps1 -R2AccessKeyId 0123abcd            # preflight + plan
  pwsh deploy/cutover.ps1 -R2AccessKeyId 0123abcd -Apply     # the cutover
  (the R2 secret is prompted for, masked, so it never lands in shell history)
#>
param(
    # R2 API token (Object Read & Write, scoped to the bucket) — dashboard: R2 → Manage API tokens.
    [Parameter(Mandatory)][string]$R2AccessKeyId,
    [string]$R2AccountId = '7c2523de841058b55de07942589f8bf5',
    [string]$R2Bucket = 'recharacter-case-documents',
    [string]$WebInstanceId = 'i-03ba0ecb6f5697d64',   # EC2 Name=Qavren-Web-Server
    [string]$AuthInstanceId = 'i-05374c2270d2ade9b',  # EC2 Name=qavren-auth-prod
    [string]$Region = 'us-east-1',
    [string]$QavrenDbRepo = 'C:\Users\steve\projects\qavren-db',
    [string]$Repo = 'stevenfackley/recharacter',
    [string]$AuthUrl = 'https://auth.recharacter.us',
    [string]$AppUrl = 'https://recharacter.us',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$KeepKeys = @('ANTHROPIC_API_KEY', 'AI_KEY_ENCRYPTION_SECRET', 'TUNNEL_TOKEN')
$DropKeys = @('NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY')
$NewKeys = @(
    'DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL', 'QAVREN_AUTH_URL', 'QAVREN_REALM',
    'QAVREN_ADMIN_CLIENT_ID', 'QAVREN_ADMIN_CLIENT_SECRET', 'APP_BASE_URL',
    'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'
)

function Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "   ok  $Text" -ForegroundColor Green }
function Fail([string]$Text) { Write-Host "   FAIL $Text" -ForegroundColor Red; exit 1 }
function B64([string]$s) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }
function UnB64([string]$s) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }

function Invoke-Box {
    # One SSM RunShellScript; blocks; returns stdout. Mirrors qavren-auth's Invoke-BoxScript.
    param([Parameter(Mandatory)][string]$InstanceId, [Parameter(Mandatory)][string]$Body, [string]$Label = 'command')
    if ($Body.Length -gt 90000) { throw "$Label is $($Body.Length) chars; SSM rejects >~97 KB" }
    $payload = @{
        InstanceIds    = @($InstanceId)
        DocumentName   = 'AWS-RunShellScript'
        TimeoutSeconds = 300
        Parameters     = @{ commands = @($Body) }
    } | ConvertTo-Json -Depth 5
    $tmp = New-TemporaryFile
    try {
        [IO.File]::WriteAllText($tmp.FullName, $payload)
        $cmd = aws ssm send-command --cli-input-json "file://$($tmp.FullName)" --region $Region --output json | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0 -or -not $cmd.Command.CommandId) { Fail "$Label — ssm send-command failed" }
    }
    finally { Remove-Item $tmp -Force }
    $id = $cmd.Command.CommandId
    do {
        Start-Sleep -Seconds 4
        $inv = aws ssm get-command-invocation --command-id $id --instance-id $InstanceId --region $Region --output json | ConvertFrom-Json
    } while ($inv.Status -in @('Pending', 'InProgress', 'Delayed'))
    if ($inv.Status -ne 'Success') {
        Write-Host $inv.StandardOutputContent
        Write-Host $inv.StandardErrorContent
        Fail "$Label — SSM status $($inv.Status)"
    }
    $inv.StandardOutputContent
}

function Invoke-R2 {
    # aws CLI call with the R2 pair mapped onto AWS_* for this child only
    # (qavren-db's Invoke-R2Cli lesson: never export R2 keys as AWS_* globally).
    param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$ArgumentList)
    $savedKey = $env:AWS_ACCESS_KEY_ID; $savedSecret = $env:AWS_SECRET_ACCESS_KEY; $savedTok = $env:AWS_SESSION_TOKEN
    try {
        $env:AWS_ACCESS_KEY_ID = $R2AccessKeyId
        $env:AWS_SECRET_ACCESS_KEY = $script:R2Secret
        $env:AWS_SESSION_TOKEN = $null
        & aws @ArgumentList --region auto --endpoint-url "https://$R2AccountId.r2.cloudflarestorage.com" 2>&1
        return $LASTEXITCODE
    }
    finally {
        $env:AWS_ACCESS_KEY_ID = $savedKey; $env:AWS_SECRET_ACCESS_KEY = $savedSecret; $env:AWS_SESSION_TOKEN = $savedTok
    }
}

function Get-EnvKeys([string]$KeysLine) {
    # "KEYS=a b c" -> @('a','b','c')
    (($KeysLine -split "`n" | Where-Object { $_ -like 'KEYS=*' } | Select-Object -First 1) -replace '^KEYS=', '').Trim() -split '\s+' | Where-Object { $_ }
}

# ---------------------------------------------------------------- 1. preflight
Step 'Preflight: tools and identities'
foreach ($tool in 'aws', 'gh', 'psql') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "$tool not on PATH" }
}
$who = aws sts get-caller-identity --query Arn --output text 2>&1
if ($LASTEXITCODE -ne 0) { Fail "aws credentials: $who" }
Ok "aws as $who"
gh auth status 1>$null 2>&1
if ($LASTEXITCODE -ne 0) { Fail 'gh is not logged in' }
Ok 'gh logged in'

$dbEnvFile = Join-Path $QavrenDbRepo '.env'
if (-not (Test-Path $dbEnvFile)) { Fail "$dbEnvFile missing (needs QAVREN_DB_PROD_ADMIN_URL)" }
# mise exports that .env only in interactive shells opened in that directory;
# load it into this process for the qavren-db module.
foreach ($line in Get-Content $dbEnvFile) {
    if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$') {
        $v = $Matches[2]
        if ($v -match '^"(.*)"$' -or $v -match "^'(.*)'$") { $v = $Matches[1] }
        [Environment]::SetEnvironmentVariable($Matches[1], $v)
    }
}
foreach ($k in 'QAVREN_DB_PROD_ADMIN_URL', 'QAVREN_DB_PROD_POOLER_HOST', 'QAVREN_DB_PROD_PROJECT_REF') {
    if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($k))) { Fail "$k not set in $dbEnvFile" }
}
Import-Module (Join-Path $QavrenDbRepo 'tools/QavrenDb.psm1') -Force
Ok 'qavren-db module + prod target loaded'

Step "Preflight: R2 token can list/put/get/delete in $R2Bucket"
$script:R2Secret = Read-Host -Prompt 'R2_SECRET_ACCESS_KEY (input hidden)' -MaskInput
if ([string]::IsNullOrWhiteSpace($script:R2Secret)) { Fail 'empty R2 secret' }
$probeKey = ".cutover-probe/$([guid]::NewGuid())"
$probeFile = New-TemporaryFile
try {
    [IO.File]::WriteAllText($probeFile.FullName, 'recharacter cutover probe')
    $out = Invoke-R2 s3api list-objects-v2 --bucket $R2Bucket --max-keys 1
    if ($out[-1] -ne 0) { Fail "R2 list failed: $($out[0..($out.Count-2)] -join ' ')" }
    $out = Invoke-R2 s3api put-object --bucket $R2Bucket --key $probeKey --body $probeFile.FullName
    if ($out[-1] -ne 0) { Fail "R2 put failed: $($out[0..($out.Count-2)] -join ' ')" }
    $out = Invoke-R2 s3api head-object --bucket $R2Bucket --key $probeKey
    if ($out[-1] -ne 0) { Fail "R2 get failed: $($out[0..($out.Count-2)] -join ' ')" }
    $out = Invoke-R2 s3api delete-object --bucket $R2Bucket --key $probeKey
    if ($out[-1] -ne 0) { Fail "R2 delete failed: $($out[0..($out.Count-2)] -join ' ')" }
}
finally { Remove-Item $probeFile -Force }
Ok 'R2 list + put + head + delete'

Step 'Preflight: auth box holds RECHARACTER_ADMIN_CLIENT_SECRET'
$authOut = Invoke-Box -InstanceId $AuthInstanceId -Label 'auth box read' -Body @'
set -eu
cd /opt/qavren-auth
v=$(grep -E '^RECHARACTER_ADMIN_CLIENT_SECRET=' .env.prod | head -1 | cut -d= -f2-)
[ -n "$v" ] || { echo MISSING; exit 1; }
printf 'B64:%s\n' "$(printf %s "$v" | base64 -w0)"
'@
$m = [regex]::Match($authOut, 'B64:(\S+)')
if (-not $m.Success) { Fail "auth box: RECHARACTER_ADMIN_CLIENT_SECRET not found in /opt/qavren-auth/.env.prod" }
$adminSecret = UnB64 $m.Groups[1].Value
if ($adminSecret.Length -lt 16) { Fail 'auth box: admin client secret looks too short' }
Ok "admin client secret present ($($adminSecret.Length) chars)"

Step 'Preflight: web box .env'
$webOut = Invoke-Box -InstanceId $WebInstanceId -Label 'web box read' -Body @'
set -eu
d=""
for c in /home/*/recharacter; do [ -f "$c/.env" ] && [ -f "$c/docker-compose.yml" ] && d="$c" && break; done
[ -n "$d" ] || { echo NOENV; exit 1; }
echo "DIR=$d"
echo "IMAGE_TAG=$(grep -E '^IMAGE_TAG=' "$d/.env" | cut -d= -f2-)"
echo "KEYS=$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$d/.env" | tr -d = | sort | tr '\n' ' ')"
'@
$webDir = (($webOut -split "`n" | Where-Object { $_ -like 'DIR=*' } | Select-Object -First 1) -replace '^DIR=', '').Trim()
$prevTag = (($webOut -split "`n" | Where-Object { $_ -like 'IMAGE_TAG=*' } | Select-Object -First 1) -replace '^IMAGE_TAG=', '').Trim()
if (-not $webDir) { Fail 'web box: no ~/recharacter/.env next to a docker-compose.yml' }
$keys = Get-EnvKeys $webOut
$missingKeep = $KeepKeys | Where-Object { $_ -notin $keys }
if ($missingKeep) { Fail "web box .env is missing values this script must keep: $($missingKeep -join ', ')" }
Ok "$webDir/.env — keeps $($KeepKeys -join ', '); currently IMAGE_TAG=$prevTag"
$present = $DropKeys | Where-Object { $_ -in $keys }
Write-Host "   Supabase vars present now: $(if ($present) { $present -join ', ' } else { 'none' })"
$already = $NewKeys | Where-Object { $_ -in $keys }
if ($already) { Write-Host "   already set (will be overwritten): $($already -join ', ')" }

if (-not $Apply) {
    Step 'Dry run — plan'
    Write-Host @"
   1. rotate qavren-db prod role 'recharacter' (provision-app.ps1 -Env prod -Apply -RotatePassword)
   2. $webDir/.env: backup -> .env.pre-qavren-<stamp>; set $($NewKeys -join ', '); drop $($DropKeys -join ', ')
   3. gh secret set DATABASE_URL_MIGRATE -R $Repo
   4. gh workflow run deploy.yml -R $Repo --ref main; watch; smoke $AppUrl/login
   Re-run with -Apply.
"@
    exit 0
}

# ---------------------------------------------------------- 2. rotate the role
Step "Rotate qavren-db prod role 'recharacter'"
$lines = @(Invoke-QavrenProvision -App recharacter -Environment prod -Root $QavrenDbRepo -Apply -RotatePassword 6>&1 |
    ForEach-Object { $_.ToString() })
$sessionUrl = ($lines | Where-Object { $_ -like 'session_url=*' } | Select-Object -First 1) -replace '^session_url=', ''
$poolerUrl = ($lines | Where-Object { $_ -like 'pooler_url=*' } | Select-Object -First 1) -replace '^pooler_url=', ''
if (-not $sessionUrl -or -not $poolerUrl) { Fail "provision did not print both URLs:`n$($lines -join "`n" -replace 'password=\S+', 'password=***')" }
$databaseUrl = "${poolerUrl}?sslmode=require"
$migrateUrl = "${sessionUrl}?sslmode=require"
# Prove the new credential works on both poolers before it goes anywhere.
foreach ($pair in @(@('runtime :6543', $databaseUrl), @('migrate :5432', $migrateUrl))) {
    $r = & psql $pair[1] -X -tA -c 'select current_user' 2>&1
    if ($LASTEXITCODE -ne 0 -or "$r" -notmatch '^recharacter') { Fail "new password rejected on $($pair[0]): $r" }
}
Ok 'rotated; new password accepted on the transaction and session poolers'

# --------------------------------------------------------- 3. write box .env
Step "Write $webDir/.env"
$authSecret = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$block = @(
    "DATABASE_URL=$databaseUrl"
    "AUTH_SECRET=$authSecret"
    "AUTH_URL=$AppUrl"
    "QAVREN_AUTH_URL=$AuthUrl"
    'QAVREN_REALM=recharacter'
    'QAVREN_ADMIN_CLIENT_ID=recharacter-admin-svc'
    "QAVREN_ADMIN_CLIENT_SECRET=$adminSecret"
    "APP_BASE_URL=$AppUrl"
    "R2_ACCOUNT_ID=$R2AccountId"
    "R2_ACCESS_KEY_ID=$R2AccessKeyId"
    "R2_SECRET_ACCESS_KEY=$($script:R2Secret)"
    "R2_BUCKET=$R2Bucket"
) -join "`n"
$stripRe = '^(' + (($DropKeys + $NewKeys) -join '|') + ')='
$writeBody = @'
set -eu
cd "__DIR__"
stamp=$(date +%Y%m%d-%H%M%S)
cp -p .env ".env.pre-qavren-$stamp"; chmod 600 ".env.pre-qavren-$stamp"
{ grep -vE '__STRIP__' .env || true; echo "__B64__" | base64 -d; echo; } > .env.tmp
chown --reference=.env .env.tmp; chmod 600 .env.tmp; mv .env.tmp .env
echo "BACKUP=.env.pre-qavren-$stamp"
echo "KEYS=$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env | tr -d = | sort | tr '\n' ' ')"
'@ -replace '__DIR__', $webDir -replace '__STRIP__', $stripRe -replace '__B64__', (B64 ($block + "`n"))
$wOut = Invoke-Box -InstanceId $WebInstanceId -Label 'web box write' -Body $writeBody
$backup = (($wOut -split "`n" | Where-Object { $_ -like 'BACKUP=*' } | Select-Object -First 1) -replace '^BACKUP=', '').Trim()
$keys = Get-EnvKeys $wOut
$stillDropped = $DropKeys | Where-Object { $_ -in $keys }
$missingNew = ($NewKeys + $KeepKeys) | Where-Object { $_ -notin $keys }
if ($stillDropped -or $missingNew) { Fail "post-write check: still present [$($stillDropped -join ', ')] missing [$($missingNew -join ', ')] — restore with: mv $backup .env" }
Ok ".env rewritten; previous file kept as $backup"

# ------------------------------------------------------------ 4. GH secret
Step 'gh secret set DATABASE_URL_MIGRATE'
$migrateUrl | gh secret set DATABASE_URL_MIGRATE -R $Repo
if ($LASTEXITCODE -ne 0) { Fail 'gh secret set failed (box .env is already rewritten; the old stack keeps running until a deploy)' }
Ok 'secret set'

# ---------------------------------------------------------------- 5. deploy
Step 'Deploy'
gh workflow run deploy.yml -R $Repo --ref main
if ($LASTEXITCODE -ne 0) { Fail 'gh workflow run failed — trigger it from the Actions tab; everything else is in place' }
Start-Sleep -Seconds 8
$runId = $null
for ($i = 0; $i -lt 10 -and -not $runId; $i++) {
    $runId = gh run list -R $Repo --workflow deploy.yml --branch main --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId'
    if (-not $runId) { Start-Sleep -Seconds 5 }
}
if (-not $runId) { Fail 'could not find the dispatched run; watch the Actions tab' }
Write-Host "   run $runId — https://github.com/$Repo/actions/runs/$runId"
gh run watch $runId -R $Repo --exit-status
$deployOk = ($LASTEXITCODE -eq 0)

Step 'Smoke'
foreach ($path in '/api/health', '/login') {
    try { $code = (Invoke-WebRequest -Uri "$AppUrl$path" -MaximumRedirection 0 -SkipHttpErrorCheck -UseBasicParsing).StatusCode } catch { $code = 0 }
    Write-Host "   $AppUrl$path -> $code"
}
if (-not $deployOk) {
    Fail "deploy run $runId did not succeed. Rollback on the box: cd $webDir; mv $backup .env; sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=$prevTag/' .env; docker compose up -d"
}
Write-Host @"

Done. Next (docs/deploy.md smoke checklist): register a test account via $AppUrl/login, upload a DD-214, delete the account from /settings/data.
Rollback (until the old Supabase project is deleted): on the box, mv $backup .env && IMAGE_TAG=$prevTag docker compose up -d
Then: pause Supabase project ldxgdceplsdycviroisd now, delete after 7 days.
"@
