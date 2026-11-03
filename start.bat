@echo off
title Free car trips
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is needed to run the map, and it is not installed yet.
  echo   Opening the download page. Install the LTS version, then double-click start.bat again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  echo Building the site for the first time...
  if not exist "node_modules" call npm install
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

rem Node 20.13 and newer can restart the server by itself when its files are updated (--watch),
rem so updates to the map take effect without closing this window.
set WATCH=
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
  if %%a GEQ 22 set WATCH=--watch
  if %%a EQU 20 if %%b GEQ 13 set WATCH=--watch
  if %%a EQU 21 set WATCH=--watch
)

node %WATCH% server.mjs --open
pause
