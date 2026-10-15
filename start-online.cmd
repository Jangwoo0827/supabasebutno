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

tasklist | findstr /I /C:"ngrok.exe" /C:"cloudflared.exe" >nul
if errorlevel 1 (
  echo Starting the tunnel...
  start "supabasebutno tunnel" cmd /k "npm run tunnel"
) else (
  echo A tunnel (ngrok / cloudflared) is already running - skipping.
)

echo.
set "PUBLIC_URL="
if exist .env for /f "tokens=1,* delims==" %%a in ('findstr /B /C:"PUBLIC_URL=" .env') do set "PUBLIC_URL=%%b"
if defined PUBLIC_URL (echo Online: %PUBLIC_URL%) else (echo Online is up. Set PUBLIC_URL in .env to show your address here.)
echo Keep the two new windows open (minimize them). You can close this one.
pause >nul
