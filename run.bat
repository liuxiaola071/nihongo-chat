@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo ╔══════════════════════════════════╗
echo ║   🎌 日本語チャット 起動中…    ║
echo ╚══════════════════════════════════╝
echo.
cd backend
call ..\..\..\python_learning_venv\Scripts\activate.bat 2>nul
python server.py
pause
