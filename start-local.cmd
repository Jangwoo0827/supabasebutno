@echo off
rem Double-click to start supabasebutno on this PC (same as: npm run local).
cd /d "%~dp0"
call npm run local
echo.
echo The server stopped. Press any key to close this window.
pause >nul
