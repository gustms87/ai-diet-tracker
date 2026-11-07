# 식단관리표 서버를 백그라운드(창 없이)로 실행합니다.
# - 이미 실행 중이면 아무것도 하지 않습니다.
# - node --watch 로 실행하므로 server.js / food-db.js 를 수정하면 자동으로 재시작됩니다.
#   (public 폴더의 화면 파일은 브라우저 새로고침만 하면 바로 반영됩니다)
Set-Location $PSScriptRoot

$port = 3000
$running = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($running) {
  Write-Host "이미 실행 중입니다: http://localhost:$port"
  exit 0
}

if (-not (Test-Path "$PSScriptRoot\data")) {
  New-Item -ItemType Directory -Path "$PSScriptRoot\data" | Out-Null
}

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
    Write-Host "서버 시작 완료: http://localhost:$port"
    exit 0
  }
}
Write-Host "서버 시작 실패 - data\server-error.log 를 확인하세요."
exit 1
