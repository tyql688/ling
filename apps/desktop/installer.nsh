!macro customHeader
	ShowInstDetails show
	ShowUninstDetails show
	LangString lingClosingProcesses ${LANG_ENGLISH} "Closing Ling and releasing its files..."
	LangString lingClosingProcesses ${LANG_SIMPCHINESE} "正在关闭 Ling 并释放占用的文件…"
	LangString lingPreparingFiles ${LANG_ENGLISH} "Preparing program files and removing the previous installation..."
	LangString lingPreparingFiles ${LANG_SIMPCHINESE} "正在准备程序文件并清理旧版本…"
	LangString lingCopyingFiles ${LANG_ENGLISH} "Copying Ling application files..."
	LangString lingCopyingFiles ${LANG_SIMPCHINESE} "正在复制 Ling 程序文件…"
	LangString lingCopyFailed ${LANG_ENGLISH} "Could not copy all Ling files. Close programs using the installation folder, then retry."
	LangString lingCopyFailed ${LANG_SIMPCHINESE} "未能复制全部 Ling 文件。请关闭正在使用安装目录的程序，然后重试。"
	LangString lingInstalled ${LANG_ENGLISH} "Ling has been installed."
	LangString lingInstalled ${LANG_SIMPCHINESE} "Ling 安装完成。"
!macroend

; The default Windows shell copy spends minutes on Host's many small dependency
; files. Keep staged extraction and differential updates, and copy files directly
; with bounded concurrency instead of using the Windows shell copy operation.
!macro customCopyAppPackage SOURCE DESTINATION
	Push $0
	Push $1
	DetailPrint "$(lingCopyingFiles)"
	lingCopyRetry:
	; Eight workers bound concurrent disk operations. Robocopy does not retry here;
	; the installer owns the retry/cancel decision when a file cannot be replaced.
	nsExec::ExecToStack `"$SYSDIR\robocopy.exe" "${SOURCE}" "${DESTINATION}" /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /MT:8 /NFL /NDL /NJH /NJS /NP`
	Pop $0
	Pop $1
	${If} $0 == "error"
	${OrIf} $0 == "timeout"
		Goto lingCopyFailed
	${EndIf}
	; Robocopy uses a bitmask: values below eight report successful copy/skip states.
	${If} $0 >= 0
	${AndIf} $0 < 8
		ClearErrors
		Goto lingCopyDone
	${EndIf}
	lingCopyFailed:
	DetailPrint "$(lingCopyFailed) ($0) $1"
	MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(lingCopyFailed)$\r$\n$1" /SD IDCANCEL IDRETRY lingCopyRetry
	; NSIS uses two for an installation that could not finish, including silent updates.
	SetErrorLevel 2
	Quit
	lingCopyDone:
	Pop $1
	Pop $0
!macroend

; Close the whole installed app tree, including a previous installation elsewhere.
!macro customCheckAppRunning
	; electron-builder disables all detail output immediately before this hook.
	SetDetailsPrint both
	DetailPrint "$(lingClosingProcesses)"
	; Kill every Ling.exe by image name together with its process tree, regardless of
	; which directory it was installed to. The image name never matches the running
	; installer or uninstaller itself, so no PID filter is needed.
	nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
	Pop $0
	; The bundled Node host can outlive its parent and keeps files under resources
	; locked. Path-scoped so Node processes elsewhere on the machine survive.
	nsExec::Exec `"$PowerShellPath" -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
	Pop $0
	; Give killed processes a moment to release file handles before files are replaced.
	Sleep 800
	DetailPrint "$(lingPreparingFiles)"
!macroend

!macro customInstall
	DetailPrint "$(lingInstalled)"
!macroend
