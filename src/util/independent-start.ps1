param(
  [string]$Root=(Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$Executable='',
  [string]$Entry=''
)
$ErrorActionPreference='Stop'
if(-not $Executable){$Executable=Join-Path $Root 'node_modules\electron\dist\electron.exe'}
if(-not $Entry){$Entry=$Root}
$logDir=Join-Path $Root 'logs\startup'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$tag=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()+'-'+$PID
$env:LR_STDIO_CHILD='1'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# The scheduled task remains alive until the application exits, so its Windows
# job is not closed while the recorder and FFmpeg processes are still running.
$child=Start-Process -FilePath $Executable -ArgumentList @('"'+$Entry+'"') -WorkingDirectory $Root -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $logDir ('independent-'+$tag+'.out.log')) -RedirectStandardError (Join-Path $logDir ('independent-'+$tag+'.err.log'))
exit $child.ExitCode
