@echo off
rem Double-click: starts the server AND the public ngrok tunnel, each in its own window.
rem Close both windows to take the online features offline. Admin pages stay hidden from the internet.
cd /d "%~dp0"

netstat -ano | findstr /R /C:":8787 .*LISTENING" >nul
if errorlevel 1 (
  echo Starting the server...
  start "supabasebutno server" cmd /k "npm run local"
  timeout /t 6 /nobreak >nul
) else (
  echo Server already running on port 8787 - skipping.
)

tasklist /FI "IMAGENAME eq ngrok.exe" | find /I "ngrok.exe" >nul
if errorlevel 1 (
  echo Starting the tunnel...
  start "supabasebutno tunnel" cmd /k "npm run tunnel"
) else (
  echo ngrok is already running - skipping.
)

echo.
echo Online is up: https://laurel-spry-gladly.ngrok-free.dev
echo Keep the two new windows open (minimize them). You can close this one.
pause >nul
