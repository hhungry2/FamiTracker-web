/*
** Dn-FamiTracker web port - MFC compatibility layer
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// The part of MFC that the tracker core (document, instruments, sound generator)
// is written against, rebuilt on the standard library so those sources compile
// unchanged outside Windows.
//
// Classes that only exist to host windows (CWnd, CFrameWnd, CDialog...) are empty
// shells: the core names them in declarations and null checks, never draws with them.
// CString and CFile are real implementations.

#pragma once

#define __AFX_H__
#define __AFXWIN_H__
#define _AFX_NO_AFXCMN_SUPPORT

#include "windows.h"

#include <algorithm>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

class CString;
class CArchive;
class CDumpContext;
class CDocument;
class CDocTemplate;
class CFrameWnd;
class CView;
class CWnd;
class CCmdUI;
class CDataExchange;
class CFileException;

typedef void *POSITION;

// ---- diagnostics ---------------------------------------------------------------------

namespace dnft_compat {
// Where MFC would show a message box. The host installs a handler (see dnft_compat.h);
// without one the text goes to stderr.
int ReportMessage(const char *text, unsigned int type);
void ReportAssertion(const char *file, int line, const char *expr);
// Text for a string table ID (IDS_...), or nullptr when the build does not carry it.
const char *LoadStringResource(unsigned int id);
}

#ifdef DNFT_DEBUG
#define ASSERT(f) ((f) ? (void)0 : ::dnft_compat::ReportAssertion(__FILE__, __LINE__, #f))
#define VERIFY(f) ASSERT(f)
#else
#define ASSERT(f) ((void)0)
#define VERIFY(f) ((void)(f))
#endif
#define ASSERT_VALID(p) ((void)0)
#define ASSERT_KINDOF(c, p) ((void)0)
#define ASSERT_POINTER(p, t) ((void)0)
#define DEBUG_NEW new
#define AFX_CDECL
#define AFX_DATA
#define AFX_NOVTABLE
#define AFXAPI
#define afx_msg
#define AFX_INLINE inline

inline void AfxDebugBreak() {}

#ifndef TRACE
#define TRACE(...) ((void)0)
#endif

// ---- run-time class information --------------------------------------------------------
// Only the spelling survives: the core never creates objects by class name.

class CObject;

struct CRuntimeClass {
	const char *m_lpszClassName;
	const CRuntimeClass *m_pBaseClass;
	BOOL IsDerivedFrom(const CRuntimeClass *pBaseClass) const {
		for (const CRuntimeClass *p = this; p; p = p->m_pBaseClass)
			if (p == pBaseClass)
				return TRUE;
		return FALSE;
	}
};

#define RUNTIME_CLASS(class_name) (class_name::GetThisClass())

#define DECLARE_DYNAMIC(class_name) \
public: \
	static const CRuntimeClass *GetThisClass(); \
	virtual const CRuntimeClass *GetRuntimeClass() const override;
#define DECLARE_DYNCREATE(class_name) 	DECLARE_DYNAMIC(class_name) 	static CObject *CreateObject();
#define DECLARE_SERIAL(class_name) DECLARE_DYNAMIC(class_name)

#define IMPLEMENT_DYNAMIC(class_name, base_class_name) \
	const CRuntimeClass *class_name::GetThisClass() { \
		static const CRuntimeClass rc {#class_name, base_class_name::GetThisClass()}; \
		return &rc; \
	} \
	const CRuntimeClass *class_name::GetRuntimeClass() const { return GetThisClass(); }
#define IMPLEMENT_DYNCREATE(class_name, base_class_name) 	IMPLEMENT_DYNAMIC(class_name, base_class_name) 	CObject *class_name::CreateObject() { return new class_name; }
#define IMPLEMENT_SERIAL(class_name, base_class_name, wSchema) IMPLEMENT_DYNAMIC(class_name, base_class_name)

// Message maps route window messages; there are no windows.
#define DECLARE_MESSAGE_MAP()
#define BEGIN_MESSAGE_MAP(theClass, baseClass)
#define END_MESSAGE_MAP()
#define ON_COMMAND(id, memberFxn)
#define ON_COMMAND_RANGE(id, idLast, memberFxn)
#define ON_UPDATE_COMMAND_UI(id, memberFxn)
#define ON_UPDATE_COMMAND_UI_RANGE(id, idLast, memberFxn)
#define ON_MESSAGE(message, memberFxn)
#define ON_THREAD_MESSAGE(message, memberFxn)
#define ON_REGISTERED_MESSAGE(message, memberFxn)
#define ON_NOTIFY(code, id, memberFxn)
#define ON_BN_CLICKED(id, memberFxn)
#define ON_WM_TIMER()

class CObject {
public:
	virtual ~CObject() = default;
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CObject", nullptr};
		return &rc;
	}
	virtual const CRuntimeClass *GetRuntimeClass() const { return GetThisClass(); }
	BOOL IsKindOf(const CRuntimeClass *pClass) const { return GetRuntimeClass()->IsDerivedFrom(pClass); }
	virtual void Serialize(CArchive &) {}
	virtual void AssertValid() const {}
	virtual void Dump(CDumpContext &) const {}
protected:
	CObject() = default;
};

class CDumpContext {
public:
	template <typename T>
	CDumpContext &operator<<(const T &) { return *this; }
};
extern CDumpContext afxDump;

class CArchive {
public:
	BOOL IsStoring() const { return FALSE; }
	BOOL IsLoading() const { return TRUE; }
};

// ---- CString ---------------------------------------------------------------------------
// MFC's CStringT<char> over std::string. GetBuffer() hands out the string's own storage,
// as MFC does; ReleaseBuffer() re-measures it.

class CString {
public:
	CString() = default;
	CString(const CString &) = default;
	CString(CString &&) noexcept = default;
	CString(const char *s) : m_str(s ? s : "") {}
	CString(const char *s, int length) : m_str(s ? s : "", s ? std::max(0, length) : 0) {}
	CString(char ch, int repeat = 1) : m_str(std::max(0, repeat), ch) {}
	CString(const unsigned char *s) : CString(reinterpret_cast<const char *>(s)) {}
	// not in ATL: explicit, so that overloads taking both CString and std::string_view
	// stay unambiguous
	explicit CString(const std::string &s) : m_str(s) {}
	explicit CString(std::string &&s) noexcept : m_str(std::move(s)) {}
	explicit CString(std::string_view s) : m_str(s) {}

	CString &operator=(const CString &) = default;
	CString &operator=(CString &&) noexcept = default;
	CString &operator=(const char *s) { m_str = s ? s : ""; return *this; }
	CString &operator=(char ch) { m_str.assign(1, ch); return *this; }

	// what LPCTSTR parameters receive
	operator const char *() const { return m_str.c_str(); }
	const char *GetString() const { return m_str.c_str(); }
	const std::string &str() const { return m_str; }

	int GetLength() const { return static_cast<int>(m_str.size()); }
	int GetAllocLength() const { return static_cast<int>(m_str.capacity()); }
	bool IsEmpty() const { return m_str.empty(); }
	void Empty() { m_str.clear(); }
	char GetAt(int i) const { return m_str[static_cast<size_t>(i)]; }
	void SetAt(int i, char ch) { m_str[static_cast<size_t>(i)] = ch; }
	char operator[](int i) const { return m_str[static_cast<size_t>(i)]; }

	char *GetBuffer() { return m_str.data(); }
	char *GetBuffer(int minLength) {
		if (minLength > 0 && static_cast<size_t>(minLength) > m_str.size())
			m_str.resize(static_cast<size_t>(minLength));
		return m_str.data();
	}
	char *GetBufferSetLength(int length) {
		m_str.resize(static_cast<size_t>(std::max(0, length)));
		return m_str.data();
	}
	void ReleaseBuffer(int newLength = -1) {
		if (newLength < 0)
			m_str.resize(std::strlen(m_str.c_str()));
		else
			m_str.resize(static_cast<size_t>(newLength));
	}
	void Preallocate(int length) { m_str.reserve(static_cast<size_t>(std::max(0, length))); }
	void Truncate(int length) { if (length >= 0 && static_cast<size_t>(length) < m_str.size()) m_str.resize(static_cast<size_t>(length)); }

	void Format(const char *fmt, ...) {
		va_list args;
		va_start(args, fmt);
		FormatV(fmt, args);
		va_end(args);
	}
	void FormatV(const char *fmt, va_list args) {
		m_str.clear();
		AppendFormatV(fmt, args);
	}
	void AppendFormat(const char *fmt, ...) {
		va_list args;
		va_start(args, fmt);
		AppendFormatV(fmt, args);
		va_end(args);
	}
	void AppendFormatV(const char *fmt, va_list args) {
		va_list copy;
		va_copy(copy, args);
		int n = std::vsnprintf(nullptr, 0, fmt, copy);
		va_end(copy);
		if (n <= 0)
			return;
		size_t at = m_str.size();
		m_str.resize(at + static_cast<size_t>(n) + 1);
		std::vsnprintf(m_str.data() + at, static_cast<size_t>(n) + 1, fmt, args);
		m_str.resize(at + static_cast<size_t>(n));
	}
	// Format(UINT nFormatID, ...) takes the format from the string table
	void Format(UINT nFormatID, ...);
	BOOL LoadString(UINT nID);
	BOOL LoadString(HINSTANCE, UINT nID) { return LoadString(nID); }

	void Append(const char *s) { if (s) m_str += s; }
	void Append(const char *s, int length) { if (s && length > 0) m_str.append(s, static_cast<size_t>(length)); }
	void Append(const CString &s) { m_str += s.m_str; }
	void AppendChar(char ch) { m_str += ch; }

	CString &operator+=(const CString &s) { m_str += s.m_str; return *this; }
	CString &operator+=(const char *s) { if (s) m_str += s; return *this; }
	CString &operator+=(char ch) { m_str += ch; return *this; }
	CString &operator+=(const std::string &s) { m_str += s; return *this; }

	CString Left(int n) const { return CString(m_str.substr(0, Clamp(n))); }
	CString Right(int n) const {
		size_t k = Clamp(n);
		return CString(m_str.substr(m_str.size() - k));
	}
	CString Mid(int first) const { return CString(m_str.substr(Clamp(first))); }
	CString Mid(int first, int count) const {
		size_t f = Clamp(first);
		return CString(m_str.substr(f, count < 0 ? 0 : static_cast<size_t>(count)));
	}

	int Find(char ch, int start = 0) const { return Pos(m_str.find(ch, Clamp(start))); }
	int Find(const char *s, int start = 0) const { return Pos(m_str.find(s, Clamp(start))); }
	int ReverseFind(char ch) const { return Pos(m_str.rfind(ch)); }
	int FindOneOf(const char *set) const { return Pos(m_str.find_first_of(set)); }

	int Replace(char from, char to) {
		int n = 0;
		for (auto &c : m_str)
			if (c == from) { c = to; ++n; }
		return n;
	}
	int Replace(const char *from, const char *to) {
		size_t flen = std::strlen(from);
		if (!flen)
			return 0;
		size_t tlen = std::strlen(to);
		int n = 0;
		for (size_t at = m_str.find(from); at != std::string::npos; at = m_str.find(from, at + tlen)) {
			m_str.replace(at, flen, to);
			++n;
		}
		return n;
	}
	int Remove(char ch) {
		size_t before = m_str.size();
		m_str.erase(std::remove(m_str.begin(), m_str.end(), ch), m_str.end());
		return static_cast<int>(before - m_str.size());
	}
	int Insert(int index, char ch) { m_str.insert(Clamp(index), 1, ch); return GetLength(); }
	int Insert(int index, const char *s) { m_str.insert(Clamp(index), s ? s : ""); return GetLength(); }
	int Delete(int index, int count = 1) {
		size_t at = Clamp(index);
		if (count > 0)
			m_str.erase(at, static_cast<size_t>(count));
		return GetLength();
	}

	CString &TrimLeft() { return TrimLeft(" \t\r\n\v\f"); }
	CString &TrimRight() { return TrimRight(" \t\r\n\v\f"); }
	CString &Trim() { return TrimRight().TrimLeft(); }
	CString &TrimLeft(char ch) { const char set[2] = {ch, 0}; return TrimLeft(set); }
	CString &TrimRight(char ch) { const char set[2] = {ch, 0}; return TrimRight(set); }
	CString &Trim(char ch) { return TrimRight(ch).TrimLeft(ch); }
	CString &TrimLeft(const char *set) { m_str.erase(0, m_str.find_first_not_of(set)); return *this; }
	CString &TrimRight(const char *set) {
		size_t last = m_str.find_last_not_of(set);
		m_str.erase(last == std::string::npos ? 0 : last + 1);
		return *this;
	}
	CString &Trim(const char *set) { return TrimRight(set).TrimLeft(set); }

	CString &MakeUpper() { for (auto &c : m_str) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c))); return *this; }
	CString &MakeLower() { for (auto &c : m_str) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c))); return *this; }
	CString &MakeReverse() { std::reverse(m_str.begin(), m_str.end()); return *this; }

	int Compare(const char *s) const { return std::strcmp(m_str.c_str(), s ? s : ""); }
	int CompareNoCase(const char *s) const { return strcasecmp(m_str.c_str(), s ? s : ""); }

	CString SpanIncluding(const char *set) const {
		size_t n = m_str.find_first_not_of(set);
		return CString(m_str.substr(0, n));
	}
	CString SpanExcluding(const char *set) const {
		size_t n = m_str.find_first_of(set);
		return CString(m_str.substr(0, n));
	}
	CString Tokenize(const char *delims, int &start) const {
		if (start < 0 || static_cast<size_t>(start) >= m_str.size()) {
			start = -1;
			return CString();
		}
		size_t first = m_str.find_first_not_of(delims, static_cast<size_t>(start));
		if (first == std::string::npos) {
			start = -1;
			return CString();
		}
		size_t last = m_str.find_first_of(delims, first);
		if (last == std::string::npos)
			last = m_str.size();
		start = static_cast<int>(last + 1);
		return CString(m_str.substr(first, last - first));
	}

	friend CString operator+(const CString &a, const CString &b) { return CString(a.m_str + b.m_str); }
	friend CString operator+(const CString &a, const char *b) { return CString(a.m_str + (b ? b : "")); }
	friend CString operator+(const char *a, const CString &b) { return CString((a ? std::string(a) : std::string()) + b.m_str); }
	friend CString operator+(const CString &a, char b) { return CString(a.m_str + b); }
	friend CString operator+(char a, const CString &b) { return CString(std::string(1, a) + b.m_str); }

	friend bool operator==(const CString &a, const CString &b) { return a.m_str == b.m_str; }
	friend bool operator==(const CString &a, const char *b) { return a.m_str == (b ? b : ""); }
	friend bool operator==(const char *a, const CString &b) { return b == a; }
	friend bool operator!=(const CString &a, const CString &b) { return !(a == b); }
	friend bool operator!=(const CString &a, const char *b) { return !(a == b); }
	friend bool operator!=(const char *a, const CString &b) { return !(b == a); }
	friend bool operator<(const CString &a, const CString &b) { return a.m_str < b.m_str; }
	friend bool operator>(const CString &a, const CString &b) { return a.m_str > b.m_str; }

private:
	size_t Clamp(int n) const {
		return n <= 0 ? 0 : std::min(static_cast<size_t>(n), m_str.size());
	}
	static int Pos(size_t at) { return at == std::string::npos ? -1 : static_cast<int>(at); }

	std::string m_str;
};

typedef CString CStringA;

inline std::string_view to_sv(const CString &str) { return str.str(); }

// ATL string conversions. The desktop build is multibyte, so every one of them is a copy.
class CT2CA {
public:
	CT2CA(const char *s) : m_str(s ? s : ""), m_psz(m_str.c_str()) {}
	CT2CA(const CT2CA &) = delete;
	CT2CA &operator=(const CT2CA &) = delete;
	operator const char *() const { return m_psz; }
private:
	std::string m_str;
public:
	const char *m_psz;
};
class CT2A {
public:
	CT2A(const char *s) : m_str(s ? s : ""), m_psz(m_str.data()) {}
	CT2A(const CT2A &) = delete;
	CT2A &operator=(const CT2A &) = delete;
	operator char *() const { return m_psz; }
private:
	std::string m_str;
public:
	char *m_psz;
};
typedef CT2CA CA2CT;
typedef CT2CA CA2CA;
typedef CT2CA CT2CT;
typedef CT2A CA2T;
typedef CT2A CA2A;
typedef CT2A CT2T;

// ---- collections ---------------------------------------------------------------------------
// Declared with MFC's template parameters; stored in the standard containers.

template <typename TYPE, typename ARG_TYPE = const TYPE &>
class CArray : public CObject {
public:
	INT_PTR GetSize() const { return static_cast<INT_PTR>(m_data.size()); }
	INT_PTR GetCount() const { return GetSize(); }
	BOOL IsEmpty() const { return m_data.empty(); }
	INT_PTR GetUpperBound() const { return GetSize() - 1; }
	void SetSize(INT_PTR nNewSize, INT_PTR = -1) { m_data.resize(static_cast<size_t>(nNewSize)); }
	void RemoveAll() { m_data.clear(); }
	const TYPE &GetAt(INT_PTR i) const { return m_data[static_cast<size_t>(i)]; }
	TYPE &GetAt(INT_PTR i) { return m_data[static_cast<size_t>(i)]; }
	void SetAt(INT_PTR i, ARG_TYPE e) { m_data[static_cast<size_t>(i)] = e; }
	void SetAtGrow(INT_PTR i, ARG_TYPE e) {
		if (i >= GetSize())
			SetSize(i + 1);
		SetAt(i, e);
	}
	const TYPE &operator[](INT_PTR i) const { return GetAt(i); }
	TYPE &operator[](INT_PTR i) { return GetAt(i); }
	INT_PTR Add(ARG_TYPE e) { m_data.push_back(e); return GetSize() - 1; }
	void InsertAt(INT_PTR i, ARG_TYPE e, INT_PTR n = 1) {
		m_data.insert(m_data.begin() + i, static_cast<size_t>(n), e);
	}
	void RemoveAt(INT_PTR i, INT_PTR n = 1) { m_data.erase(m_data.begin() + i, m_data.begin() + i + n); }
	TYPE *GetData() { return m_data.data(); }
	const TYPE *GetData() const { return m_data.data(); }
private:
	std::vector<TYPE> m_data;
};

class CStringArray : public CArray<CString, LPCTSTR> {};
class CByteArray : public CArray<BYTE, BYTE> {};
class CWordArray : public CArray<WORD, WORD> {};
class CDWordArray : public CArray<DWORD, DWORD> {};
class CUIntArray : public CArray<UINT, UINT> {};

template <typename KEY, typename ARG_KEY, typename VALUE, typename ARG_VALUE>
class CMap : public CObject {
public:
	INT_PTR GetCount() const { return static_cast<INT_PTR>(m_data.size()); }
	INT_PTR GetSize() const { return GetCount(); }
	BOOL IsEmpty() const { return m_data.empty(); }
	BOOL Lookup(ARG_KEY key, VALUE &rValue) const {
		auto it = m_data.find(KEY(key));
		if (it == m_data.end())
			return FALSE;
		rValue = it->second;
		return TRUE;
	}
	VALUE &operator[](ARG_KEY key) { return m_data[KEY(key)]; }
	void SetAt(ARG_KEY key, ARG_VALUE newValue) { m_data[KEY(key)] = newValue; }
	BOOL RemoveKey(ARG_KEY key) { return m_data.erase(KEY(key)) != 0; }
	void RemoveAll() { m_data.clear(); }
	// POSITION is a 1-based index into the ordered map
	POSITION GetStartPosition() const { return m_data.empty() ? nullptr : reinterpret_cast<POSITION>(1); }
	void GetNextAssoc(POSITION &rNextPosition, KEY &rKey, VALUE &rValue) const {
		size_t index = reinterpret_cast<size_t>(rNextPosition) - 1;
		auto it = std::next(m_data.begin(), static_cast<std::ptrdiff_t>(index));
		rKey = it->first;
		rValue = it->second;
		rNextPosition = index + 1 < m_data.size() ? reinterpret_cast<POSITION>(index + 2) : nullptr;
	}
private:
	std::map<KEY, VALUE> m_data;
};

// ---- exceptions ---------------------------------------------------------------------------

class CException : public CObject {
public:
	virtual BOOL GetErrorMessage(LPTSTR lpszError, UINT nMaxError, PUINT pnHelpContext = nullptr) const {
		if (pnHelpContext)
			*pnHelpContext = 0;
		if (nMaxError)
			lpszError[0] = 0;
		return FALSE;
	}
	virtual int ReportError(UINT nType = MB_OK, UINT nMessageID = 0);
	void Delete() { delete this; }
};

class CMemoryException : public CException {};
class CNotSupportedException : public CException {};
class CUserException : public CException {};

class CFileException : public CException {
public:
	enum {
		none, genericException, fileNotFound, badPath, tooManyOpenFiles, accessDenied,
		invalidFile, removeCurrentDir, directoryFull, badSeek, hardIO, sharingViolation,
		lockViolation, diskFull, endOfFile
	};
	explicit CFileException(int cause = none, LONG lOsError = -1, LPCTSTR lpszArchiveName = nullptr) :
		m_cause(cause), m_lOsError(lOsError), m_strFileName(lpszArchiveName) {}
	BOOL GetErrorMessage(LPTSTR lpszError, UINT nMaxError, PUINT pnHelpContext = nullptr) const override;
	int m_cause;
	LONG m_lOsError;
	CString m_strFileName;
};

[[noreturn]] void AfxThrowFileException(int cause, LONG lOsError = -1, LPCTSTR lpszFileName = nullptr);
[[noreturn]] void AfxThrowMemoryException();
[[noreturn]] void AfxThrowNotSupportedException();
[[noreturn]] void AfxThrowUserException();

// ---- files -------------------------------------------------------------------------------
// Files live in memory, keyed by path (see dnft_compat.h). The host puts a module there
// before the document opens it and collects what the document saves.

class CFile : public CObject {
public:
	enum OpenFlags : UINT {
		modeRead = 0x0000,
		modeWrite = 0x0001,
		modeReadWrite = 0x0002,
		shareCompat = 0x0000,
		shareExclusive = 0x0010,
		shareDenyWrite = 0x0020,
		shareDenyRead = 0x0030,
		shareDenyNone = 0x0040,
		modeNoInherit = 0x0080,
		modeCreate = 0x1000,
		modeNoTruncate = 0x2000,
		typeText = 0x4000,
		typeBinary = 0x8000,
	};
	enum SeekPosition { begin = 0x0, current = 0x1, end = 0x2 };
	static const HANDLE hFileNull;

	CFile();
	CFile(LPCTSTR lpszFileName, UINT nOpenFlags);
	~CFile() override;
	CFile(const CFile &) = delete;
	CFile &operator=(const CFile &) = delete;

	virtual BOOL Open(LPCTSTR lpszFileName, UINT nOpenFlags, CFileException *pError = nullptr);
	virtual void Close();
	virtual void Abort();
	virtual void Flush() {}
	virtual UINT Read(void *lpBuf, UINT nCount);
	virtual void Write(const void *lpBuf, UINT nCount);
	virtual ULONGLONG Seek(LONGLONG lOff, UINT nFrom);
	void SeekToBegin() { Seek(0, begin); }
	ULONGLONG SeekToEnd() { return Seek(0, end); }
	virtual ULONGLONG GetLength() const;
	virtual ULONGLONG GetPosition() const;
	virtual void SetLength(ULONGLONG dwNewLen);
	virtual CString GetFileName() const;
	virtual CString GetFilePath() const { return m_strFileName; }

	operator HANDLE() const { return m_hFile; }

	HANDLE m_hFile;

protected:
	CString m_strFileName;

private:
	std::shared_ptr<std::vector<unsigned char>> m_pData;
	size_t m_iPos = 0;
	bool m_bWrite = false;
};

class CStdioFile : public CFile {
public:
	CStdioFile() = default;
	CStdioFile(LPCTSTR lpszFileName, UINT nOpenFlags) : CFile(lpszFileName, nOpenFlags) {}
	virtual BOOL ReadString(CString &rString);
	virtual void WriteString(LPCTSTR lpsz);
};

// ---- application framework shells ---------------------------------------------------------

class CCmdTarget : public CObject {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CCmdTarget", CObject::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
};

class CWnd : public CCmdTarget {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CWnd", CCmdTarget::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
	HWND GetSafeHwnd() const { return m_hWnd; }
	BOOL PostMessage(UINT, WPARAM = 0, LPARAM = 0) { return FALSE; }
	LRESULT SendMessage(UINT, WPARAM = 0, LPARAM = 0) { return 0; }
	BOOL IsWindowVisible() const { return FALSE; }
	void Invalidate(BOOL = TRUE) {}
	void RedrawWindow() {}
	void SetWindowText(LPCTSTR) {}
	HWND m_hWnd = nullptr;
};

class CFrameWnd : public CWnd {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CFrameWnd", CWnd::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
	virtual CDocument *GetActiveDocument() { return nullptr; }
	virtual CView *GetActiveView() const { return nullptr; }
	void SetMessageText(LPCTSTR) {}
	void SetMessageText(UINT) {}
	virtual void OnUpdateFrameTitle(BOOL) {}
};

class CView : public CWnd {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CView", CWnd::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
	CDocument *GetDocument() const { return m_pDocument; }
protected:
	CDocument *m_pDocument = nullptr;
};

class CDialog : public CWnd {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CDialog", CWnd::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
	CDialog() = default;
	explicit CDialog(UINT, CWnd * = nullptr) {}
	explicit CDialog(LPCTSTR, CWnd * = nullptr) {}
	virtual INT_PTR DoModal() { return IDCANCEL; }
	virtual BOOL OnInitDialog() { return TRUE; }
	virtual void OnOK() {}
	virtual void OnCancel() {}
	virtual void DoDataExchange(CDataExchange *) {}
	void EndDialog(int) {}
};

class CDialogEx : public CDialog {
public:
	using CDialog::CDialog;
};

// Controls the core only ever points at.
class CControlBar : public CWnd {};
class CToolBar : public CControlBar {};
class CStatusBar : public CControlBar {};
class CDialogBar : public CControlBar {};
class CReBar : public CControlBar {};
class CButton : public CWnd {};
class CEdit : public CWnd {};
class CStatic : public CWnd {};
class CComboBox : public CWnd {};
class CListBox : public CWnd {};
class CListCtrl : public CWnd {};
class CTreeCtrl : public CWnd {};
class CSliderCtrl : public CWnd {};
class CSpinButtonCtrl : public CWnd {};
class CScrollBar : public CWnd {};
class CTabCtrl : public CWnd {};
class CRichEditCtrl : public CWnd {};
class CToolTipCtrl : public CWnd {};
class CProgressCtrl : public CWnd {};
class CDataExchange {};
class CGdiObject : public CObject {};
class CFont : public CGdiObject {};
class CBitmap : public CGdiObject {};
class CBrush : public CGdiObject {};
class CPen : public CGdiObject {};
class CDC : public CObject {};
class CImageList : public CObject {};
class CMenu : public CObject {};
class CPoint : public POINT { public: CPoint(LONG ix = 0, LONG iy = 0) { x = ix; y = iy; } };
class CSize : public SIZE { public: CSize(LONG ix = 0, LONG iy = 0) { cx = ix; cy = iy; } };
class CRect : public RECT {
public:
	CRect(LONG l = 0, LONG t = 0, LONG r = 0, LONG b = 0) { left = l; top = t; right = r; bottom = b; }
	LONG Width() const { return right - left; }
	LONG Height() const { return bottom - top; }
};

class CCmdUI {
public:
	virtual ~CCmdUI() = default;
	virtual void Enable(BOOL = TRUE) {}
	virtual void SetCheck(int = 1) {}
	virtual void SetText(LPCTSTR) {}
	UINT m_nID = 0;
};

class CDocument : public CCmdTarget {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CDocument", CCmdTarget::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }

	virtual BOOL OnNewDocument() { DeleteContents(); SetModifiedFlag(FALSE); return TRUE; }
	virtual BOOL OnOpenDocument(LPCTSTR) { return FALSE; }
	virtual BOOL OnSaveDocument(LPCTSTR) { return FALSE; }
	virtual void OnCloseDocument() {}
	virtual void DeleteContents() {}
	virtual void SetModifiedFlag(BOOL bModified = TRUE) { m_bModified = bModified; }
	virtual BOOL IsModified() { return m_bModified; }
	virtual BOOL DoSave(LPCTSTR, BOOL = TRUE) { return FALSE; }
	virtual void OnFileSave() {}
	virtual void SetPathName(LPCTSTR lpszPathName, BOOL = TRUE) { m_strPathName = lpszPathName; }
	const CString &GetPathName() const { return m_strPathName; }
	virtual void SetTitle(LPCTSTR lpszTitle) { m_strTitle = lpszTitle; }
	const CString &GetTitle() const { return m_strTitle; }
	void UpdateAllViews(CView *, LPARAM = 0L, CObject * = nullptr) {}
	POSITION GetFirstViewPosition() const { return nullptr; }
	CView *GetNextView(POSITION &) const { return nullptr; }
	CDocTemplate *GetDocTemplate() const { return nullptr; }

protected:
	BOOL m_bModified = FALSE;
	CString m_strPathName;
	CString m_strTitle;
};

class CDocTemplate : public CCmdTarget {
public:
	enum DocStringIndex { windowTitle, docName, fileNewName, filterName, filterExt, regFileTypeId, regFileTypeName };
	enum Confidence { noAttempt, maybeAttemptForeign, maybeAttemptNative, yesAttemptForeign, yesAttemptNative, yesAlreadyOpen };
	CDocTemplate(UINT, const CRuntimeClass *, const CRuntimeClass *, const CRuntimeClass *) {}
	virtual BOOL GetDocString(CString &rString, DocStringIndex) const { rString.Empty(); return FALSE; }
	virtual Confidence MatchDocType(LPCTSTR, CDocument *&rpDocMatch) { rpDocMatch = nullptr; return noAttempt; }
};

class CSingleDocTemplate : public CDocTemplate {
public:
	using CDocTemplate::CDocTemplate;
};

class CDocManager : public CObject {
public:
	virtual BOOL DoPromptFileName(CString &, UINT, DWORD, BOOL, CDocTemplate *) { return FALSE; }
};

class CCommandLineInfo : public CObject {
public:
	virtual void ParseParam(const TCHAR *, BOOL, BOOL) {}
	CString m_strFileName;
};

class CWinThread : public CCmdTarget {
public:
	virtual BOOL InitInstance() { return TRUE; }
	virtual int ExitInstance() { return 0; }
	virtual BOOL OnIdle(LONG) { return FALSE; }
	virtual BOOL PreTranslateMessage(MSG *) { return FALSE; }
	HANDLE m_hThread = GetCurrentThread();
	DWORD m_nThreadID = GetCurrentThreadId();
	CWnd *m_pMainWnd = nullptr;
};

// Settings of the desktop build live in the registry. The web build has no registry:
// reads return the defaults the caller passes in, writes are dropped.
class CWinApp : public CWinThread {
public:
	explicit CWinApp(LPCTSTR lpszAppName = nullptr);
	~CWinApp() override;
	virtual UINT GetProfileInt(LPCTSTR, LPCTSTR, int nDefault) { return static_cast<UINT>(nDefault); }
	virtual CString GetProfileString(LPCTSTR, LPCTSTR, LPCTSTR lpszDefault = nullptr) { return CString(lpszDefault); }
	virtual BOOL WriteProfileInt(LPCTSTR, LPCTSTR, int) { return TRUE; }
	virtual BOOL WriteProfileString(LPCTSTR, LPCTSTR, LPCTSTR) { return TRUE; }
	HKEY GetAppRegistryKey() { return nullptr; }
	LONG DelRegTree(HKEY, const CString &) { return ERROR_SUCCESS; }
	virtual BOOL DoPromptFileName(CString &, UINT, DWORD, BOOL, CDocTemplate *) { return FALSE; }
	LPCTSTR m_pszAppName = nullptr;
	LPCTSTR m_pszProfileName = nullptr;
	LPCTSTR m_pszRegistryKey = nullptr;
	HINSTANCE m_hInstance = nullptr;
	CDocManager *m_pDocManager = nullptr;
};

CWinApp *AfxGetApp();
CWnd *AfxGetMainWnd();
inline HINSTANCE AfxGetInstanceHandle() { return nullptr; }
inline HINSTANCE AfxGetResourceHandle() { return nullptr; }

int AfxMessageBox(LPCTSTR lpszText, UINT nType = MB_OK, UINT nIDHelp = 0);
int AfxMessageBox(UINT nIDPrompt, UINT nType = MB_OK, UINT nIDHelp = (UINT)-1);
void AfxFormatString1(CString &rString, UINT nIDS, LPCTSTR lpsz1);
void AfxFormatString2(CString &rString, UINT nIDS, LPCTSTR lpsz1, LPCTSTR lpsz2);

// MFC resource IDs and common dialog flags that appear in the core
#define AFX_IDS_APP_TITLE     0xE000
#define AFX_IDS_SAVEFILE      0xF006
#define AFX_IDS_OPENFILE      0xF005
#define OFN_READONLY          0x00000001
#define OFN_OVERWRITEPROMPT   0x00000002
#define OFN_HIDEREADONLY      0x00000004
#define OFN_PATHMUSTEXIST     0x00000800
#define OFN_FILEMUSTEXIST     0x00001000
#define OFN_ALLOWMULTISELECT  0x00000200
#define OFN_EXPLORER          0x00080000
