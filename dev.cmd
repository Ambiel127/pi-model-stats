@echo off
setlocal
cd /d "%~dp0"
where pi >nul 2>nul
if errorlevel 1 (
  echo Error: Pi CLI "pi" was not found in PATH.
  exit /b 1
)

pi %*
exit /b %ERRORLEVEL%
