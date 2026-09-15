param([string]$srcPath)
Add-Type -AssemblyName System.Drawing
$bmp=New-Object System.Drawing.Bitmap $srcPath
$c1=0;$c2=0;$c3=0
for($y=0;$y -lt $bmp.Height;$y+=2){ for($x=0;$x -lt $bmp.Width;$x+=2){
  $c=$bmp.GetPixel($x,$y)
  if($c.R -lt 60 -and $c.G -gt 200 -and $c.B -gt 200){$c1++}        # cyan-ish
  if($c.R -gt 200 -and $c.G -lt 60 -and $c.B -gt 200){$c2++}        # magenta-ish
  if($c.R -lt 60 -and $c.G -gt 100 -and $c.B -lt 60){$c3++}         # green-ish (old net)
}}
Write-Output "cyan=$c1 magenta=$c2 green=$c3"
$bmp.Dispose()
