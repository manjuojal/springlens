@echo off
rem Spring Lens launcher for Windows. Nothing to install except Node.js 18+.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
echo Starting Spring Lens on http://localhost:7070 - close this window to stop it.
node bin\spring-lens.js serve --open
pause
exit /b 0

:nonode
echo Node.js is required. Install the LTS version from https://nodejs.org and run this file again.
pause
exit /b 1
