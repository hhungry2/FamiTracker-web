// Win32 compatibility layer: the multimedia types CWaveFile keeps as members.
// The web build hands PCM to the host instead of writing wave files.
#pragma once
#include "windows.h"

typedef HANDLE HMMIO;
typedef DWORD FOURCC;

struct WAVEFORMAT {
	WORD nFormatTag;
	WORD nChannels;
	DWORD nSamplesPerSec;
	DWORD nAvgBytesPerSec;
	WORD nBlockAlign;
};
struct PCMWAVEFORMAT {
	WAVEFORMAT wf;
	WORD wBitsPerSample;
};
struct WAVEFORMATEX {
	WORD wFormatTag;
	WORD nChannels;
	DWORD nSamplesPerSec;
	DWORD nAvgBytesPerSec;
	WORD nBlockAlign;
	WORD wBitsPerSample;
	WORD cbSize;
};
struct MMCKINFO {
	FOURCC ckid;
	DWORD cksize;
	FOURCC fccType;
	DWORD dwDataOffset;
	DWORD dwFlags;
};
struct MMIOINFO {
	DWORD dwFlags;
	FOURCC fccIOProc;
	void *pIOProc;
	UINT wErrorRet;
	void *htask;
	LONG cchBuffer;
	char *pchBuffer;
	char *pchNext;
	char *pchEndRead;
	char *pchEndWrite;
	LONG lBufOffset;
	LONG lDiskOffset;
	DWORD adwInfo[3];
	DWORD dwReserved1;
	DWORD dwReserved2;
	HMMIO hmmio;
};
#define WAVE_FORMAT_PCM 1
