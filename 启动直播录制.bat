@echo off
rem Launcher: ASCII only (cmd parses .bat with ANSI codepage; UTF-8 Chinese merges lines and breaks parsing)
rem Fallback launcher. Prefer the desktop shortcut which points directly to electron.exe.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" .
exit
