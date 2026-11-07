# 백그라운드로 실행 중인 식단관리표 서버와 LTE 터널(cloudflared)을 종료합니다.
$port = 3000
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
  if ($proc.ParentProcessId) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($proc.ParentProcessId)"
    if ($parent -and $parent.Name -eq 'node.exe') {
      Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
  Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
}

Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "서버와 터널을 종료했습니다."
