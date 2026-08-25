# Rebuilds the dsh-android payload coherently from the CURRENT upstream checkout.
# This IS the update procedure (PLAN.md Q1): never mix payload halves across
# upstream versions — rebuild the whole chain or not at all.
#
# Steps: fresh worktree at HEAD -> copy built outputs -> stage manifests ->
# pack tarballs -> pnpm deploy -> peer/source hoisting -> androidize -> zip.
$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot
$Upstream = 'E:\code\deepseek-harness'
$Asm = Join-Path $RepoRoot 'assembly'

Write-Host "== upstream state =="
Set-Location $Upstream
git log --oneline -1
$status = git status --porcelain
if ($status) { Write-Host "NOTE: upstream dirty:"; $status | Select-Object -First 5 }

Write-Host "== [1/7] fresh worktree at HEAD =="
$wt = Join-Path $Asm 'worktree'
git worktree remove $wt --force 2>$null
if (Test-Path $wt) { Remove-Item $wt -Recurse -Force }
# NOTE: no 2>&1 here — PS5.1 promotes git's stderr progress lines into
# terminating errors under $ErrorActionPreference='Stop'.
git worktree add --detach --quiet $wt HEAD
if ($LASTEXITCODE -ne 0) { throw 'worktree add failed' }

Write-Host "== [2/7] copy build outputs (preserves mtimes) =="
$copied = 0
$targets = @()
foreach ($pkg in (Get-ChildItem "$Upstream\apps" -Directory)) { $targets += $pkg.FullName }
foreach ($group in (Get-ChildItem "$Upstream\packages" -Directory)) {
  foreach ($pkg in (Get-ChildItem $group.FullName -Directory)) { $targets += $pkg.FullName }
}
foreach ($vendor in (Get-ChildItem "$Upstream\vendor" -Directory)) {
  foreach ($pkg in (Get-ChildItem $vendor.FullName -Directory)) { $targets += $pkg.FullName }
}
foreach ($pkgDir in $targets) {
  $rel = $pkgDir.Substring("$Upstream\".Length)
  foreach ($artifact in 'lib', 'dist') {
    $src = Join-Path $pkgDir $artifact
    if (Test-Path $src) {
      $dst = Join-Path $wt "$rel\$artifact"
      New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
      robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
      $copied++
    }
  }
}
# landlock entry ships separately
$llEntry = Join-Path $Upstream 'native\landlock-run\packages\entry'
if (Test-Path "$llEntry\lib") {
  robocopy $llEntry (Join-Path $wt 'native\landlock-run\packages\entry') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
}
Write-Host "copied $copied artifact trees"
if (-not (Test-Path "$wt\apps\cli\lib\bin.js")) { throw 'worktree missing apps/cli/lib/bin.js' }

Write-Host "== [3/7] stage manifests =="
python (Join-Path $Asm 'stage_worktree.py') $wt ((Get-Content "$Upstream\package.json" -Raw | ConvertFrom-Json).version)

Write-Host "== [4/7] pack tarballs =="
Remove-Item (Join-Path $Asm 'tarballs') -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $Asm 'tarballs') | Out-Null
Set-Location $wt
# PS5.1 + Stop preference turns pnpm's stderr progress into terminating errors;
# relax EAP around the noisy external commands only.
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
pnpm --filter ./vendor/** --filter ./packages/** --filter ./apps/** --filter ./native/landlock-run/packages/entry --recursive pack --pack-destination (Join-Path $Asm 'tarballs') 2>&1 | Select-Object -Last 2
$ErrorActionPreference = $savedEap
$count = (Get-ChildItem (Join-Path $Asm 'tarballs') -Filter *.tgz).Count
Write-Host "tarballs: $count"
if ($count -lt 200) { throw "unexpectedly few tarballs: $count" }

Write-Host "== [5/7] pnpm deploy =="
$payloadParent = Join-Path $Asm 'payload'
Remove-Item $payloadParent -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $payloadParent 'dsh') | Out-Null
Set-Location $Upstream
$savedEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
pnpm --filter @deepseek-ai/dsh deploy --legacy --prod (Join-Path $payloadParent 'dsh') 2>&1 | Select-Object -Last 1
$ErrorActionPreference = $savedEap
if (-not (Test-Path (Join-Path $payloadParent 'dsh\lib\bin.js'))) { throw 'deploy missing bin.js' }

Write-Host "== [6/7] complete peers + androidize =="
python (Join-Path $Asm 'complete_peers.py') (Join-Path $payloadParent 'dsh') $Upstream
'{"name":"dsh-android-payload","version":"0.0.0","private":true,"type":"module"}' |
  Set-Content (Join-Path $payloadParent 'dsh\package.json') -Encoding utf8
python (Join-Path $Asm 'androidize_payload.py') (Join-Path $payloadParent 'dsh')

Write-Host "== [7/7] runtime.zip =="
python (Join-Path $Asm 'make_runtime_zip.py') `
  (Join-Path $payloadParent 'dsh') `
  (Join-Path $RepoRoot 'assembly\assets\runtime.zip') `
  (Join-Path $RepoRoot 'patches\android.patch.yml=android.patch.yml') `
  (Join-Path $RepoRoot 'runtime\jniLibs\ca-cert.pem=ca-cert.pem')
Write-Host 'PAYLOAD REBUILD DONE'
