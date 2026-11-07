# 백그라운드로 실행 중인 식단관리표 서버를 종료합니다.
$port = 3000
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
  Write-Host "실행 중인 서버가 없습니다."
  exit 0
}

foreach ($c in $conns) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
  # node --watch 는 부모(감시) 프로세스가 자식(서버)을 띄우므로 부모까지 함께 종료
  if ($proc.ParentProcessId) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)"
    if ($parent -and $parent.Name -eq 'node.exe') {
      Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}
Write-Host "서버를 종료했습니다."
