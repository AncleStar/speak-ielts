$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'data\tools'))
$targetRoot = Join-Path $toolsRoot 'postgres-17'
$archiveFile = Join-Path $toolsRoot 'postgresql-17.10-windows-x64.zip'
$expectedHash = 'F9AAFCA58E7026A1EF2CAEEE711ACF761671E57904D430ADC85F468374F5A821'
$downloadUrl = 'https://get.enterprisedb.com/postgresql/postgresql-17.10-1-windows-x64-binaries.zip'
New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath $archiveFile)) {
  Write-Host '正在从 EDB 下载 PostgreSQL 17 便携客户端（约 334 MB，仅首次需要）…'
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile ($archiveFile + '.partial')
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath ($archiveFile + '.partial')).Hash -ne $expectedHash) { throw '下载校验失败，未安装客户端。' }
  Move-Item -LiteralPath ($archiveFile + '.partial') -Destination $archiveFile
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archiveFile).Hash -ne $expectedHash) { throw '客户端压缩包校验失败，请移走该压缩包后重试。' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipFile = [IO.Compression.ZipFile]::OpenRead($archiveFile)
try {
  foreach ($entry in $zipFile.Entries) {
    if ($entry.FullName -notmatch '^pgsql/(bin/(pg_dump|pg_restore)\.exe|bin/[^/]+\.dll|server_license\.txt|commandlinetools_3rd_party_licenses\.txt)$') { continue }
    $relative = $entry.FullName.Substring('pgsql/'.Length)
    $destination = [IO.Path]::GetFullPath((Join-Path $targetRoot $relative))
    if (-not $destination.StartsWith($targetRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '客户端文件路径错误。' }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
  }
} finally { $zipFile.Dispose() }
foreach ($tool in @('pg_dump','pg_restore')) {
  $executable = Join-Path $targetRoot ('bin\' + $tool + '.exe')
  $versionText = & $executable --version
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '17\.10') { throw ($tool + ' 无法正常运行。') }
  Write-Host $versionText
}
Write-Host '备份客户端已就绪，未安装系统服务。运行 npm run backup 开始备份。'
