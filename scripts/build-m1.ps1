# One-shot M1 pipeline: androidize payload -> zip -> APK -> install -> launch -> wait READY.
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot
$env:JAVA_TOOL_OPTIONS = '-Duser.language=en'

Write-Host '[1/5] androidize payload'
python (Join-Path $RepoRoot 'assembly\androidize_payload.py') (Join-Path $RepoRoot 'assembly\payload\dsh')

Write-Host '[2/5] runtime.zip'
python (Join-Path $RepoRoot 'assembly\make_runtime_zip.py') `
  (Join-Path $RepoRoot 'assembly\payload\dsh') `
  (Join-Path $RepoRoot 'assembly\assets\runtime.zip') `
  (Join-Path $RepoRoot 'patches\android.patch.yml=android.patch.yml') `
  (Join-Path $RepoRoot 'runtime\jniLibs\ca-cert.pem=ca-cert.pem')

Write-Host '[3/5] apk'
pwsh -File (Join-Path $RepoRoot 'scripts\build-apk.ps1') 2>&1 | Select-Object -Last 2

Write-Host '[4/5] install'
adb devices
adb -s emulator-5554 install -r (Join-Path $RepoRoot 'dist\dsh-debug.apk') 2>&1 | Select-Object -Last 1

Write-Host '[5/5] launch + poll'
adb -s emulator-5554 logcat -c
adb -s emulator-5554 shell am start -W -S -n dev.dsh.spike/.MainActivity --es api_key sk-emulator-test-key | Select-String 'Status'
$deadline = (Get-Date).AddMinutes(15)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 10
  $log = adb -s emulator-5554 logcat -d -s dsh-spike | Out-String
  if ($log -match 'READY (http://127\.0\.0\.1:\d+)') {
    # READY alone is not success: post-boot watchers can still kill the tree.
    Start-Sleep -Seconds 15
    $log = adb -s emulator-5554 logcat -d -s dsh-spike | Out-String
    if ($log -match 'node exited|expose-internals|plugin tree failed') { Write-Host 'POST-READY FAILURE:'; break }
    $alive = adb -s emulator-5554 shell "ps -A | grep libnode" | Out-String
    if ($alive.Trim() -ne '') { Write-Host "M1 EMULATOR READY (stable): $($Matches[1])" }
    else { Write-Host 'READY printed but node process gone' }
    break
  }
  if ($log -match 'Cannot find package|Failed to load native module|plugin tree failed') {
    Write-Host 'BOOT FAILURE DETECTED:'
    ($log -split "`n" | Select-String 'Error|Cannot find|native module|failed' | Select-Object -First 6)
    break
  }
}
adb -s emulator-5554 logcat -d -s dsh-spike | Select-Object -Last 6
