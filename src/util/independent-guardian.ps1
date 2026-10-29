param(
  [string]$Root=(Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$Executable='',
  [string]$Entry=''
)
$ErrorActionPreference='Stop'
if(-not $Executable){$Executable=Join-Path $Root 'node_modules\electron\dist\electron.exe'}
if(-not $Entry){$Entry=$Root}
$dir=Join-Path $Root 'logs\lifecycle'
$pointer=Join-Path $dir 'active-guardian.json'
$logFile=Join-Path $dir 'independent-guardian.log'
function Log([string]$message){try{[IO.File]::AppendAllText($logFile,([DateTime]::UtcNow.ToString('o')+' '+$message+[Environment]::NewLine))}catch{}}
function Read-State { try { $p=Get-Content -LiteralPath $pointer -Raw | ConvertFrom-Json; $s=Get-Content -LiteralPath $p.file -Raw | ConvertFrom-Json; if($s.pid -eq $p.pid -and $s.startedAt -eq $p.startedAt){return $s} }catch{}; return $null }
function Running($s){
  try{$p=Get-Process -Id ([int]$s.pid) -ErrorAction Stop; $started=[DateTimeOffset]::FromUnixTimeMilliseconds([long]$s.startedAt).UtcDateTime; return $p.StartTime.ToUniversalTime() -le $started.AddSeconds(10) -and $p.StartTime.ToUniversalTime() -ge $started.AddMinutes(-2)}catch{return $false}
}
Log 'guardian started'
$restarts=@()
while($true){
  $state=Read-State
  if($null -eq $state){Start-Sleep -Seconds 2;continue}
  if($state.expectedExit){Log ('expected exit pid='+$state.pid);break}
  if(Running $state){Start-Sleep -Seconds 2;continue}
  # Allow state replacement or an intentional-exit write to settle.
  Start-Sleep -Seconds 3
  $current=Read-State
  if($null -eq $current -or $current.pid -ne $state.pid -or $current.startedAt -ne $state.startedAt){continue}
  if($current.expectedExit){break}
  if(Running $current){continue}
  $now=Get-Date;$restarts=@($restarts|Where-Object {($now-$_).TotalMinutes -lt 15})
  if($restarts.Count -ge 3){Log 'restart limit reached';break}
  $restarts+=@($now);Log ('unexpected exit pid='+$state.pid+'; restarting')
  $env:LR_STDIO_CHILD='1'
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  try{Start-Process -FilePath $Executable -ArgumentList @('"'+$Entry+'"') -WorkingDirectory $Root -WindowStyle Hidden | Out-Null}catch{Log ('restart failed: '+$_.Exception.Message);Start-Sleep -Seconds 5;continue}
  $deadline=(Get-Date).AddSeconds(45)
  do{Start-Sleep -Seconds 2;$next=Read-State;if($next -and ($next.pid -ne $state.pid -or $next.startedAt -ne $state.startedAt)){break}}while((Get-Date) -lt $deadline)
}
