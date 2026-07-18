# Create linux folder and move .sh files into it
$linuxFolder = Join-Path -Path $PSScriptRoot -ChildPath "linux"
if (-not (Test-Path $linuxFolder)) {
    New-Item -ItemType Directory -Path $linuxFolder | Out-Null
}

Get-ChildItem -Path $PSScriptRoot -Filter *.sh | ForEach-Object {
    $destination = Join-Path -Path $linuxFolder -ChildPath $_.Name
    Move-Item -Path $_.FullName -Destination $destination -Force
    Write-Host "Moved $($_.Name) to linux/"
}
