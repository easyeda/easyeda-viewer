param([string]$srcPath,[int]$x0,[int]$x1,[int]$y0,[int]$y1)
Add-Type -AssemblyName System.Drawing
$bmp=New-Object System.Drawing.Bitmap $srcPath
$found=@{}
for($y=$y0;$y -le $y1;$y++){ for($x=$x0;$x -le $x1;$x++){
  $c=$bmp.GetPixel($x,$y)
  if(-not($c.R -gt 240 -and $c.G -gt 240 -and $c.B -gt 240)){
    $k="#{0:X2}{1:X2}{2:X2}" -f $c.R,$c.G,$c.B
    if(-not $found.ContainsKey($k)){$found[$k]=0}
    $found[$k]++
  }
}}
$found.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15 | ForEach-Object { Write-Output "$($_.Key) : $($_.Value)" }
$bmp.Dispose()
