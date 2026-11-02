# 변경된 코드를 GitHub에 올려 Render 클라우드에 자동 배포합니다.
# 사용법: npm run deploy  또는  .\deploy.ps1 "변경 내용 메모"
param([string]$Message = "")

Set-Location $PSScriptRoot

$changes = git status --porcelain
if (-not $changes) {
  Write-Host "변경된 내용이 없습니다. (이미 최신 상태)" -ForegroundColor Yellow
  exit 0
}

if (-not $Message) {
  $Message = "update: " + (Get-Date -Format "yyyy-MM-dd HH:mm")
}

git add -A
git commit -m $Message
git push origin main

if ($LASTEXITCODE -eq 0) {
  Write-Host "GitHub 업로드 완료! 1~3분 후 클라우드에 자동 반영됩니다." -ForegroundColor Green
} else {
  Write-Host "업로드 실패 - 위 오류 메시지를 확인하세요." -ForegroundColor Red
}
