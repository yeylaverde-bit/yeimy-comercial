@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Dashboard de Yeimy

if not exist ".env" (
  echo.
  echo  No existe el archivo .env todavia.
  echo  Voy a copiarte la plantilla .env.example -^> .env
  echo  Abrelo despues y pega tu API Key de Impulsa.
  echo.
  copy ".env.example" ".env" >nul
  echo  Listo. Edita .env con notepad y vuelve a correr este .bat
  echo.
  pause
  exit /b
)

if not exist "node_modules" (
  echo.
  echo  Primera vez: instalando dependencias...
  echo  Esto puede tomar un minuto.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  Fallo la instalacion de dependencias.
    echo  Verifica que Node.js este instalado: node -v
    pause
    exit /b 1
  )
)

echo.
echo  Abriendo navegador en http://localhost:3000 ...
start "" "http://localhost:3000"

call npm start
pause
