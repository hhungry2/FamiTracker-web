@echo off
pushd "%~dp0"
rem The upstream help project expects licenses beside the desktop solution.
for %%L in (LICENSE.md LICENSE-GPLv2.txt LICENSE-GPLv3.txt LICENSE-MIT-0.txt) do copy /y "..\%%L" "%%L" >nul
echo // Generated Help Map file.  Used by Dn-FamiTracker.hhp. > "Dn-help\hlp\HTMLDefines.h"
echo. > "Dn-help\hlp\HTMLDefines.h"
echo // Commands (ID_* and IDM_*) >> "Dn-help\hlp\HTMLDefines.h"
makehm /h ID_,HID_,0x10000 IDM_,HIDM_,0x10000 "resource.h" >> "Dn-help\hlp\HTMLDefines.h"
echo. >> "Dn-help\hlp\HTMLDefines.h"
echo // Prompts (IDP_*) >> "Dn-help\hlp\HTMLDefines.h"
makehm /h IDP_,HIDP_,0x30000 "resource.h" >> "Dn-help\hlp\HTMLDefines.h"
echo. >> "Dn-help\hlp\HTMLDefines.h"
echo // Resources (IDR_*) >> "Dn-help\hlp\HTMLDefines.h"
makehm /h IDR_,HIDR_,0x20000 "resource.h" >> "Dn-help\hlp\HTMLDefines.h"
echo. >> "Dn-help\hlp\HTMLDefines.h"
echo // Dialogs (IDD_*) >> "Dn-help\hlp\HTMLDefines.h"
makehm /h IDD_,HIDD_,0x20000 "resource.h" >> "Dn-help\hlp\HTMLDefines.h"
echo. >> "Dn-help\hlp\HTMLDefines.h"
echo // Frame Controls (IDW_*) >> "Dn-help\hlp\HTMLDefines.h"
makehm /h /a "afxhh.h" IDW_,HIDW_,0x50000 "resource.h" >> "Dn-help\hlp\HTMLDefines.h"
popd
