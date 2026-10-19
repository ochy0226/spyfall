@echo off
rem Spyfall launcher: starts the game server + internet address and opens the teacher page.
rem All logic (and Korean messages) live in run.py, because cmd misreads Korean text in .bat files.
cd /d %~dp0
title Spyfall
.venv\Scripts\python.exe run.py
pause
