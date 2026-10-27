Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$items = @($s.GetInstalledVoices() | ForEach-Object { $v=$_.VoiceInfo; [PSCustomObject]@{name=$v.Name; culture=$v.Culture.Name; gender=$v.Gender.ToString()} })
$items | ConvertTo-Json -Compress
$s.Dispose()
