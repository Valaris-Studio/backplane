; The app trusts only %LOCALAPPDATA%\Programs\Backplane Companion as a per-user
; install (contract v1.5), but Tauri's per-user default is
; %LOCALAPPDATA%\Backplane Companion. An install left at that default goes to
; the trusted folder instead; a folder the user chose is kept (and the app
; then asks to be reinstalled). Later installs reuse the recorded folder.
; Tauri's Install section already created the default folder before this hook
; ran, so it is removed again (only while empty).
!macro NSIS_HOOK_PREINSTALL
  ${If} $INSTDIR == "$LOCALAPPDATA\${PRODUCTNAME}"
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
    SetOutPath $INSTDIR
    RMDir "$LOCALAPPDATA\${PRODUCTNAME}"
  ${EndIf}
!macroend

; Tauri deletes %LOCALAPPDATA%\<identifier> only when "delete app data" is
; ticked. Here it holds just the WebView2 profile, the logs and onboarding
; progress, all tied to this install, so it always goes; the preferences in
; %APPDATA%\<identifier> stay behind Tauri's checkbox, and the companion's
; own data (%LOCALAPPDATA%\Backplane) is removed by its uninstall. The
; recursive delete names the identifier literally: an empty LOCALAPPDATA is
; refused, so it can never resolve to a parent folder.
!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  ${If} $LOCALAPPDATA != ""
  ${AndIf} $UpdateMode <> 1
    RMDir "$LOCALAPPDATA\${PRODUCTNAME}"
    RMDir /r "$LOCALAPPDATA\dev.backplane.companion.desktop"
  ${EndIf}
!macroend
