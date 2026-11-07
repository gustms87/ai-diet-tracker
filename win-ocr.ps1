param([string]$ImagePath)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  return $netTask.Result
}

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

$lang = New-Object Windows.Globalization.Language("ko")
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
if (-not $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}

function Run-OcrOnFile([string]$PathToRead) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PathToRead)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose()

  $lines = @()
  foreach ($line in $res.Lines) {
    $words = @()
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      $words += @{
        text = $w.Text
        x = [Math]::Round($r.X)
        y = [Math]::Round($r.Y)
        w = [Math]::Round($r.Width)
        h = [Math]::Round($r.Height)
      }
    }
    $lines += @{
      text = $line.Text
      words = $words
    }
  }
  return @{
    fullText = $res.Text
    lines = $lines
  }
}

# 이미지 전처리 (EXIF 회전 보정, 작은 이미지 2배 확대, 색상 반전 패스, 90도 회전 패스)
$srcBmp = [System.Drawing.Bitmap]::FromFile($ImagePath)

# EXIF Orientation 태그(0x0112) 자동 회전 보정
try {
  if ($srcBmp.PropertyIdList -contains 0x0112) {
    $prop = $srcBmp.GetPropertyItem(0x0112)
    $orient = [BitConverter]::ToUInt16($prop.Value, 0)
    if ($orient -eq 6) { $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
    elseif ($orient -eq 3) { $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
    elseif ($orient -eq 8) { $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
  }
} catch {}

# 글자 인식률을 높이기 위해 해상도가 1200px 미만이면 1.8배 확대
$scale = if ([Math]::Max($srcBmp.Width, $srcBmp.Height) -lt 1200) { 1.8 } else { 1.0 }
$newW = [int]([Math]::Round($srcBmp.Width * $scale))
$newH = [int]([Math]::Round($srcBmp.Height * $scale))

$normBmp = New-Object System.Drawing.Bitmap($newW, $newH)
$g = [System.Drawing.Graphics]::FromImage($normBmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($srcBmp, 0, 0, $newW, $newH)
$g.Dispose()

$tmpNorm = "$ImagePath.norm.png"
$normBmp.Save($tmpNorm, [System.Drawing.Imaging.ImageFormat]::Png)

$pass1 = Run-OcrOnFile $tmpNorm
Remove-Item $tmpNorm -ErrorAction SilentlyContinue

$allLines = @($pass1.lines)
$allTexts = @($pass1.fullText)

# 어두운 배경에 흰색/노란색 글씨로 적힌 영양성분표(역상)를 위해 색상 반전(Negative) 이미지도 스캔
$invBmp = New-Object System.Drawing.Bitmap($newW, $newH)
$gInv = [System.Drawing.Graphics]::FromImage($invBmp)
$cm = New-Object System.Drawing.Imaging.ColorMatrix
$cm.Matrix00 = -1; $cm.Matrix11 = -1; $cm.Matrix22 = -1
$cm.Matrix40 = 1;  $cm.Matrix41 = 1;  $cm.Matrix42 = 1
$ia = New-Object System.Drawing.Imaging.ImageAttributes
$ia.SetColorMatrix($cm)
$rect = New-Object System.Drawing.Rectangle(0, 0, $newW, $newH)
$gInv.DrawImage($normBmp, $rect, 0, 0, $newW, $newH, [System.Drawing.GraphicsUnit]::Pixel, $ia)
$gInv.Dispose()
$ia.Dispose()

$tmpInv = "$ImagePath.inv.png"
$invBmp.Save($tmpInv, [System.Drawing.Imaging.ImageFormat]::Png)
$invBmp.Dispose()

$pass2 = Run-OcrOnFile $tmpInv
Remove-Item $tmpInv -ErrorAction SilentlyContinue

if ($pass2.fullText) {
  $allTexts += $pass2.fullText
  $allLines += $pass2.lines
}

# 만약 정방향 스캔에서 영양성분 키워드가 안 나왔다면 90도/270도 회전된 사진인지 추가 확인
$combinedSoFar = ($allTexts -join " ")
if ($combinedSoFar -notmatch "탄수|단백|지방|열량|칼로리|영양|kcal") {
  foreach ($rot in @([System.Drawing.RotateFlipType]::Rotate90FlipNone, [System.Drawing.RotateFlipType]::Rotate180FlipNone)) {
    $normBmp.RotateFlip($rot)
    $tmpRot = "$ImagePath.rot.png"
    $normBmp.Save($tmpRot, [System.Drawing.Imaging.ImageFormat]::Png)
    $passRot = Run-OcrOnFile $tmpRot
    Remove-Item $tmpRot -ErrorAction SilentlyContinue
    if ($passRot.fullText -match "탄수|단백|지방|열량|칼로리|영양|kcal") {
      $allTexts = @($passRot.fullText) + $allTexts
      $allLines = @($passRot.lines) + $allLines
      break
    }
  }
}

$normBmp.Dispose()
$srcBmp.Dispose()

@{
  fullText = ($allTexts -join "`n")
  lines = $allLines
} | ConvertTo-Json -Depth 5 -Compress
