# Dn-FamiTracker desktop / デスクトップ版

This directory contains the Windows application, Visual Studio and CMake projects,
resources, help submodule, version headers, and release tools. The browser application
is in [`../web/`](../web/README.md). Its build also compiles the module model, audio
engine, and exporters from `Source/`; those sources are maintained here once.

Windows 版のソース、Visual Studio / CMake の設定、リソース、ヘルプ、
バージョン情報、配布用ツールをこのディレクトリにまとめています。
ウェブ版は [`../web/`](../web/README.md) にあります。`Source/` の楽曲モデル・
音源エンジン・エクスポーターはウェブ版でも再利用します。

## Layout / 構成

| Path | Purpose / 用途 |
| --- | --- |
| `Source/` | C++ application, audio engine, NSF drivers, and bundled libraries / 本体・音源・ドライバ |
| `res/`, `Dn-FamiTracker.rc`, `resource.h` | Windows icons, dialogs, menus, and strings / リソース |
| `Dn-help/` | Desktop HTML Help manual, managed as a Git submodule / ヘルプ |
| `Dn-FamiTracker.sln`, `*.vcxproj*` | Visual Studio solution and projects / Visual Studio 設定 |
| `CMakeLists.txt`, `cmake/`, `cmake_user_*.cmake.example` | CMake build and optional local settings / CMake 設定 |
| `name.h`, `version.h`, `resource_version_update.py` | Application name and resource version updates / 名前・バージョン |
| `generate-helpmap.bat`, `release.bat` | Help generation and release packaging / ヘルプ生成・配布 |
| `CHANGELOG.md`, `Readme.txt`, `specs.txt` | Desktop release history and notes / 更新履歴・説明 |

Shared demo modules, specifications, and licenses stay in `../demo/`, `../docs/`,
and `../LICENSE*`. The desktop help build makes ignored local copies of the licenses
because its upstream scripts expect them beside the solution.

共通のデモ曲・資料・ライセンスは `../demo/`、`../docs/`、`../LICENSE*` にあります。
ヘルプの既存スクリプトに合わせて、ビルド時にライセンスをこのディレクトリへ
コピーします。コピーは Git の管理対象外です。

## Build / ビルド

See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for Windows build dependencies
(Visual Studio 2022 with MFC/ATL, Python, cc65, Pandoc, and HTML Help Workshop).
Commands below start at the repository root.

必要な Windows 開発環境は [`../CONTRIBUTING.md`](../CONTRIBUTING.md) を参照してください。
以下のコマンドはリポジトリのルートから実行します。

```sh
git submodule update --init --recursive
```

Open `desktop/Dn-FamiTracker.sln` in Visual Studio, or use CMake:

Visual Studio で `desktop/Dn-FamiTracker.sln` を開くか、CMake を使用します。

```sh
cmake -S desktop -B desktop/build -G "Visual Studio 17 2022" -A x64
cmake --build desktop/build --config Release
```

To package a Visual Studio build, run from `desktop/`:

Visual Studio のビルド結果を配布用にまとめる場合は、`desktop/` で実行します。

```bat
release.bat Release x64
```

The archives are written to `desktop/distribute/`. GitHub Actions uses the same
desktop directory for builds and packaging.

配布ファイルは `desktop/distribute/` に作成されます。GitHub Actions も
このディレクトリでビルドと配布ファイルの作成を行います。
