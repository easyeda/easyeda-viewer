param([string]$srcPath,[string]$dstPath,[int]$x,[int]$y,[int]$w,[int]$h)
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile($srcPath)
$r=New-Object System.Drawing.Rectangle $x,$y,$w,$h
$dst=New-Object System.Drawing.Bitmap $w,$h
$gr=[System.Drawing.Graphics]::FromImage($dst)
$d=New-Object System.Drawing.Rectangle 0,0,$w,$h
$gr.DrawImage($src,$d,$r,[System.Drawing.GraphicsUnit]::Pixel)
$dst.Save($dstPath)
$gr.Dispose();$dst.Dispose();$src.Dispose()
