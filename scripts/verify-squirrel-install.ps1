param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [switch]$KeepInstalled
)

$ErrorActionPreference = 'Stop'
$setup = (Resolve-Path -LiteralPath $SetupPath).Path
$installRoot = Join-Path $env:LOCALAPPDATA 'CortexLume'
$appDir = Join-Path $installRoot "app-$Version"
$requiredRuntimeFiles = @(
  'CortexLume.exe',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
  'resources.pak',
  'resources\app.asar',
  'resources\assets\templates\MNI152NLin6Asym\generated\quick_targets\maps.npz',
  'resources\assets\templates\MNI152NLin6Asym\generated\scalp.glb',
  'resources\cortexlume-science\cortexlume-science.exe'
)
$firstRunMarker = Join-Path $env:TEMP "cortexlume-$Version-first-run.txt"

function Assert-Path([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "$Description is missing: $Path"
  }
}

$env:CORTEXLUME_HEADLESS_TEST = '1'
$env:CORTEXLUME_INSTALL_TEST_MARKER = $firstRunMarker
try {
  Remove-Item -LiteralPath $firstRunMarker -Force -ErrorAction SilentlyContinue
  $installer = Start-Process -FilePath $setup -PassThru -Wait
  if ($installer.ExitCode -ne 0) {
    throw "Squirrel Setup exited with code $($installer.ExitCode)."
  }

  $firstRunDeadline = (Get-Date).AddSeconds(20)
  while (-not (Test-Path -LiteralPath $firstRunMarker) -and (Get-Date) -lt $firstRunDeadline) {
    Start-Sleep -Milliseconds 250
  }
  Assert-Path $firstRunMarker 'Automatic first-run launch marker'

  Assert-Path $appDir 'Installed application directory'
  foreach ($relativePath in $requiredRuntimeFiles) {
    Assert-Path (Join-Path $appDir $relativePath) "Installed runtime file '$relativePath'"
  }

  $desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CortexLume.lnk'
  Assert-Path $desktopShortcut 'Desktop shortcut'

  $startMenu = [Environment]::GetFolderPath('StartMenu')
  $startMenuShortcut = Get-ChildItem -LiteralPath $startMenu -Filter 'CortexLume.lnk' -File -Recurse |
    Select-Object -First 1
  if (-not $startMenuShortcut) {
    throw "Start Menu shortcut is missing below: $startMenu"
  }

  $uninstallShortcut = Get-ChildItem -LiteralPath $startMenu -Filter 'Uninstall CortexLume.lnk' -File -Recurse |
    Select-Object -First 1
  if (-not $uninstallShortcut) {
    throw "Start Menu uninstall shortcut is missing below: $startMenu"
  }
  $windowsShell = New-Object -ComObject WScript.Shell
  $uninstallLink = $windowsShell.CreateShortcut($uninstallShortcut.FullName)
  if ($uninstallLink.TargetPath -ne (Join-Path $installRoot 'CortexLume.exe')) {
    throw "Uninstall shortcut targets an unexpected executable: $($uninstallLink.TargetPath)"
  }
  if ($uninstallLink.Arguments -ne '--uninstall-cortexlume') {
    throw "Uninstall shortcut has unexpected arguments: $($uninstallLink.Arguments)"
  }

  $uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CortexLume'
  Assert-Path $uninstallRegistryPath 'Windows Installed apps registration'
  $uninstallRegistration = Get-ItemProperty -LiteralPath $uninstallRegistryPath
  if ($uninstallRegistration.DisplayName -ne 'CortexLume Workstation') {
    throw "Unexpected Installed apps display name: $($uninstallRegistration.DisplayName)"
  }
  if ($uninstallRegistration.UninstallString -notmatch [regex]::Escape((Join-Path $installRoot 'Update.exe'))) {
    throw "Installed apps uninstall command does not target CortexLume Update.exe."
  }

  $application = Start-Process -FilePath (Join-Path $installRoot 'CortexLume.exe') -PassThru -Wait -WindowStyle Hidden
  if ($application.ExitCode -ne 0) {
    throw "Installed CortexLume exited with code $($application.ExitCode)."
  }

  Write-Host "Verified CortexLume $Version installation, runtime, startup, shortcuts, and uninstall entry."
}
finally {
  Remove-Item Env:CORTEXLUME_HEADLESS_TEST -ErrorAction SilentlyContinue
  Remove-Item Env:CORTEXLUME_INSTALL_TEST_MARKER -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $firstRunMarker -Force -ErrorAction SilentlyContinue
  if (-not $KeepInstalled -and (Test-Path -LiteralPath (Join-Path $installRoot 'Update.exe'))) {
    Start-Process -FilePath (Join-Path $installRoot 'Update.exe') -ArgumentList '--uninstall','-s' -Wait -WindowStyle Hidden
    $remainingUninstallShortcut = Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('StartMenu')) `
      -Filter 'Uninstall CortexLume.lnk' -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($remainingUninstallShortcut) {
      throw "Uninstall shortcut remained after removal: $($remainingUninstallShortcut.FullName)"
    }
  }
}
