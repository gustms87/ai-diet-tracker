# 식단관리표 서버 + LTE 외부 접속 터널(cloudflared)을 백그라운드(창 없이)로 실행합니다.
# - node --watch 로 실행하므로 server.js / food-db.js 수정 시 자동 재시작됩니다.
Set-Location $PSScriptRoot

if (-not (Test-Path "$PSScriptRoot\data")) {
  New-Item -ItemType Directory -Path "$PSScriptRoot\data" | Out-Null
}

$port = 3000
$running = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $running) {
  $node = (Get-Command node -ErrorAction Stop).Source
  Start-Process -FilePath $node `
    -ArgumentList "--watch", "server.js" `
    -WorkingDirectory $PSScriptRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput "$PSScriptRoot\data\server.log" `
    -RedirectStandardError "$PSScriptRoot\data\server-error.log"

  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
      break
    }
  }
}

# Cloudflare LTE 외부 접속 터널 실행
$cfPath = "$PSScriptRoot\cloudflared.exe"
if (Test-Path $cfPath) {
  $cfRunning = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
  if (-not $cfRunning) {
    Remove-Item "$PSScriptRoot\data\tunnel.log" -ErrorAction SilentlyContinue
    Start-Process -FilePath $cfPath `
      -ArgumentList "tunnel", "--url", "http://localhost:$port", "--no-autoupdate", "--logfile", "$PSScriptRoot\data\tunnel.log" `
      -WorkingDirectory $PSScriptRoot `
      -WindowStyle Hidden
  }
}

Write-Host "서버 시작 완료: http://localhost:$port"
