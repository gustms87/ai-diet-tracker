# 식단관리표 서버 + LTE 외부 접속 터널(cloudflared) 실행 스크립트
# - 이미 해당 포트의 cloudflared 터널이 실행 중이면 절대 재시작하지 않아 외부 주소가 고정 유지됩니다.
# - PC 재부팅 등으로 새 터널이 열릴 때만 텔레그램으로 새 주소를 자동 전송합니다.
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

# 포트 3000 전용 cloudflared 프로세스가 이미 떠 있는지 확인 (떠 있으면 주소 유지를 위해 재시작 안 함)
$cfPath = "$PSScriptRoot\cloudflared.exe"
$cfLog = "$PSScriptRoot\data\tunnel.log"
if (Test-Path $cfPath) {
  $cfProc = Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "localhost:$port" }

  if (-not $cfProc) {
    Remove-Item $cfLog -Force -ErrorAction SilentlyContinue
    Start-Process -FilePath $cfPath `
      -ArgumentList "tunnel", "--url", "http://localhost:$port", "--no-autoupdate", "--logfile", $cfLog `
      -WorkingDirectory $PSScriptRoot `
      -WindowStyle Hidden

    $tunnelUrl = ""
    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Seconds 1
      if (Test-Path $cfLog) {
        $m = Select-String -Path $cfLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches -ErrorAction SilentlyContinue
        if ($m -and $m.Matches.Count -gt 0) {
          $tunnelUrl = $m.Matches[$m.Matches.Count - 1].Value
          break
        }
      }
    }

    $py = "c:\Workspace\telegram-antigravity-bot\.venv\Scripts\python.exe"
    $bridge = "c:\Workspace\telegram-antigravity-bot\telegram_bridge.py"
    if ($tunnelUrl -and (Test-Path $py) -and (Test-Path $bridge)) {
      & $py -X utf8 $bridge reply --text "🥗 [식단관리표] 서버 및 외부 접속 터널이 시작되었습니다!`n👉 모바일 접속: $tunnelUrl`n👉 PC 접속: http://localhost:$port" | Out-Null
    }
  }
}

Write-Host "🥗 식단관리표 서버 실행 완료: http://localhost:$port" -ForegroundColor Green
