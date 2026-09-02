#Requires -Version 7.0
<#
.SYNOPSIS
  Real-credential end-to-end check for the Microsoft mailbox feature, driven through
  OmniMail's own HTTP API (never Microsoft directly).

.DESCRIPTION
  Steps, in order:
    1. POST /api/auth/token                                  -> Bearer access token
    2. per credential line: POST /api/microsoft/accounts/import { accounts: [one] }
    3. GET  /api/microsoft/accounts                          -> map email -> account id
    4. per account: GET /api/microsoft/messages?accountId=…&refresh=1&limit=50
    5. per -ReadIndexes account: GET /api/microsoft/accounts/{id}/messages/{mid}
       (this call is what marks the message read remotely)
    6. -CheckSubscriptions: GET /api/microsoft/accounts        -> assert pushStatus for
       every Graph-transport account (decision card §12.6 "前端配置"-adjacent row; SKIPs
       cleanly while the account response has no pushStatus field yet)
    7. -ArrivalProbe <index>: baseline the newest local message id for one account, wait
       for a real inbound mail (manual or -TriggerCommand), then poll the local listing
       every 2 s and report seconds-to-arrival (decision card §12.1 / §12.6 "✈ 单封到达")

  Acceptance (decision card §3.4 / §12.6 / recon §6.3):
    - every import item is `accepted`  (`duplicate` passes only with -AllowDuplicate)
    - every listing answers HTTP 200 and `messages` is an ARRAY — an EMPTY array is a
      PASS; most test inboxes are empty
    - every -ReadIndexes account has ≥1 message, the body/html is non-empty and the
      response says `isRead: true` (remote write-back succeeded)
    - with -CheckSubscriptions: every Graph-transport account's `pushStatus` is `active`
      (SKIP, not FAIL, when the field is absent — it ships in a concurrent work package)
    - with -ArrivalProbe: the newest message id changes within 10 s of the mail being
      sent (§12.1's "≤5 s while the page is open" budget, read with a 2 s poll floor)

  Credential file: one account per line, fields separated by `----`. Recognised layouts
  mirror src/features/microsoft/model/microsoft-import.ts:
      email----password----refresh_token----client_id
      email----password----client_id----refresh_token
      email--------refresh_token----client_id
  Exactly one of the last two fields must be a UUID (the Client ID). `email----password`
  is rejected (password auth removed). Blank lines are skipped; a BOM is stripped.

  Indexes (-ReadIndexes) are 1-based positions among the NON-BLANK lines of the file.

  Secrets: emails are masked (`ab***@domain`); passwords, refresh tokens, access tokens
  and the OmniMail bearer token are never written to the console.

  Rate limits respected: the worker allows 50 credential validations / 10 min per
  user+IP (import + verify + folder refresh share it) and 30 s between folder refreshes
  of one account. -DelaySeconds (default 2) is slept between imports.

.EXAMPLE
  pwsh -Command "& scripts/microsoft-graph-e2e.ps1 -CredentialFile D:\x.txt -Email admin@example.com -Password '***' -ReadIndexes @(13,15)"

.EXAMPLE
  pwsh -Command "& scripts/microsoft-graph-e2e.ps1 -BaseUrl https://omni-mail.example.workers.dev -CredentialFile D:\x.txt -Email admin@example.com -Password '***' -ReadIndexes @(13,15) -AllowDuplicate"

  Use -Command (or call from an interactive pwsh), not `pwsh -File`: with -File every
  argument arrives as a string, so `13,15` is not parsed as an int array.

.EXAMPLE
  pwsh -Command "& scripts/microsoft-graph-e2e.ps1 -BaseUrl https://omni-mail.example.workers.dev -CredentialFile D:\x.txt -Email admin@example.com -Password '***' -AllowDuplicate -CheckSubscriptions"

  Re-run against accounts already imported and assert Graph-transport accounts report
  pushStatus=active (requires a deployed Worker with MICROSOFT_GRAPH_WEBHOOK_BASE_URL set).

.EXAMPLE
  pwsh -Command "& scripts/microsoft-graph-e2e.ps1 -BaseUrl https://omni-mail.example.workers.dev -CredentialFile D:\x.txt -Email admin@example.com -Password '***' -AllowDuplicate -ArrivalProbe 13"

  After the baseline snapshot, the script prompts you to send a real mail to account #13,
  then polls the local listing every 2 s and reports how many seconds it took to appear.

.EXAMPLE
  pwsh -Command "& scripts/microsoft-graph-e2e.ps1 -BaseUrl https://omni-mail.example.workers.dev -CredentialFile D:\x.txt -Email admin@example.com -Password '***' -AllowDuplicate -ArrivalProbe 13 -TriggerCommand 'python send-test-mail.py' -ArrivalTimeoutSeconds 90"

  Same as above, but runs -TriggerCommand instead of prompting, and waits up to 90 s.

.NOTES
  Exit code 0 = every row PASS; 1 = at least one FAIL (or a fatal setup error). SKIP rows
  (currently only -CheckSubscriptions when pushStatus is absent) never affect the exit code.
  Outlook-side confirmation (message shows read; deleted mail disappears after the next
  sync) is NOT automated — check it by eye afterwards.
#>
[CmdletBinding()]
param(
  [string] $BaseUrl = 'http://localhost:8788',

  [Parameter(Mandatory)]
  [string] $CredentialFile,

  [Parameter(Mandatory)]
  [string] $Email,

  [Parameter(Mandatory)]
  [string] $Password,

  [string] $MfaCode = '',

  [int[]] $ReadIndexes = @(13, 15),

  [ValidateRange(0, 600)]
  [int] $DelaySeconds = 2,

  [int] $ListLimit = 50,

  # Treat `duplicate` import results (account already connected) as PASS. Useful when
  # re-running against a worker that already holds the accounts.
  [switch] $AllowDuplicate,

  # Send the combination password with persistPasswordConfirmed=true. Off by default:
  # the password never takes part in authentication, so the check does not need it.
  [switch] $PersistPassword,

  # After import, assert pushStatus=active for every Graph-transport account (decision
  # card §12.6). SKIPs cleanly, per account, if the field is not present yet.
  [switch] $CheckSubscriptions,

  # 1-based line index (same numbering as -ReadIndexes) to run the push-arrival timing
  # probe against. 0 (default) disables the probe.
  [int] $ArrivalProbe = 0,

  # Shell command run (via Invoke-Expression) to trigger the test mail for -ArrivalProbe
  # after the baseline snapshot is taken. Omit to be prompted for a manual send instead.
  [string] $TriggerCommand = '',

  # How long -ArrivalProbe polls before giving up. The card's own PASS threshold is a
  # much tighter <=10 s; this only bounds how long the script waits before reporting FAIL.
  [ValidateRange(5, 600)]
  [int] $ArrivalTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BaseUrl = $BaseUrl.TrimEnd('/')
$UuidPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$EmailPattern = '^[^\s@]+@[^\s@]+\.[^\s@]+$'

# ----------------------------------------------------------------------------- helpers

function Mask-Email {
  param([string] $Value)
  if (-not $Value) { return '(none)' }
  $at = $Value.IndexOf('@')
  if ($at -lt 0) { return '***' }
  $local = $Value.Substring(0, $at)
  $domain = $Value.Substring($at + 1)
  $keep = [Math]::Min(2, $local.Length)
  return ('{0}***@{1}' -f $local.Substring(0, $keep), $domain)
}

# Every HTTP call goes through here so status handling and secret hygiene live in one
# place. Returns @{ Status; Body; Headers }. Never throws on 4xx/5xx; throws only on a
# transport failure, whose message carries no request body.
function Invoke-Api {
  param(
    [Parameter(Mandatory)] [ValidateSet('GET', 'POST')] [string] $Method,
    [Parameter(Mandatory)] [string] $Path,
    [object] $Body = $null,
    [string] $Token = '',
    [int] $TimeoutSec = 60
  )
  $headers = @{ Accept = 'application/json' }
  if ($Token) { $headers['Authorization'] = "Bearer $Token" }
  $params = @{
    Method                  = $Method
    Uri                     = "$BaseUrl$Path"
    Headers                 = $headers
    TimeoutSec              = $TimeoutSec
    SkipHttpErrorCheck      = $true
    StatusCodeVariable      = 'status'
    ResponseHeadersVariable = 'respHeaders'
  }
  if ($null -ne $Body) {
    $params['ContentType'] = 'application/json; charset=utf-8'
    $params['Body'] = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }
  $status = 0
  $respHeaders = @{}
  try {
    $body = Invoke-RestMethod @params
  } catch {
    # Do not echo $_ verbatim: PowerShell may embed the request in some failure paths.
    throw ('transport failure calling {0} {1}: {2}' -f $Method, $Path, $_.Exception.GetType().Name)
  }
  return @{ Status = [int] $status; Body = $body; Headers = $respHeaders }
}

function Get-Prop {
  param([object] $Object, [string] $Name)
  if ($null -eq $Object) { return $null }
  $prop = $Object.PSObject.Properties[$Name]
  if ($null -eq $prop) { return $null }
  return $prop.Value
}

# Mirrors parseMicrosoftImportText(): same acceptance, same rejections, same field
# detection. Returns rows with Index, Email, Error (or ClientId/RefreshToken/Password).
function Read-CredentialLines {
  param([string] $Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "credential file not found: $Path" }
  $rows = [System.Collections.Generic.List[hashtable]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new()
  $index = 0
  foreach ($raw in Get-Content -LiteralPath $Path -Encoding utf8) {
    $line = ($raw -replace '^\uFEFF', '').Trim()
    if (-not $line) { continue }
    $index += 1
    # `-split` is regex-based; `----` has no metacharacters, and empty fields are kept
    # (needed for the `email--------refresh_token----client_id` layout).
    [string[]] $fields = $line -split '----'
    $mail = ($fields[0] ?? '').Trim().ToLowerInvariant()
    $row = @{ Index = $index; Email = $mail; Error = ''; ClientId = ''; RefreshToken = ''; Password = '' }
    if ($fields.Count -eq 2) {
      $row.Error = 'password-only login removed; refresh token + Client ID required'
    } elseif ($fields.Count -ne 4) {
      $row.Error = "invalid field count ($($fields.Count)); use the structured form if the password contains ----"
    } elseif ($mail -notmatch $EmailPattern) {
      $row.Error = 'invalid email address'
    } else {
      $oauth = @($fields[2], $fields[3])
      $isUuid = @($oauth | ForEach-Object { $_.Trim() -match $UuidPattern })
      $uuidCount = @($isUuid | Where-Object { $_ }).Count
      if ($uuidCount -ne 1) {
        $row.Error = 'exactly one of the last two fields must be a Client ID UUID'
      } else {
        $clientIdIndex = if ($isUuid[0]) { 0 } else { 1 }
        $row.ClientId = $oauth[$clientIdIndex].Trim().ToLowerInvariant()
        $row.RefreshToken = $oauth[1 - $clientIdIndex]
        $row.Password = $fields[1]
        if (-not $row.RefreshToken) {
          $row.Error = 'OAuth2 layout needs a refresh token'
        } elseif (-not $seen.Add($mail)) {
          $row.Error = 'duplicate email within the file'
        }
      }
    }
    $rows.Add($row)
  }
  return $rows
}

# One line per channel, e.g. "graph: graph_permission_denied (403) …; imap: imap_access_rejected (401) …"
function Format-Attempts {
  param([object] $Attempts)
  if ($null -eq $Attempts) { return '' }
  $parts = foreach ($a in @($Attempts)) {
    '{0}: {1} ({2}) {3}' -f (Get-Prop $a 'transport'), (Get-Prop $a 'code'), (Get-Prop $a 'status'), (Get-Prop $a 'message')
  }
  return ($parts -join '; ')
}

$results = [System.Collections.Generic.List[pscustomobject]]::new()
function Add-Result {
  param([int] $Index, [string] $Email, [string] $Step, [bool] $Pass, [string] $Detail, [switch] $Skip)
  $status = if ($Skip) { 'SKIP' } elseif ($Pass) { 'PASS' } else { 'FAIL' }
  $results.Add([pscustomobject]@{
    Index  = $Index
    Email  = (Mask-Email $Email)
    Step   = $Step
    Result = $status
    Detail = $Detail
  })
  $colour = if ($Skip) { 'Yellow' } elseif ($Pass) { 'Green' } else { 'Red' }
  Write-Host ('[{0}] #{1,-3} {2,-8} {3,-28} {4}' -f $status, $Index, $Step, (Mask-Email $Email), $Detail) -ForegroundColor $colour
}

# ----------------------------------------------------------------------------- 0. parse

Write-Host "Target: $BaseUrl"
$rows = Read-CredentialLines -Path $CredentialFile
Write-Host ("Credential file: {0} non-blank line(s), {1} parse error(s)" -f $rows.Count, @($rows | Where-Object { $_.Error }).Count)
foreach ($row in $rows) {
  if ($row.Error) { Add-Result -Index $row.Index -Email $row.Email -Step 'parse' -Pass $false -Detail $row.Error }
}
$importable = @($rows | Where-Object { -not $_.Error })
if (-not $importable.Count) {
  Write-Host 'Nothing importable; aborting.' -ForegroundColor Red
  exit 1
}

# ----------------------------------------------------------------------------- 1. login

$loginBody = @{ email = $Email; password = $Password; deviceName = 'microsoft-graph-e2e' }
if ($MfaCode) { $loginBody['mfaCode'] = $MfaCode }
$login = Invoke-Api -Method POST -Path '/api/auth/token' -Body $loginBody -TimeoutSec 30
$token = [string] (Get-Prop $login.Body 'accessToken')
if ($login.Status -ne 200 -or -not $token) {
  Write-Host ("Login failed: HTTP {0} {1}" -f $login.Status, (Get-Prop $login.Body 'error')) -ForegroundColor Red
  exit 1
}
Write-Host ("Logged in as {0} (token redacted)" -f (Mask-Email $Email))

$config = Invoke-Api -Method GET -Path '/api/microsoft/accounts' -Token $token -TimeoutSec 30
if ($config.Status -ne 200) {
  Write-Host ("GET /api/microsoft/accounts failed: HTTP {0} {1}" -f $config.Status, (Get-Prop $config.Body 'error')) -ForegroundColor Red
  exit 1
}
if (-not (Get-Prop $config.Body 'enabled')) {
  Write-Host 'Microsoft mail is disabled on this worker (MICROSOFT_MAIL_ENABLED / MICROSOFT_CREDENTIALS_KEY); aborting.' -ForegroundColor Red
  exit 1
}

# ----------------------------------------------------------------------------- 2. import

# email -> account id, filled from import results and the account listing.
$accountIds = @{}
$first = $true
foreach ($row in $importable) {
  if (-not $first -and $DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
  $first = $false

  $account = @{
    email        = $row.Email
    authMode     = 'oauth2'
    refreshToken = $row.RefreshToken
    clientId     = $row.ClientId
    authority    = 'common'
  }
  if ($PersistPassword -and $row.Password) {
    $account['password'] = $row.Password
    $account['persistPasswordConfirmed'] = $true
  }

  $resp = Invoke-Api -Method POST -Path '/api/microsoft/accounts/import' -Body @{ accounts = @($account) } -Token $token -TimeoutSec 120
  $item = $null
  $items = Get-Prop $resp.Body 'results'
  if ($null -ne $items) { $item = @($items)[0] }

  if ($null -eq $item) {
    Add-Result -Index $row.Index -Email $row.Email -Step 'import' -Pass $false -Detail ('HTTP {0} {1} {2}' -f $resp.Status, (Get-Prop $resp.Body 'code'), (Get-Prop $resp.Body 'error'))
    if ($resp.Status -eq 429) {
      $retryAfter = $resp.Headers['Retry-After']
      Write-Host ("Worker rate limit hit (Retry-After: {0}); remaining imports will likely fail too." -f ($retryAfter -join ',')) -ForegroundColor Yellow
    }
    continue
  }

  $status = [string] (Get-Prop $item 'status')
  switch ($status) {
    'accepted' {
      $id = [string] (Get-Prop (Get-Prop $item 'account') 'id')
      if ($id) { $accountIds[$row.Email] = $id }
      Add-Result -Index $row.Index -Email $row.Email -Step 'import' -Pass $true -Detail ('accepted · transport={0}' -f (Get-Prop (Get-Prop $item 'account') 'preferredTransport'))
    }
    'duplicate' {
      Add-Result -Index $row.Index -Email $row.Email -Step 'import' -Pass ([bool] $AllowDuplicate) -Detail $(if ($AllowDuplicate) { 'duplicate (already connected)' } else { 'duplicate — re-run with -AllowDuplicate to accept' })
    }
    default {
      $detail = '{0} {1}' -f (Get-Prop $item 'code'), (Get-Prop $item 'error')
      $attempts = Format-Attempts (Get-Prop $item 'attempts')
      if ($attempts) { $detail += ' [' + $attempts + ']' }
      Add-Result -Index $row.Index -Email $row.Email -Step 'import' -Pass $false -Detail $detail
    }
  }
}

# ----------------------------------------------------------------------------- 3. list accounts

# email -> full account object from the listing, for -CheckSubscriptions below.
$accountObjects = @{}
$listing = Invoke-Api -Method GET -Path '/api/microsoft/accounts' -Token $token -TimeoutSec 30
if ($listing.Status -ne 200) {
  Write-Host ("GET /api/microsoft/accounts failed after import: HTTP {0}" -f $listing.Status) -ForegroundColor Red
} else {
  foreach ($acct in @(Get-Prop $listing.Body 'accounts')) {
    $mail = ([string] (Get-Prop $acct 'email')).ToLowerInvariant()
    $id = [string] (Get-Prop $acct 'id')
    if ($mail -and $id -and -not $accountIds.ContainsKey($mail)) { $accountIds[$mail] = $id }
    if ($mail) { $accountObjects[$mail] = $acct }
  }
}
Write-Host ("Accounts resolvable for listing: {0}/{1}" -f @($importable | Where-Object { $accountIds.ContainsKey($_.Email) }).Count, $importable.Count)

# ----------------------------------------------------------------------------- 4. list messages (refresh=1)

# email -> first message id, for the read step.
$firstMessage = @{}
foreach ($row in $importable) {
  if (-not $accountIds.ContainsKey($row.Email)) {
    Add-Result -Index $row.Index -Email $row.Email -Step 'list' -Pass $false -Detail 'no account id (import failed or account missing from listing)'
    continue
  }
  $id = $accountIds[$row.Email]
  $path = '/api/microsoft/messages?accountId={0}&refresh=1&limit={1}' -f [uri]::EscapeDataString($id), $ListLimit
  $resp = Invoke-Api -Method GET -Path $path -Token $token -TimeoutSec 120
  # `messages` must be an array; an empty array is a PASS (18/20 inboxes are empty).
  # Read the property directly: returning an empty array through a function
  # unrolls it to $null, which would turn every empty inbox into a false FAIL.
  $messagesProp = if ($null -ne $resp.Body) { $resp.Body.PSObject.Properties['messages'] } else { $null }
  $messages = if ($null -ne $messagesProp) { $messagesProp.Value } else { $null }
  $isArray = ($null -ne $messagesProp) -and (
    $null -eq $messages -or $messages -is [System.Array] -or $messages -is [System.Collections.IList])
  if ($resp.Status -eq 200 -and $isArray) {
    $count = @($messages).Count
    if ($count -gt 0) {
      $firstMessage[$row.Email] = [string] (Get-Prop @($messages)[0] 'id')
    }
    $uidv = if ($count -gt 0) { Get-Prop @($messages)[0] 'uidValidity' } else { $null }
    $channelHint = if ($count -eq 0) { '' } elseif ($null -eq $uidv) { ' · graph-shaped rows (uidValidity=null)' } else { ' · imap-shaped rows' }
    Add-Result -Index $row.Index -Email $row.Email -Step 'list' -Pass $true -Detail ('200 · {0} message(s){1}' -f $count, $channelHint)
  } else {
    Add-Result -Index $row.Index -Email $row.Email -Step 'list' -Pass $false -Detail ('HTTP {0} {1} {2}' -f $resp.Status, (Get-Prop $resp.Body 'code'), (Get-Prop $resp.Body 'error'))
  }
}

# ----------------------------------------------------------------------------- 5. read + isRead on selected accounts

foreach ($index in $ReadIndexes) {
  $row = $importable | Where-Object { $_.Index -eq $index } | Select-Object -First 1
  if ($null -eq $row) {
    Add-Result -Index $index -Email '' -Step 'read' -Pass $false -Detail 'index not among importable lines'
    continue
  }
  if (-not $accountIds.ContainsKey($row.Email)) {
    Add-Result -Index $index -Email $row.Email -Step 'read' -Pass $false -Detail 'no account id'
    continue
  }
  if (-not $firstMessage.ContainsKey($row.Email)) {
    Add-Result -Index $index -Email $row.Email -Step 'read' -Pass $false -Detail 'inbox listed empty — this index was expected to hold mail'
    continue
  }
  $id = $accountIds[$row.Email]
  $mid = $firstMessage[$row.Email]
  $path = '/api/microsoft/accounts/{0}/messages/{1}' -f [uri]::EscapeDataString($id), [uri]::EscapeDataString($mid)
  $resp = Invoke-Api -Method GET -Path $path -Token $token -TimeoutSec 60
  $message = Get-Prop $resp.Body 'message'
  $bodyText = [string] (Get-Prop $message 'body')
  $html = [string] (Get-Prop $message 'html')
  $isRead = Get-Prop $message 'isRead'
  $hasBody = ($bodyText.Trim().Length -gt 0) -or ($html.Trim().Length -gt 0)
  if ($resp.Status -eq 200 -and $hasBody -and $isRead -eq $true) {
    Add-Result -Index $index -Email $row.Email -Step 'read' -Pass $true -Detail ('200 · body={0}B html={1}B · isRead=true' -f $bodyText.Length, $html.Length)
  } elseif ($resp.Status -eq 200) {
    $why = @()
    if (-not $hasBody) { $why += 'empty body' }
    if ($isRead -ne $true) { $why += 'isRead!=true (remote write-back not confirmed; S-4 stays open)' }
    Add-Result -Index $index -Email $row.Email -Step 'read' -Pass $false -Detail ('200 but ' + ($why -join ', '))
  } else {
    Add-Result -Index $index -Email $row.Email -Step 'read' -Pass $false -Detail ('HTTP {0} {1} {2}' -f $resp.Status, (Get-Prop $resp.Body 'code'), (Get-Prop $resp.Body 'error'))
  }
}

# ----------------------------------------------------------------------------- 6. -CheckSubscriptions

# Decision card §12.6: assert Graph-transport accounts report pushStatus=active. The
# field ships from a concurrent work package (P2-W4); SKIP cleanly while it is absent
# instead of failing a check the deployed Worker cannot answer yet.
if ($CheckSubscriptions) {
  Write-Host ''
  Write-Host '---- CheckSubscriptions ----'
  $graphRows = @($importable | Where-Object {
    $accountObjects.ContainsKey($_.Email) -and (Get-Prop $accountObjects[$_.Email] 'preferredTransport') -eq 'graph'
  })
  if (-not $graphRows.Count) {
    Write-Host 'No Graph-transport accounts among the imported/listed rows; nothing to check.' -ForegroundColor Yellow
  }
  foreach ($row in $graphRows) {
    $acct = $accountObjects[$row.Email]
    $prop = $acct.PSObject.Properties['pushStatus']
    if ($null -eq $prop) {
      Add-Result -Index $row.Index -Email $row.Email -Step 'subscriptions' -Pass $true -Skip -Detail 'account response has no pushStatus field yet (P2-W4 not merged on this Worker)'
      continue
    }
    $value = [string] $prop.Value
    Add-Result -Index $row.Index -Email $row.Email -Step 'subscriptions' -Pass ($value -eq 'active') -Detail ('pushStatus={0}' -f $value)
  }
}

# ----------------------------------------------------------------------------- 7. -ArrivalProbe

# Decision card §12.1 / §12.6 "✈ 单封到达": time how long a real inbound mail takes to
# reach this Worker's own D1, read locally (no `refresh=1`, so this never forces a Graph
# call). PASS threshold is <=10 s; the poll floor is 2 s so sub-2s arrivals still round up.
if ($ArrivalProbe -gt 0) {
  Write-Host ''
  Write-Host '---- ArrivalProbe ----'
  $row = $importable | Where-Object { $_.Index -eq $ArrivalProbe } | Select-Object -First 1
  if ($null -eq $row) {
    Add-Result -Index $ArrivalProbe -Email '' -Step 'arrival' -Pass $false -Detail 'index not among importable lines'
  } elseif (-not $accountIds.ContainsKey($row.Email)) {
    Add-Result -Index $ArrivalProbe -Email $row.Email -Step 'arrival' -Pass $false -Detail 'no account id'
  } else {
    $id = $accountIds[$row.Email]
    $path = '/api/microsoft/messages?accountId={0}&limit=1' -f [uri]::EscapeDataString($id)
    $baseline = Invoke-Api -Method GET -Path $path -Token $token -TimeoutSec 30
    if ($baseline.Status -ne 200) {
      Add-Result -Index $ArrivalProbe -Email $row.Email -Step 'arrival' -Pass $false -Detail ('baseline read failed: HTTP {0}' -f $baseline.Status)
    } else {
      $baselineMessages = @(Get-Prop $baseline.Body 'messages')
      $baselineId = if ($baselineMessages.Count -gt 0) { [string] (Get-Prop $baselineMessages[0] 'id') } else { $null }
      Write-Host ("Baseline newest message id for #{0}: {1}" -f $ArrivalProbe, $(if ($baselineId) { $baselineId } else { '(none, empty inbox)' }))

      if ($TriggerCommand) {
        Write-Host ("Running trigger command: {0}" -f $TriggerCommand)
        Invoke-Expression $TriggerCommand
      } else {
        Write-Host 'Send a test message to this mailbox now (including Junk Email), then press Enter to start polling...' -ForegroundColor Cyan
        [void] (Read-Host)
      }

      $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
      $arrivedAfterSeconds = $null
      while ($stopwatch.Elapsed.TotalSeconds -lt $ArrivalTimeoutSeconds) {
        Start-Sleep -Seconds 2
        $poll = Invoke-Api -Method GET -Path $path -Token $token -TimeoutSec 30
        if ($poll.Status -eq 200) {
          $polledMessages = @(Get-Prop $poll.Body 'messages')
          $polledId = if ($polledMessages.Count -gt 0) { [string] (Get-Prop $polledMessages[0] 'id') } else { $null }
          if ($polledId -and $polledId -ne $baselineId) {
            $arrivedAfterSeconds = $stopwatch.Elapsed.TotalSeconds
            break
          }
        }
      }
      $stopwatch.Stop()

      if ($null -ne $arrivedAfterSeconds) {
        $seconds = [Math]::Round($arrivedAfterSeconds, 1)
        Add-Result -Index $ArrivalProbe -Email $row.Email -Step 'arrival' -Pass ($arrivedAfterSeconds -le 10) -Detail ('new message visible in D1 after {0}s (2 s poll floor) · PASS threshold <=10s per decision-card §12.1' -f $seconds)
      } else {
        Add-Result -Index $ArrivalProbe -Email $row.Email -Step 'arrival' -Pass $false -Detail ('no new message observed within {0}s' -f $ArrivalTimeoutSeconds)
      }
    }
  }
}

# ----------------------------------------------------------------------------- summary

Write-Host ''
Write-Host '==== Summary ===='
$results | Sort-Object Index, Step | Format-Table -AutoSize -Wrap Index, Email, Step, Result, Detail | Out-String -Width 220 | Write-Host

$failed = @($results | Where-Object { $_.Result -eq 'FAIL' }).Count
$passed = @($results | Where-Object { $_.Result -eq 'PASS' }).Count
$skipped = @($results | Where-Object { $_.Result -eq 'SKIP' }).Count
Write-Host ("PASS {0} · FAIL {1} · SKIP {2}" -f $passed, $failed, $skipped) -ForegroundColor $(if ($failed) { 'Red' } else { 'Green' })
Write-Host 'Manual follow-up (not automated): confirm in Outlook web that the read message shows as read, delete one message there, trigger POST /api/microsoft/accounts/{id}/sync (≥60 s apart) or wait for cron, and confirm it disappears from GET /api/microsoft/messages.'

exit $(if ($failed) { 1 } else { 0 })
