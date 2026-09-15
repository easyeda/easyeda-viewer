param([string]$srcPath,[string]$xy)
Add-Type -AssemblyName System.Drawing
$bmp=New-Object System.Drawing.Bitmap $srcPath
$pts=$xy.Split(',') | ForEach-Object { [int]$_ }
for($i=0;$i -lt $pts.Length;$i+=2){
  $c=$bmp.GetPixel($pts[$i],$pts[$i+1])
  Write-Output ("{0},{1} = #{2:X2}{3:X2}{4:X2}" -f $pts[$i],$pts[$i+1],$c.R,$c.G,$c.B)
}
$bmp.Dispose()
