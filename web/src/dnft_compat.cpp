/*
** Dn-FamiTracker web port
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// Out-of-line parts of the MFC/Win32 compatibility layer (compat/).

#include "stdafx.h"
#include "resource.h"
#include "dnft_compat.h"

#include <cstdio>
#include <map>
#include <string>
#include <unordered_map>

namespace {

std::map<std::string, std::shared_ptr<std::vector<unsigned char>>> &Files() {
	static std::map<std::string, std::shared_ptr<std::vector<unsigned char>>> files;
	return files;
}

dnft_compat::MessageHandler &Handler() {
	static dnft_compat::MessageHandler handler;
	return handler;
}

struct StringResource {
	unsigned int id;
	const char *text;
};

const StringResource STRING_TABLE[] = {
#include "strings.inc"
};

// MFC's %1 %2 ... placeholders, as used by AfxFormatString and CString::FormatMessage
CString SubstitutePlaceholders(const char *format, std::initializer_list<const char *> args) {
	CString out;
	for (const char *p = format; *p; ++p) {
		if (*p == '%' && p[1] >= '1' && p[1] <= '9') {
			size_t index = static_cast<size_t>(p[1] - '1');
			if (index < args.size())
				out += *(args.begin() + index);
			++p;
		}
		else
			out += *p;
	}
	return out;
}

CString StringOrId(UINT nID) {
	if (const char *text = dnft_compat::LoadStringResource(nID))
		return CString(text);
	CString s;
	s.Format("(string %u)", nID);
	return s;
}

} // namespace

namespace dnft_compat {

void PutFile(const std::string &path, std::vector<uint8_t> content) {
	Files()[path] = std::make_shared<std::vector<unsigned char>>(std::move(content));
}

std::vector<uint8_t> TakeFile(const std::string &path) {
	auto &files = Files();
	auto it = files.find(path);
	if (it == files.end())
		return {};
	auto content = std::move(*it->second);
	files.erase(it);
	return content;
}

bool HasFile(const std::string &path) {
	return Files().count(path) != 0;
}

std::vector<std::string> ListFiles() {
	std::vector<std::string> paths;
	for (const auto &file : Files())
		paths.push_back(file.first);
	return paths;
}

MessageHandler SetMessageHandler(MessageHandler handler) {
	MessageHandler previous = std::move(Handler());
	Handler() = std::move(handler);
	return previous;
}

int ReportMessage(const char *text, unsigned int type) {
	if (Handler())
		return Handler()(text ? text : "", type);
	std::fprintf(stderr, "%s\n", text ? text : "");
	// A yes/no question without anyone to ask: decline
	return (type & 0xF) == MB_YESNO || (type & 0xF) == MB_YESNOCANCEL ? IDNO : IDOK;
}

void ReportAssertion(const char *file, int line, const char *expr) {
	std::fprintf(stderr, "Assertion failed: %s (%s:%d)\n", expr, file, line);
}

const char *LoadStringResource(unsigned int id) {
	static const std::unordered_map<unsigned int, const char *> table = [] {
		std::unordered_map<unsigned int, const char *> t;
		for (const auto &entry : STRING_TABLE)
			t.emplace(entry.id, entry.text);
		return t;
	}();
	auto it = table.find(id);
	return it == table.end() ? nullptr : it->second;
}

} // namespace dnft_compat

// ---- CString -------------------------------------------------------------------------------

CString CString::LoadFormat(UINT nID) {
	return StringOrId(nID);
}

BOOL CString::LoadString(UINT nID) {
	const char *text = dnft_compat::LoadStringResource(nID);
	if (!text) {
		Empty();
		return FALSE;
	}
	*this = text;
	return TRUE;
}

// ---- exceptions ------------------------------------------------------------------------------

CDumpContext afxDump;

int CException::ReportError(UINT nType, UINT nMessageID) {
	char text[512] = {};
	if (GetErrorMessage(text, sizeof(text)))
		return AfxMessageBox(text, nType);
	return AfxMessageBox(nMessageID ? nMessageID : IDS_FILE_OPEN_ERROR, nType);
}

BOOL CFileException::GetErrorMessage(LPTSTR lpszError, UINT nMaxError, PUINT pnHelpContext) const {
	static const char *const CAUSES[] = {
		"No error occurred.",
		"An unspecified error occurred.",
		"The file could not be located.",
		"All or part of the path is invalid.",
		"The permitted number of open files was exceeded.",
		"The file could not be accessed.",
		"There was an attempt to use an invalid file handle.",
		"The current working directory cannot be removed.",
		"There are no more directory entries.",
		"There was an error trying to set the file pointer.",
		"There was a hardware error.",
		"A sharing violation occurred.",
		"There was an attempt to lock a region that was already locked.",
		"The disk is full.",
		"The end of file was reached.",
	};
	if (pnHelpContext)
		*pnHelpContext = 0;
	if (!nMaxError)
		return FALSE;
	const char *cause = (m_cause >= 0 && m_cause < static_cast<int>(_countof(CAUSES))) ? CAUSES[m_cause] : CAUSES[1];
	std::snprintf(lpszError, nMaxError, "%s%s%s", m_strFileName.IsEmpty() ? "" : m_strFileName.GetString(),
		m_strFileName.IsEmpty() ? "" : ": ", cause);
	return TRUE;
}

void AfxThrowFileException(int cause, LONG lOsError, LPCTSTR lpszFileName) {
	throw new CFileException(cause, lOsError, lpszFileName);
}

void AfxThrowMemoryException() {
	throw new CMemoryException();
}

void AfxThrowNotSupportedException() {
	throw new CNotSupportedException();
}

void AfxThrowUserException() {
	throw new CUserException();
}

// ---- CFile ---------------------------------------------------------------------------------------

const HANDLE CFile::hFileNull = nullptr;

namespace {
// Any non-null value tells the core a file is open; the data lives in the CFile itself.
HANDLE const OPEN_HANDLE = reinterpret_cast<HANDLE>(static_cast<intptr_t>(1));
}

CFile::CFile() : m_hFile(hFileNull) {
}

CFile::CFile(LPCTSTR lpszFileName, UINT nOpenFlags) : m_hFile(hFileNull) {
	CFileException e;
	if (!Open(lpszFileName, nOpenFlags, &e))
		AfxThrowFileException(e.m_cause, e.m_lOsError, lpszFileName);
}

CFile::~CFile() {
	if (m_hFile != hFileNull)
		Close();
}

BOOL CFile::Open(LPCTSTR lpszFileName, UINT nOpenFlags, CFileException *pError) {
	if (m_hFile != hFileNull)
		Close();
	m_strFileName = lpszFileName;
	m_iPos = 0;
	m_bWrite = (nOpenFlags & (modeWrite | modeReadWrite)) != 0;

	auto &files = Files();
	auto it = files.find(m_strFileName.GetString());
	if (nOpenFlags & modeCreate) {
		if (it == files.end() || !(nOpenFlags & modeNoTruncate))
			m_pData = std::make_shared<std::vector<unsigned char>>();
		else
			m_pData = std::make_shared<std::vector<unsigned char>>(*it->second);
	}
	else if (it != files.end()) {
		// A file opened for writing is only published on Close(), so readers see the old
		// contents until then, as with an atomic save.
		m_pData = m_bWrite ? std::make_shared<std::vector<unsigned char>>(*it->second) : it->second;
	}
	else {
		if (pError) {
			pError->m_cause = CFileException::fileNotFound;
			pError->m_lOsError = ERROR_FILE_NOT_FOUND;
			pError->m_strFileName = lpszFileName;
		}
		return FALSE;
	}
	m_hFile = OPEN_HANDLE;
	return TRUE;
}

void CFile::Close() {
	if (m_hFile == hFileNull)
		return;
	if (m_bWrite && m_pData)
		Files()[m_strFileName.GetString()] = m_pData;
	m_pData.reset();
	m_hFile = hFileNull;
	m_iPos = 0;
}

void CFile::Abort() {
	m_pData.reset();
	m_hFile = hFileNull;
	m_iPos = 0;
}

UINT CFile::Read(void *lpBuf, UINT nCount) {
	if (!m_pData)
		AfxThrowFileException(CFileException::invalidFile);
	size_t available = m_iPos < m_pData->size() ? m_pData->size() - m_iPos : 0;
	size_t n = std::min<size_t>(nCount, available);
	if (n)
		std::memcpy(lpBuf, m_pData->data() + m_iPos, n);
	m_iPos += n;
	return static_cast<UINT>(n);
}

void CFile::Write(const void *lpBuf, UINT nCount) {
	if (!m_pData || !m_bWrite)
		AfxThrowFileException(CFileException::accessDenied);
	if (m_iPos + nCount > m_pData->size())
		m_pData->resize(m_iPos + nCount);
	std::memcpy(m_pData->data() + m_iPos, lpBuf, nCount);
	m_iPos += nCount;
}

ULONGLONG CFile::Seek(LONGLONG lOff, UINT nFrom) {
	if (!m_pData)
		AfxThrowFileException(CFileException::invalidFile);
	LONGLONG base = nFrom == begin ? 0 : nFrom == current ? static_cast<LONGLONG>(m_iPos) : static_cast<LONGLONG>(m_pData->size());
	LONGLONG target = base + lOff;
	if (target < 0)
		AfxThrowFileException(CFileException::badSeek);
	m_iPos = static_cast<size_t>(target);
	return static_cast<ULONGLONG>(target);
}

ULONGLONG CFile::GetLength() const {
	return m_pData ? m_pData->size() : 0;
}

ULONGLONG CFile::GetPosition() const {
	return m_iPos;
}

void CFile::SetLength(ULONGLONG dwNewLen) {
	if (!m_pData || !m_bWrite)
		AfxThrowFileException(CFileException::accessDenied);
	m_pData->resize(static_cast<size_t>(dwNewLen));
}

CString CFile::GetFileName() const {
	int slash = std::max(m_strFileName.ReverseFind('/'), m_strFileName.ReverseFind('\\'));
	return m_strFileName.Mid(slash + 1);
}

BOOL CStdioFile::ReadString(CString &rString) {
	rString.Empty();
	char ch;
	bool any = false;
	while (Read(&ch, 1) == 1) {
		any = true;
		if (ch == '\n')
			break;
		if (ch != '\r' || !m_bText)
			rString += ch;
	}
	return any;
}

void CStdioFile::WriteString(LPCTSTR lpsz) {
	if (!m_bText) {
		Write(lpsz, static_cast<UINT>(std::strlen(lpsz)));
		return;
	}
	std::string text;
	for (const char *p = lpsz; *p; ++p) {
		if (*p == '\n')
			text += '\r';
		text += *p;
	}
	Write(text.data(), static_cast<UINT>(text.size()));
}

// ---- application framework ------------------------------------------------------------------

namespace {
CWinApp *g_pApp = nullptr;
}

CWinApp::CWinApp(LPCTSTR lpszAppName) : m_pszAppName(lpszAppName) {
	g_pApp = this;
}

CWinApp::~CWinApp() {
	if (g_pApp == this)
		g_pApp = nullptr;
}

CWinApp *AfxGetApp() {
	return g_pApp;
}

CWnd *AfxGetMainWnd() {
	return g_pApp ? g_pApp->m_pMainWnd : nullptr;
}

int AfxMessageBox(LPCTSTR lpszText, UINT nType, UINT) {
	return dnft_compat::ReportMessage(lpszText, nType);
}

int AfxMessageBox(UINT nIDPrompt, UINT nType, UINT) {
	return dnft_compat::ReportMessage(StringOrId(nIDPrompt), nType);
}

void AfxFormatString1(CString &rString, UINT nIDS, LPCTSTR lpsz1) {
	rString = SubstitutePlaceholders(StringOrId(nIDS), {lpsz1});
}

void AfxFormatString2(CString &rString, UINT nIDS, LPCTSTR lpsz1, LPCTSTR lpsz2) {
	rString = SubstitutePlaceholders(StringOrId(nIDS), {lpsz1, lpsz2});
}

// ---- Win32 -------------------------------------------------------------------------------------------

int MessageBoxA(HWND, LPCSTR lpText, LPCSTR, UINT uType) {
	return dnft_compat::ReportMessage(lpText, uType);
}

// Files, on the ones CFile keeps in memory.

namespace {
DWORD g_LastError = ERROR_SUCCESS;

BOOL Fail(DWORD error) {
	g_LastError = error;
	return FALSE;
}
}

DWORD GetLastError() {
	return g_LastError;
}

void SetLastError(DWORD dwErrCode) {
	g_LastError = dwErrCode;
}

UINT GetTempFileName(LPCTSTR, LPCTSTR lpPrefixString, UINT uUnique, LPTSTR lpTempFileName) {
	// Unlike Windows the name does not depend on the directory: nothing else is there.
	static UINT counter = 0;
	UINT unique = uUnique ? uUnique : ++counter;
	std::snprintf(lpTempFileName, MAX_PATH, "memory/tmp/%.3s%04X.tmp", lpPrefixString ? lpPrefixString : "", unique & 0xFFFF);
	if (!uUnique)
		Files()[lpTempFileName] = std::make_shared<std::vector<unsigned char>>();	// as Windows does
	return unique;
}

BOOL CopyFile(LPCTSTR lpExistingFileName, LPCTSTR lpNewFileName, BOOL bFailIfExists) {
	auto &files = Files();
	auto it = files.find(lpExistingFileName);
	if (it == files.end())
		return Fail(ERROR_FILE_NOT_FOUND);
	if (bFailIfExists && files.count(lpNewFileName))
		return Fail(ERROR_FILE_EXISTS);
	files[lpNewFileName] = std::make_shared<std::vector<unsigned char>>(*it->second);
	return TRUE;
}

BOOL DeleteFile(LPCTSTR lpFileName) {
	if (!Files().erase(lpFileName))
		return Fail(ERROR_FILE_NOT_FOUND);
	return TRUE;
}

BOOL MoveFileEx(LPCTSTR lpExistingFileName, LPCTSTR lpNewFileName, DWORD dwFlags) {
	auto &files = Files();
	auto it = files.find(lpExistingFileName);
	if (it == files.end())
		return Fail(ERROR_FILE_NOT_FOUND);
	if (!(dwFlags & MOVEFILE_REPLACE_EXISTING) && files.count(lpNewFileName))
		return Fail(ERROR_ALREADY_EXISTS);
	auto content = it->second;
	files.erase(it);
	files[lpNewFileName] = std::move(content);
	return TRUE;
}

BOOL ReplaceFile(LPCTSTR lpReplacedFileName, LPCTSTR lpReplacementFileName, LPCTSTR lpBackupFileName, DWORD, LPVOID, LPVOID) {
	// The file to replace has to exist; callers fall back to MoveFileEx() when it does not.
	auto &files = Files();
	if (!files.count(lpReplacedFileName) || !files.count(lpReplacementFileName))
		return Fail(ERROR_FILE_NOT_FOUND);
	if (lpBackupFileName && !CopyFile(lpReplacedFileName, lpBackupFileName, FALSE))
		return FALSE;
	return MoveFileEx(lpReplacementFileName, lpReplacedFileName, MOVEFILE_REPLACE_EXISTING);
}

namespace {
// Events only need to exist: nothing waits on them without a second thread.
struct EventObject {
	bool signaled;
};
}

HANDLE CreateEventA(void *, BOOL, BOOL bInitialState, LPCSTR) {
	return new EventObject {bInitialState != FALSE};
}

BOOL SetEvent(HANDLE hEvent) {
	if (!hEvent)
		return FALSE;
	static_cast<EventObject *>(hEvent)->signaled = true;
	return TRUE;
}

BOOL ResetEvent(HANDLE hEvent) {
	if (!hEvent)
		return FALSE;
	static_cast<EventObject *>(hEvent)->signaled = false;
	return TRUE;
}

BOOL CloseHandle(HANDLE hObject) {
	delete static_cast<EventObject *>(hObject);
	return TRUE;
}

DWORD WaitForSingleObject(HANDLE hHandle, DWORD) {
	return hHandle && static_cast<EventObject *>(hHandle)->signaled ? WAIT_OBJECT_0 : WAIT_TIMEOUT;
}

DWORD FormatMessage(DWORD dwFlags, LPCVOID, DWORD dwMessageId, DWORD, LPTSTR lpBuffer, DWORD nSize, va_list *) {
	static char text[64];
	std::snprintf(text, sizeof(text), "system error %u", dwMessageId);
	if (dwFlags & FORMAT_MESSAGE_ALLOCATE_BUFFER) {
		// the caller passes a pointer to its pointer and LocalFree()s it afterwards
		*reinterpret_cast<LPTSTR *>(lpBuffer) = text;
		return static_cast<DWORD>(std::strlen(text));
	}
	std::snprintf(lpBuffer, nSize, "%s", text);
	return static_cast<DWORD>(std::strlen(lpBuffer));
}
