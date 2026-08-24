# Builds the dsh-android APK without Gradle: javac -> d8 -> aapt2 link (with res) ->
# zip additions (dex, jniLibs, assets) -> zipalign -> apksigner.
# Usage: pwsh -File scripts\build-apk.ps1 [-SkipNativeLibs] [-SkipAssets]
param([switch]$SkipNativeLibs, [switch]$SkipAssets)
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot
$App = Join-Path $RepoRoot 'android-app'
$JniLibs = Join-Path $RepoRoot 'runtime\jniLibs'
$Assets = Join-Path $RepoRoot 'assembly\assets'
$Dist = Join-Path $RepoRoot 'dist'
$Build = Join-Path $App 'build'

$Sdk = $env:ANDROID_HOME
if (-not $Sdk) { $Sdk = 'C:\Android\Sdk' }
$Bt = Join-Path $Sdk 'build-tools\35.0.0'
$PlatformJar = Join-Path $Sdk 'platforms\android-36\android.jar'
foreach ($tool in "$Bt\aapt2.exe", "$Bt\d8.bat", "$Bt\zipalign.exe", "$Bt\apksigner.bat") {
  if (-not (Test-Path $tool)) { throw "missing build tool: $tool" }
}

New-Item -ItemType Directory -Force -Path "$Build\classes", "$Build\dex", "$Build\gen", $Dist | Out-Null

Write-Host '== aapt2 resources =='
$Unsigned = "$Build\app-unsigned.apk"
$linkArgs = @('link', '-o', $Unsigned, '-I', $PlatformJar,
  '--manifest', (Join-Path $App 'AndroidManifest.xml'),
  '--java', "$Build\gen")
if (Test-Path (Join-Path $App 'res')) {
  $ResZip = "$Build\res.zip"
  & "$Bt\aapt2.exe" compile --dir (Join-Path $App 'res') -o $ResZip
  if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }
  $linkArgs += $ResZip
}
& "$Bt\aapt2.exe" @linkArgs
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host '== javac =='
$javaSources = @(Get-ChildItem (Join-Path $App 'java') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
$genSources = @(Get-ChildItem "$Build\gen" -Recurse -Filter '*.java' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
javac -classpath $PlatformJar -d "$Build\classes" ($javaSources + $genSources)
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host '== d8 =='
$classFiles = Get-ChildItem "$Build\classes" -Recurse -Filter '*.class' | ForEach-Object { $_.FullName }
& "$Bt\d8.bat" --release --lib $PlatformJar --output "$Build\dex" $classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host '== zip entries =='
$Stuffed = "$Build\app-stuffed.apk"
$entries = @("classes.dex=$Build\dex\classes.dex")
if (-not $SkipNativeLibs) {
  Get-ChildItem $JniLibs -Directory | ForEach-Object {
    $abi = $_.Name
    Get-ChildItem $_.FullName -Filter 'lib*.so' | ForEach-Object {
      if ($_.Name -like '*manifest*') { return }
      $entries += "lib/$abi/$($_.Name)=$($_.FullName)"
    }
  }
}
if (-not $SkipAssets) {
  foreach ($asset in Get-ChildItem $Assets -File) {
    $entries += "assets/$($asset.Name)=$($asset.FullName)"
  }
}
python (Join-Path $RepoRoot 'assembly\add_to_apk.py') $Unsigned $Stuffed $entries
if ($LASTEXITCODE -ne 0) { throw "zip staging failed" }

Write-Host '== zipalign =='
$Aligned = "$Build\app-aligned.apk"
& "$Bt\zipalign.exe" -f 4 $Stuffed $Aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host '== apksigner =='
$Keystore = Join-Path $RepoRoot 'assembly\debug.keystore'
if (-not (Test-Path $Keystore)) {
  keytool -genkeypair -keystore $Keystore -storepass android -keypass android `
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 `
    -dname 'CN=Android Debug,O=dsh-android,C=US'
  if ($LASTEXITCODE -ne 0) { throw "keytool failed" }
}
$OutApk = Join-Path $Dist 'dsh-debug.apk'
& "$Bt\apksigner.bat" sign --ks $Keystore --ks-pass pass:android --key-pass pass:android --out $OutApk $Aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

& "$Bt\apksigner.bat" verify --print-certs $OutApk | Select-Object -First 2
$size = (Get-Item $OutApk).Length
Write-Host ("`nOK: {0} ({1:N1} MB)" -f $OutApk, ($size / 1MB))
