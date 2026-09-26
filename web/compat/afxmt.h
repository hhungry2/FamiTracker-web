/*
** Dn-FamiTracker web port - MFC compatibility layer
**
** This program is free software: you can redistribute it and/or modify
** it under the terms of the GNU General Public License as published by
** the Free Software Foundation, either version 3 of the License, or
** (at your option) any later version.
*/

// MFC synchronization objects. The web build drives the engine from a single thread,
// so a lock only has to count its owner's recursion the way a Win32 mutex does.

#pragma once

#include "afx.h"

class CSyncObject : public CObject {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CSyncObject", CObject::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
	virtual BOOL Lock(DWORD = INFINITE) { ++m_iLockCount; return TRUE; }
	virtual BOOL Unlock() {
		if (m_iLockCount == 0)
			return FALSE;
		--m_iLockCount;
		return TRUE;
	}
	bool IsLocked() const { return m_iLockCount != 0; }
protected:
	unsigned m_iLockCount = 0;
};

class CMutex : public CSyncObject {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CMutex", CSyncObject::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
	explicit CMutex(BOOL bInitiallyOwn = FALSE, LPCTSTR = nullptr, void * = nullptr) {
		if (bInitiallyOwn)
			Lock();
	}
};

class CCriticalSection : public CSyncObject {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CCriticalSection", CSyncObject::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
};

class CEvent : public CSyncObject {
public:
	static const CRuntimeClass *GetThisClass() {
		static const CRuntimeClass rc {"CEvent", CSyncObject::GetThisClass()};
		return &rc;
	}
	const CRuntimeClass *GetRuntimeClass() const override { return GetThisClass(); }
	explicit CEvent(BOOL bInitiallyOwn = FALSE, BOOL bManualReset = FALSE, LPCTSTR = nullptr, void * = nullptr) :
		m_bSignaled(bInitiallyOwn), m_bManualReset(bManualReset) {}
	BOOL SetEvent() { m_bSignaled = TRUE; return TRUE; }
	BOOL ResetEvent() { m_bSignaled = FALSE; return TRUE; }
	BOOL PulseEvent() { m_bSignaled = FALSE; return TRUE; }
	BOOL Lock(DWORD = INFINITE) override {
		BOOL was = m_bSignaled;
		if (!m_bManualReset)
			m_bSignaled = FALSE;
		return was;
	}
	BOOL Unlock() override { return TRUE; }
private:
	BOOL m_bSignaled;
	BOOL m_bManualReset;
};

class CSingleLock {
public:
	explicit CSingleLock(CSyncObject *pObject, BOOL bInitialLock = FALSE) : m_pObject(pObject) {
		if (bInitialLock)
			Lock();
	}
	~CSingleLock() { Unlock(); }
	CSingleLock(const CSingleLock &) = delete;
	CSingleLock &operator=(const CSingleLock &) = delete;
	BOOL Lock(DWORD dwTimeOut = INFINITE) {
		if (m_bAcquired)
			return TRUE;
		m_bAcquired = m_pObject && m_pObject->Lock(dwTimeOut);
		return m_bAcquired;
	}
	BOOL Unlock() {
		if (!m_bAcquired)
			return TRUE;
		m_bAcquired = FALSE;
		return m_pObject->Unlock();
	}
	BOOL IsLocked() { return m_bAcquired; }
private:
	CSyncObject *m_pObject;
	BOOL m_bAcquired = FALSE;
};
