@echo off
title Server Board Game Keuangan Syariah
cd /d "%~dp0"

python server.py
if errorlevel 1 (
    echo.
    echo Terjadi kesalahan saat menjalankan Python.
    echo Pastikan Python terinstal dan berada pada PATH Windows.
    pause
)
