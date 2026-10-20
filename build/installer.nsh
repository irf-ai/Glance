; Stops the installer with a clear message on PCs that can't run Glance,
; instead of installing an app that then fails to start.
!include "WinVer.nsh"
!include "x64.nsh"

!macro customInit
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "Glance needs Windows 10 or Windows 11 (64-bit).$\r$\n$\r$\nThis PC is running an older version of Windows, so Glance can't run on it."
    Quit
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "Glance needs a 64-bit edition of Windows 10 or 11.$\r$\n$\r$\nThis PC is running 32-bit Windows, so Glance can't run on it."
    Quit
  ${EndIf}
  ; Windows 10 on ARM can't run 64-bit Intel/AMD apps; Windows 11 on ARM can.
  ${If} ${IsNativeARM64}
  ${AndIfNot} ${AtLeastBuild} 22000
    MessageBox MB_OK|MB_ICONSTOP "Glance needs Windows 11 on ARM-based PCs.$\r$\n$\r$\nWindows 10 on ARM can't run Glance."
    Quit
  ${EndIf}
!macroend
