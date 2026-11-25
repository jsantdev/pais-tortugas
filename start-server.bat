@echo off
setlocal
cd /d "%~dp0" || exit /b 1

if not defined HOST set "HOST=127.0.0.1"
if not defined PORT set "PORT=21213"
set "PROJECT_DIR=%CD%"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js no esta instalado o no esta disponible en PATH.
  pause
  exit /b 1
)

where cloudflared >nul 2>&1
if errorlevel 1 (
  echo cloudflared no esta instalado o no esta disponible en PATH.
  pause
  exit /b 1
)

powershell -NoProfile -Command "$envFile = Join-Path $env:PROJECT_DIR '.env'; $loginEnabled = $env:LOGIN_ENABLED; if ([string]::IsNullOrWhiteSpace($loginEnabled) -and (Test-Path -LiteralPath $envFile)) { $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*LOGIN_ENABLED\s*=' } | Select-Object -First 1; if ($line) { $loginEnabled = ($line -split '=', 2)[1].Trim().Trim([char]34).Trim([char]39) } }; if ($loginEnabled -match '^(?i:false|0|no|off)$') { exit 0 }; $hasPassword = -not [string]::IsNullOrWhiteSpace($env:ADMIN_PASSWORD); if (-not $hasPassword -and (Test-Path -LiteralPath $envFile)) { $hasPassword = Select-String -Path $envFile -Pattern '^\s*ADMIN_PASSWORD\s*=\s*\S.*$' -Quiet -ErrorAction SilentlyContinue }; if (-not $hasPassword) { Write-Host 'Falta ADMIN_PASSWORD en .env'; exit 1 }"
if errorlevel 1 (
  echo Escribe una contrasena en .env, en la linea ADMIN_PASSWORD=...
  pause
  exit /b 1
)

echo Cerrando cualquier proceso que este usando el puerto %PORT%...
powershell -NoProfile -Command "$port = [int]$env:PORT; $owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); foreach ($processId in $owners) { if ($processId -ne $PID) { Stop-Process -Id $processId -Force -ErrorAction Stop } }; if ($owners.Count -eq 0) { Write-Host 'El puerto esta libre.' }"
if errorlevel 1 (
  echo No se pudo liberar el puerto %PORT%. Ejecuta este archivo con permisos adecuados.
  pause
  exit /b 1
)

echo Iniciando el servidor y creando un tunel temporal de Cloudflare...
echo La URL publica aparecera en esta consola; agrega /overlay para el overlay.
echo.

powershell -NoProfile -Command "$server = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $env:PROJECT_DIR -PassThru -WindowStyle Minimized; try { $port = [int]$env:PORT; $deadline = (Get-Date).AddSeconds(30); do { Start-Sleep -Milliseconds 500; $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue } while (-not $listener -and (Get-Date) -lt $deadline); if (-not $listener) { throw 'El servidor no abrio el puerto a tiempo.' }; $script:publicUrl = $null; & cloudflared tunnel --url ('http://127.0.0.1:' + $port) 2>&1 | ForEach-Object { $line = $_.ToString(); if (-not $script:publicUrl -and $line -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $script:publicUrl = $Matches[0]; Write-Host ''; Write-Host ('Overlay: ' + $script:publicUrl + '/overlay'); Write-Host ('Administracion: ' + $script:publicUrl + '/login'); Write-Host ('URL DEL TUNEL: ' + $script:publicUrl) } }; if (-not $script:publicUrl) { throw 'Cloudflare termino sin entregar una URL de tunel.' } } finally { if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue } }"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo El servidor y el tunel se detuvieron con codigo %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
