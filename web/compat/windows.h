/*
** Dn-FamiTracker web port - Win32 compatibility layer
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The subset of <windows.h> the tracker core touches, for a build without Windows.
// Types keep their Win32 sizes (DWORD is 32 bits, LONG is 32 bits) so structures
// and arithmetic behave as they do in the desktop build. Functions that talk to the
// operating system are stand-ins: the web build has one thread and no files on disk.

#pragma once

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdarg>
#include <cctype>
#include <cwchar>
#include <strings.h>

#include "msvc_crt.h"

#ifndef _WIN32_WINNT_VISTA
#define _WIN32_WINNT_VISTA 0x0600
#endif

// ---- basic types ------------------------------------------------------------------

typedef int                BOOL;
typedef unsigned char      BYTE;
typedef unsigned short     WORD;
typedef uint32_t           DWORD;
typedef uint32_t           UINT;
typedef int32_t            INT;
typedef int32_t            LONG;
typedef uint32_t           ULONG;
typedef int64_t            LONGLONG;
typedef uint64_t           ULONGLONG;
typedef intptr_t           INT_PTR;
typedef uintptr_t          UINT_PTR;
typedef intptr_t           LONG_PTR;
typedef uintptr_t          ULONG_PTR;
typedef uintptr_t          DWORD_PTR;
typedef size_t             SIZE_T;
typedef int8_t             INT8;
typedef uint8_t            UINT8;
typedef int16_t            INT16;
typedef uint16_t           UINT16;
typedef int32_t            INT32;
typedef uint32_t           UINT32;
typedef int64_t            INT64;
typedef uint64_t           UINT64;
typedef uint32_t           DWORD32;
typedef uint64_t           DWORD64;
typedef float              FLOAT;
typedef char               CHAR;
typedef wchar_t            WCHAR;
typedef char               TCHAR;
typedef unsigned char      UCHAR;
typedef short              SHORT;
typedef unsigned short     USHORT;
typedef void              *LPVOID;
typedef const void        *LPCVOID;
typedef char              *LPSTR;
typedef const char        *LPCSTR;
typedef char              *LPTSTR;
typedef const char        *LPCTSTR;
typedef wchar_t           *LPWSTR;
typedef const wchar_t     *LPCWSTR;
typedef BYTE              *LPBYTE;
typedef DWORD             *LPDWORD;
typedef BOOL              *LPBOOL;
typedef UINT              *PUINT;
typedef LONG               HRESULT;
typedef UINT_PTR           WPARAM;
typedef LONG_PTR           LPARAM;
typedef LONG_PTR           LRESULT;
typedef DWORD              COLORREF;

typedef void              *HANDLE;
typedef HANDLE             HWND;
typedef HANDLE             HINSTANCE;
typedef HANDLE             HMODULE;
typedef HANDLE             HKEY;
typedef HANDLE             HDC;
typedef HANDLE             HFONT;
typedef HANDLE             HBITMAP;
typedef HANDLE             HBRUSH;
typedef HANDLE             HPEN;
typedef HANDLE             HMENU;
typedef HANDLE             HICON;
typedef HANDLE             HCURSOR;
typedef HANDLE             HACCEL;
typedef HANDLE             HGLOBAL;
typedef HANDLE             HTHEME;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif
#ifndef NULL
#define NULL 0
#endif

#define CONST const
#define VOID void
#define WINAPI
#define CALLBACK
#define APIENTRY
#define PASCAL
#define FAR
#define NEAR
#define IN
#define OUT
#define OPTIONAL

#define INVALID_HANDLE_VALUE ((HANDLE)(LONG_PTR)-1)
#define MAX_PATH 260
#define INFINITE 0xFFFFFFFFu

#define S_OK           ((HRESULT)0)
#define S_FALSE        ((HRESULT)1)
#define E_FAIL         ((HRESULT)0x80004005L)
#define SUCCEEDED(hr)  (((HRESULT)(hr)) >= 0)
#define FAILED(hr)     (((HRESULT)(hr)) < 0)

// ---- helpers from the SDK headers ---------------------------------------------------

#define MAKEWORD(a, b)   ((WORD)(((BYTE)((DWORD_PTR)(a) & 0xff)) | ((WORD)((BYTE)((DWORD_PTR)(b) & 0xff))) << 8))
#define MAKELONG(a, b)   ((LONG)(((WORD)((DWORD_PTR)(a) & 0xffff)) | ((DWORD)((WORD)((DWORD_PTR)(b) & 0xffff))) << 16))
#define LOWORD(l)        ((WORD)((DWORD_PTR)(l) & 0xffff))
#define HIWORD(l)        ((WORD)((DWORD_PTR)(l) >> 16))
#define LOBYTE(w)        ((BYTE)((DWORD_PTR)(w) & 0xff))
#define HIBYTE(w)        ((BYTE)((DWORD_PTR)(w) >> 8))
#define MAKELPARAM(l, h) ((LPARAM)(DWORD)MAKELONG(l, h))
#define MAKEWPARAM(l, h) ((WPARAM)(DWORD)MAKELONG(l, h))
#define RGB(r, g, b)     ((COLORREF)(((BYTE)(r) | ((WORD)((BYTE)(g)) << 8)) | (((DWORD)(BYTE)(b)) << 16)))
#define GetRValue(rgb)   (LOBYTE(rgb))
#define GetGValue(rgb)   (LOBYTE(((WORD)(rgb)) >> 8))
#define GetBValue(rgb)   (LOBYTE((rgb) >> 16))

#define ZeroMemory(p, n)       std::memset((p), 0, (n))
#define FillMemory(p, n, v)    std::memset((p), (v), (n))
#define CopyMemory(d, s, n)    std::memcpy((d), (s), (n))
#define MoveMemory(d, s, n)    std::memmove((d), (s), (n))

#ifndef _countof
#define _countof(a) (sizeof(a) / sizeof((a)[0]))
#endif

#define UNREFERENCED_PARAMETER(p) ((void)(p))

// ---- window messages the core refers to ---------------------------------------------

#define WM_QUIT    0x0012
#define WM_COMMAND 0x0111
#define WM_TIMER   0x0113
#define WM_USER    0x0400
#define WM_APP     0x8000

struct POINT { LONG x, y; };
struct RECT { LONG left, top, right, bottom; };
struct SIZE { LONG cx, cy; };
struct MSG {
	HWND hwnd;
	UINT message;
	WPARAM wParam;
	LPARAM lParam;
	DWORD time;
	POINT pt;
};
struct NMHDR {
	HWND hwndFrom;
	UINT_PTR idFrom;
	UINT code;
};
typedef MSG *LPMSG;
typedef RECT *LPRECT;
typedef const RECT *LPCRECT;
typedef POINT *LPPOINT;

// ---- message boxes -----------------------------------------------------------------

#define MB_OK              0x00000000u
#define MB_OKCANCEL        0x00000001u
#define MB_ABORTRETRYIGNORE 0x00000002u
#define MB_YESNOCANCEL     0x00000003u
#define MB_YESNO           0x00000004u
#define MB_RETRYCANCEL     0x00000005u
#define MB_ICONHAND        0x00000010u
#define MB_ICONQUESTION    0x00000020u
#define MB_ICONEXCLAMATION 0x00000030u
#define MB_ICONASTERISK    0x00000040u
#define MB_ICONWARNING     MB_ICONEXCLAMATION
#define MB_ICONERROR       MB_ICONHAND
#define MB_ICONSTOP        MB_ICONHAND
#define MB_ICONINFORMATION MB_ICONASTERISK
#define MB_DEFBUTTON2      0x00000100u
#define MB_TOPMOST         0x00040000u

#define IDOK     1
#define IDCANCEL 2
#define IDABORT  3
#define IDRETRY  4
#define IDIGNORE 5
#define IDYES    6
#define IDNO     7

// Routed to the host (see dnft_compat.h); the web build has no dialogs to show.
int MessageBoxA(HWND hWnd, LPCSTR lpText, LPCSTR lpCaption, UINT uType);
#define MessageBox MessageBoxA

// ---- threads and synchronisation ----------------------------------------------------
// The web build runs the engine on the caller's thread and never blocks.

#define THREAD_PRIORITY_NORMAL        0
#define THREAD_PRIORITY_HIGHEST       2
#define THREAD_PRIORITY_TIME_CRITICAL 15
#define WAIT_OBJECT_0 0u
#define WAIT_TIMEOUT  258u
#define WAIT_FAILED   0xFFFFFFFFu

inline DWORD GetCurrentThreadId() { return 1; }
inline HANDLE GetCurrentThread() { return (HANDLE)(LONG_PTR)-2; }
inline BOOL SetThreadPriority(HANDLE, int) { return TRUE; }
inline void Sleep(DWORD) {}
inline DWORD GetTickCount() { return 0; }
inline ULONGLONG GetTickCount64() { return 0; }

HANDLE CreateEventA(void *lpEventAttributes, BOOL bManualReset, BOOL bInitialState, LPCSTR lpName);
#define CreateEvent CreateEventA
BOOL SetEvent(HANDLE hEvent);
BOOL ResetEvent(HANDLE hEvent);
BOOL CloseHandle(HANDLE hObject);
DWORD WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds);

#define COINIT_APARTMENTTHREADED 0x2
#define COINIT_MULTITHREADED     0x0
inline HRESULT CoInitializeEx(void *, DWORD) { return S_OK; }
inline void CoUninitialize() {}

// ---- files ---------------------------------------------------------------------------
// There is no disk. These fail the way Windows does when a path cannot be written.

#define MOVEFILE_REPLACE_EXISTING 0x1
#define MOVEFILE_COPY_ALLOWED     0x2
#define ERROR_SUCCESS             0L
#define ERROR_FILE_NOT_FOUND      2L
#define ERROR_ACCESS_DENIED       5L
inline BOOL CopyFile(LPCTSTR, LPCTSTR, BOOL) { return FALSE; }
#define REPLACEFILE_WRITE_THROUGH       0x00000001
#define REPLACEFILE_IGNORE_MERGE_ERRORS 0x00000002
inline BOOL ReplaceFile(LPCTSTR, LPCTSTR, LPCTSTR, DWORD, LPVOID, LPVOID) { return FALSE; }
inline BOOL FlushFileBuffers(HANDLE) { return TRUE; }
inline BOOL DeleteFile(LPCTSTR) { return FALSE; }
inline BOOL MoveFileEx(LPCTSTR, LPCTSTR, DWORD) { return FALSE; }
inline BOOL MoveFile(LPCTSTR, LPCTSTR) { return FALSE; }
inline DWORD GetLastError() { return ERROR_ACCESS_DENIED; }
inline DWORD GetTempPath(DWORD n, LPTSTR buf) { if (n) buf[0] = 0; return 0; }
inline UINT GetTempFileName(LPCTSTR, LPCTSTR, UINT, LPTSTR buf) { buf[0] = 0; return 0; }

#define FORMAT_MESSAGE_ALLOCATE_BUFFER 0x00000100
#define FORMAT_MESSAGE_IGNORE_INSERTS  0x00000200
#define FORMAT_MESSAGE_FROM_SYSTEM     0x00001000
#define LANG_NEUTRAL    0x00
#define SUBLANG_DEFAULT 0x01
#define MAKELANGID(p, s) ((((WORD)(s)) << 10) | (WORD)(p))
DWORD FormatMessage(DWORD dwFlags, LPCVOID lpSource, DWORD dwMessageId, DWORD dwLanguageId,
                    LPTSTR lpBuffer, DWORD nSize, va_list *Arguments);
inline HGLOBAL LocalFree(HGLOBAL) { return nullptr; }

// ---- debugging -----------------------------------------------------------------------

inline void OutputDebugStringA(LPCSTR s) { std::fputs(s, stderr); }
#define OutputDebugString OutputDebugStringA
inline void DebugBreak() {}

// ---- registry (settings are not persisted in the web build) ------------------------

#define HKEY_CURRENT_USER ((HKEY)(ULONG_PTR)((LONG)0x80000001))
inline LONG RegCloseKey(HKEY) { return ERROR_SUCCESS; }

#include "tchar.h"
