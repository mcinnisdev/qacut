@echo off
rem Code-signs one file with SSL.com eSigner (cloud signing) through
rem CodeSignTool. Tauri calls this for the app exe and each installer when
rem the release workflow points bundle.windows.signCommand at it. With no
rem credentials in the environment it leaves the file as it is, so local
rem builds still work.
rem
rem Needs: CODESIGNTOOL_PATH (folder holding CodeSignTool.bat),
rem ESIGNER_USERNAME, ESIGNER_PASSWORD, ESIGNER_CREDENTIAL_ID,
rem ESIGNER_TOTP_SECRET.
setlocal
if "%ESIGNER_USERNAME%"=="" (
  echo sign: no eSigner credentials, leaving %~nx1 unsigned
  exit /b 0
)
if not exist "%CODESIGNTOOL_PATH%\CodeSignTool.bat" (
  echo sign: CodeSignTool.bat not found under "%CODESIGNTOOL_PATH%" 1>&2
  exit /b 1
)
set "TARGET=%~f1"
pushd "%CODESIGNTOOL_PATH%"
call CodeSignTool.bat sign -username="%ESIGNER_USERNAME%" -password="%ESIGNER_PASSWORD%" -credential_id="%ESIGNER_CREDENTIAL_ID%" -totp_secret="%ESIGNER_TOTP_SECRET%" -input_file_path="%TARGET%" -override=true
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo sign: CodeSignTool failed with %RC% on %~nx1 1>&2
  exit /b %RC%
)
echo sign: signed %~nx1
exit /b 0
