param(
  [string]$WorkspaceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$HarnessModules = 'D:\DHS\.dsh\profiles\node_modules'
)

$ErrorActionPreference = 'Stop'
$nodeModulesRoot = Join-Path $WorkspaceRoot 'node_modules'
$virtualStore = Join-Path $nodeModulesRoot '.pnpm'
if (-not (Test-Path -LiteralPath $virtualStore)) {
  throw "pnpm virtual store is unavailable: $virtualStore"
}

$manifestPaths = @((Join-Path $WorkspaceRoot 'package.json'))
$packageDirectories = Get-ChildItem -LiteralPath (Join-Path $WorkspaceRoot 'packages') -Directory
foreach ($packageDirectory in $packageDirectories) {
  $manifestPath = Join-Path $packageDirectory.FullName 'package.json'
  if (Test-Path -LiteralPath $manifestPath) {
    $manifestPaths += $manifestPath
  }
}

$dependencyNames = @()
foreach ($manifestPath in $manifestPaths) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($null -ne $manifest.dependencies) {
    $dependencyNames += $manifest.dependencies.PSObject.Properties.Name
  }
  if ($null -ne $manifest.devDependencies) {
    $dependencyNames += $manifest.devDependencies.PSObject.Properties.Name
  }
  if ($null -ne $manifest.peerDependencies) {
    $dependencyNames += $manifest.peerDependencies.PSObject.Properties.Name
  }
}
$dependencyNames = $dependencyNames | Where-Object { $_ } | Sort-Object -Unique

$workspacePackages = @{}
foreach ($packageDirectory in $packageDirectories) {
  $manifestPath = Join-Path $packageDirectory.FullName 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    continue
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $workspacePackages[[string]$manifest.name] = $packageDirectory.FullName
}

$linked = 0
$existing = 0
$missing = @()
foreach ($dependencyName in $dependencyNames) {
  $target = $null
  if ($dependencyName.StartsWith('@georesearch/')) {
    $target = $workspacePackages[$dependencyName]
  }
  elseif ($dependencyName.StartsWith('@deepseek-ai/') -or $dependencyName -eq 'react') {
    $candidate = Join-Path $HarnessModules $dependencyName
    if (Test-Path -LiteralPath $candidate) {
      $target = $candidate
    }
  }
  else {
    $encodedName = $dependencyName.Replace('/', '+')
    $candidates = @()
    foreach ($storeDirectory in Get-ChildItem -LiteralPath $virtualStore -Directory) {
      if ($storeDirectory.Name -notlike "$encodedName@*") {
        continue
      }
      $candidate = Join-Path (Join-Path $storeDirectory.FullName 'node_modules') $dependencyName
      if (Test-Path -LiteralPath $candidate) {
        $candidates += $candidate
      }
    }
    if ($candidates.Count -gt 0) {
      $target = @($candidates | Sort-Object {
        try {
          $versionText = (Get-Content -LiteralPath (Join-Path $_ 'package.json') -Raw | ConvertFrom-Json).version
          [version]($versionText -replace '-.*$', '')
        }
        catch {
          [version]'0.0.0'
        }
      } -Descending)[0]
    }
    elseif ($dependencyName -eq 'tesseract.js') {
      $candidate = Join-Path $WorkspaceRoot 'packages\file-service\lib\assets\ocr\node_modules\tesseract.js'
      if (Test-Path -LiteralPath $candidate) {
        $target = $candidate
      }
    }
  }

  if ($null -eq $target -or -not (Test-Path -LiteralPath $target)) {
    $missing += $dependencyName
    continue
  }

  $linkPath = Join-Path $nodeModulesRoot $dependencyName
  New-Item -ItemType Directory -Path (Split-Path -Parent $linkPath) -Force | Out-Null
  if (Test-Path -LiteralPath $linkPath) {
    $existing += 1
    continue
  }
  New-Item -ItemType Junction -Path $linkPath -Target $target | Out-Null
  $linked += 1
}

[pscustomobject]@{
  linked = $linked
  existing = $existing
  missing = $missing
} | ConvertTo-Json -Depth 4
