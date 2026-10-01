; Custom electron-builder NSIS hook (see docs: https://www.electron.build/nsis#custom-nsis-script).
; Silently installs the Visual C++ 2015-2022 x64 redistributable if it isn't already present, the
; same VC++ Runtimes\x64 registry key the redistributable's own installer writes on success. Native
; N-API addons this app ships (better-sqlite3, the daemon's OS-credential-store binding) fail to
; load without it on a machine that never had another VC++-dependent app installed -- see issue #62.
;
; vc_redist.x64.exe itself is downloaded fresh by scripts/download-vc-redist.mjs before every
; Windows package build, never checked into the repo (see .gitignore): it is a ~25 MB third-party
; binary that changes whenever Microsoft ships an update, and pinning a stale copy here would only
; go stale itself.
!macro customInstall
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  IntCmp $0 1 vcredist_done vcredist_install vcredist_install
  vcredist_install:
    DetailPrint "Installing Visual C++ Redistributable (required by Open Vacancy Radar)..."
    SetOutPath "$PLUGINSDIR"
    File "${BUILD_RESOURCES_DIR}\vc_redist.x64.exe"
    ; /norestart: a mid-install reboot prompt would abandon this installer with no way back in.
    ; The redistributable itself only actually requires one in rare cases (an in-use DLL from
    ; another running app); Windows applies the update as soon as that app next restarts anyway.
    ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart'
  vcredist_done:
!macroend
