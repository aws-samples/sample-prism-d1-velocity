@echo off
REM PRISM CLI - Entry point (Windows)
REM Usage: prism-cli <command> [subcommand] [options]
REM Examples:
REM   prism-cli assessment run
REM   prism-cli assessment web
REM   prism-cli workshop verify-setup

setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
set "REQUIRED_NODE_MAJOR=20"
set "PRISM_CLI_DIR=%SCRIPT_DIR%cli"

REM --- Check Node.js is available ---
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed or not in PATH.
    echo Please install Node.js ^>= %REQUIRED_NODE_MAJOR% from https://nodejs.org and re-run.
    exit /b 1
)

REM --- Check minimum Node version ---
for /f "tokens=1 delims=v." %%a in ('node --version') do set "NODE_MAJOR=%%a"
REM node --version returns "vXX.Y.Z", strip the leading "v"
for /f "tokens=1 delims=." %%a in ('node --version') do set "NODE_VER_RAW=%%a"
set "NODE_MAJOR=%NODE_VER_RAW:~1%"

if %NODE_MAJOR% lss %REQUIRED_NODE_MAJOR% (
    echo Node.js ^>= %REQUIRED_NODE_MAJOR% required ^(found v%NODE_MAJOR%^).
    echo Please upgrade Node.js from https://nodejs.org and re-run.
    exit /b 1
)

REM --- Install or update dependencies if needed ---
if not exist "%PRISM_CLI_DIR%\node_modules" (
    echo Installing prism-cli dependencies...
    pushd "%PRISM_CLI_DIR%"
    call npm install --silent
    popd
)

REM --- Run the CLI ---
call npx --prefix "%PRISM_CLI_DIR%" tsx "%PRISM_CLI_DIR%\bin\prism-cli.ts" %*
