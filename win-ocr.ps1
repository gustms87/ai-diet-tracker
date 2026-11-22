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

# Pure ASCII Unicode regex (immune to PowerShell 5.1 UTF-8 without BOM CP949 parsing)
# Matches: 탄수|단백|지방|열량|칼로리|영양|당류|나트륨|kcal
$nutriRx = "\uD0C4\uC218|\uB2E8\uBC31|\uC9C0\uBC29|\uC5F4\uB7C9|\uCE7C\uB85C\uB9AC|\uC601\uC591|\uB2F9\uB958|\uB098\uD2B8\uB968|kcal"

function Run-OcrOnFile([string]$PathToRead) {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PathToRead)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  try {
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  } finally {
    $stream.Dispose()
  }

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

function Run-InvertedOcr([System.Drawing.Bitmap]$Bmp, [string]$TmpPath) {
  $w = $Bmp.Width
  $h = $Bmp.Height
  $invBmp = New-Object System.Drawing.Bitmap($w, $h)
  try {
    $gInv = [System.Drawing.Graphics]::FromImage($invBmp)
    $cm = New-Object System.Drawing.Imaging.ColorMatrix
    $cm.Matrix00 = -1; $cm.Matrix11 = -1; $cm.Matrix22 = -1
    $cm.Matrix40 = 1;  $cm.Matrix41 = 1;  $cm.Matrix42 = 1
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $ia.SetColorMatrix($cm)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $gInv.DrawImage($Bmp, $rect, 0, 0, $w, $h, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    $gInv.Dispose()
    $ia.Dispose()
    $invBmp.Save($TmpPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $invBmp.Dispose()
  }
  $res = Run-OcrOnFile $TmpPath
  Remove-Item $TmpPath -ErrorAction SilentlyContinue
  return $res
}

$srcBmp = $null
$normBmp = $null
$allLines = @()
$allTexts = @()

try {
  $srcBmp = [System.Drawing.Bitmap]::FromFile($ImagePath)

  # EXIF Orientation (0x0112) auto-rotation
  try {
    if ($srcBmp.PropertyIdList -contains 0x0112) {
      $prop = $srcBmp.GetPropertyItem(0x0112)
      $orient = [BitConverter]::ToUInt16($prop.Value, 0)
      if ($orient -eq 6) { $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
      elseif ($orient -eq 3) { $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
      elseif ($orient -eq 8) { $srcBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
    }
  } catch {}

  # Upscale low-res images (< 1200px) by 1.8x for crisp small-font recognition
  $scale = if ([Math]::Max($srcBmp.Width, $srcBmp.Height) -lt 1200) { 1.8 } else { 1.0 }
  $newW = [int]([Math]::Round($srcBmp.Width * $scale))
  $newH = [int]([Math]::Round($srcBmp.Height * $scale))

  $normBmp = New-Object System.Drawing.Bitmap($newW, $newH)
  $g = [System.Drawing.Graphics]::FromImage($normBmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($srcBmp, 0, 0, $newW, $newH)
  $g.Dispose()

  # Pass 1: Normal scan
  $tmpNorm = "$ImagePath.norm.png"
  $normBmp.Save($tmpNorm, [System.Drawing.Imaging.ImageFormat]::Png)
  $pass1 = Run-OcrOnFile $tmpNorm
  Remove-Item $tmpNorm -ErrorAction SilentlyContinue

  if ($pass1.fullText) {
    $allTexts += $pass1.fullText
    $allLines += $pass1.lines
  }

  # Pass 2: Inverted scan (for white/light text on dark packages)
  $tmpInv = "$ImagePath.inv.png"
  $pass2 = Run-InvertedOcr $normBmp $tmpInv
  if ($pass2.fullText -and ($pass2.fullText.Trim() -ne ($pass1.fullText + "").Trim())) {
    if (($pass2.fullText -match $nutriRx) -and -not ($pass1.fullText -match $nutriRx)) {
      $allTexts = @($pass2.fullText) + $allTexts
      $allLines = @($pass2.lines) + $allLines
    } else {
      $allTexts += $pass2.fullText
      $allLines += $pass2.lines
    }
  }

  # Pass 3: Rotation fallback (90, 180, 270 deg) if no nutrition keywords detected yet
  $combinedSoFar = ($allTexts -join " ")
  if ($combinedSoFar -notmatch $nutriRx) {
    for ($step = 1; $step -le 3; $step++) {
      $normBmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone)
      $tmpRot = "$ImagePath.rot$step.png"
      $normBmp.Save($tmpRot, [System.Drawing.Imaging.ImageFormat]::Png)
      $passRot = Run-OcrOnFile $tmpRot
      Remove-Item $tmpRot -ErrorAction SilentlyContinue

      if ($passRot.fullText -match $nutriRx) {
        $allTexts = @($passRot.fullText)
        $allLines = @($passRot.lines)
        break
      }

      # Also try inverted on rotated image for dark sideways labels
      $passRotInv = Run-InvertedOcr $normBmp "$ImagePath.rotinv$step.png"
      if ($passRotInv.fullText -match $nutriRx) {
        $allTexts = @($passRotInv.fullText)
        $allLines = @($passRotInv.lines)
        break
      }
    }
  }
} finally {
  if ($normBmp) { $normBmp.Dispose() }
  if ($srcBmp) { $srcBmp.Dispose() }
}

@{
  fullText = ($allTexts -join "`n")
  lines = $allLines
} | ConvertTo-Json -Depth 5 -Compress
