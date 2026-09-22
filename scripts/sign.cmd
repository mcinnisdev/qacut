@echo off
rem Code-signs one file with SSL.com eSigner (cloud signing) through
rem CodeSignTool. Tauri calls this for the app exe and each installer when
rem the release workflow points bundle.windows.signCommand at it. With no
rem credentials in the environment it leaves the file as it is, so local
rem builds still work.
rem
rem Needs: CODESIGNTOOL_PATH (folder holding CodeSignTool.bat),
rem ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_CREDENTIAL_ID,
rem ESIGNER_TOTP_SECRET. Output goes to SIGN_LOG (Tauri shows none of it).
setlocal
if "%ESIGNER_USERNAME%"=="" (
  echo sign: no eSigner credentials, leaving %~nx1 unsigned
  exit /b 0
)
set "TARGET=%~f1"
rem Every signature costs eSigner quota, so only what a person or
rem SmartScreen sees gets one: the app, the installers, the uninstaller.
rem Tauri also offers the NSIS plugin DLLs and the WiX extension DLLs,
rem which live inside the installer and are never run on their own.
echo "%TARGET%" | findstr /i /l /c:"\Plugins\\" /c:"\wix\\" > nul && (
  echo sign: skipped bundled helper %~nx1
  exit /b 0
)
rem The app exe is offered once per installer type; sign it once.
for /f "usebackq delims=" %%S in (`powershell -NoProfile -Command "(Get-AuthenticodeSignature -LiteralPath '%TARGET%').Status"`) do set "SIGSTATUS=%%S"
if /i "%SIGSTATUS%"=="Valid" (
  echo sign: already signed %~nx1
  exit /b 0
)
if not exist "%CODESIGNTOOL_PATH%\CodeSignTool.bat" (
  echo sign: CodeSignTool.bat not found under "%CODESIGNTOOL_PATH%" 1>&2
  exit /b 1
)
rem NSIS hands its uninstaller over as a .tmp file, which CodeSignTool
rem refuses by extension; sign it under an .exe name and put it back.
set "RENAMED="
if /i "%~x1"==".tmp" (
  set "RENAMED=%~f1.exe"
  copy /y "%~f1" "%~f1.exe" > nul
  set "TARGET=%~f1.exe"
)
pushd "%CODESIGNTOOL_PATH%"
if "%SIGN_LOG%"=="" set "SIGN_LOG=%TEMP%\qacut-sign.log"
echo === %DATE% %TIME% %TARGET% >> "%SIGN_LOG%"
call CodeSignTool.bat sign -username="%ESIGNER_USERNAME%" -password="%ESIGNER_PASSWORD%" -credential_id="%ESIGNER_CREDENTIAL_ID%" -totp_secret="%ESIGNER_TOTP_SECRET%" -input_file_path="%TARGET%" -override=true >> "%SIGN_LOG%" 2>&1
set "RC=%ERRORLEVEL%"
popd
if not "%RENAMED%"=="" (
  if "%RC%"=="0" copy /y "%RENAMED%" "%~f1" > nul
  del /q "%RENAMED%"
)
if not "%RC%"=="0" (
  echo sign: CodeSignTool failed with %RC% on %~nx1 1>&2
  exit /b %RC%
)
echo sign: signed %~nx1
exit /b 0
