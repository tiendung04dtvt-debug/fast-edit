param(
  [Parameter(Mandatory=$true)][int]$RootPid,
  [Parameter(Mandatory=$true)][string]$PidFile,
  [Parameter(Mandatory=$true)][string]$StopFile,
  [Parameter(Mandatory=$true)][string]$OutputFile
)

$ErrorActionPreference = 'SilentlyContinue'
$lastCpuMs = @{}
$cpuDeltaMs = 0.0
$peakCombinedWorkingSet = 0L
$peakNodeWorkingSet = 0L
$peakFfmpegWorkingSet = 0L
$samples = 0
$started = [DateTime]::UtcNow

while (-not (Test-Path -LiteralPath $StopFile)) {
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootPid)
  if (Test-Path -LiteralPath $PidFile) {
    try {
      $snapshot = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
      foreach ($id in $snapshot.ffmpegPids) { if ($id -gt 0) { [void]$ids.Add([int]$id) } }
    } catch {}
  }

  $processes = @()
  foreach ($id in $ids) {
    $process = Get-Process -Id $id
    if ($process) { $processes += $process }
  }
  $rss = 0L
  $nodeRss = 0L
  $ffmpegRss = 0L
  foreach ($process in $processes) {
    $workingSet = [long]$process.WorkingSet64
    $rss += $workingSet
    if ($process.Id -eq $RootPid) { $nodeRss += $workingSet } else { $ffmpegRss += $workingSet }
    $cpuNow = [double]$process.TotalProcessorTime.TotalMilliseconds
    if ($lastCpuMs.ContainsKey($process.Id)) {
      $cpuDeltaMs += [Math]::Max(0, $cpuNow - $lastCpuMs[$process.Id])
    }
    $lastCpuMs[$process.Id] = $cpuNow
  }
  $peakCombinedWorkingSet = [Math]::Max($peakCombinedWorkingSet, $rss)
  $peakNodeWorkingSet = [Math]::Max($peakNodeWorkingSet, $nodeRss)
  $peakFfmpegWorkingSet = [Math]::Max($peakFfmpegWorkingSet, $ffmpegRss)
  $samples++
  Start-Sleep -Milliseconds 50
}

$elapsedMs = ([DateTime]::UtcNow - $started).TotalMilliseconds
[PSCustomObject]@{
  rootPid = $RootPid
  samples = $samples
  elapsedMs = [Math]::Round($elapsedMs, 2)
  peakCombinedWorkingSetBytes = $peakCombinedWorkingSet
  peakNodeWorkingSetBytes = $peakNodeWorkingSet
  peakFfmpegWorkingSetBytes = $peakFfmpegWorkingSet
  sampledCpuMs = [Math]::Round($cpuDeltaMs, 2)
  sampledCpuPercent = if ($elapsedMs -gt 0) { [Math]::Round(($cpuDeltaMs / $elapsedMs) * 100, 2) } else { 0 }
} | ConvertTo-Json -Compress | ForEach-Object {
  [System.IO.File]::WriteAllText($OutputFile, $_, [System.Text.UTF8Encoding]::new($false))
}
