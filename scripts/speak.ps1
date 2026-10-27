param([Parameter(Mandatory=$true)][string]$InputJson,[Parameter(Mandatory=$true)][string]$OutputWav)
Add-Type -AssemblyName System.Speech
$data = Get-Content -LiteralPath $InputJson -Raw -Encoding UTF8 | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($data.voiceName) { $s.SelectVoice([string]$data.voiceName) }
$s.Rate = 0
$s.Volume = 100
$s.SetOutputToWaveFile($OutputWav)
$s.Speak([string]$data.text)
$s.Dispose()
Remove-Item -LiteralPath $InputJson -Force -ErrorAction SilentlyContinue
