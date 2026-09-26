# Dn-FamiTracker-web

[Dn-FamiTracker](https://github.com/Dn-Programming-Core-Management/Dn-FamiTracker) の再生エンジンを
WebAssembly に移植するフォークです。ブラウザで FamiTracker 系のモジュール（.dnm / .0cc / .ftm）を
再生できるようにし、最終的に [zxtune.com](https://zxtune.com/) のプレイヤーに組み込むことを目指しています。

トラッカー本体（Windows 用のアプリケーション）の説明・ダウンロードは
[元のリポジトリ](https://github.com/Dn-Programming-Core-Management/Dn-FamiTracker) を参照してください。

*English: a fork of Dn-FamiTracker that compiles the tracker's own playback engine to WebAssembly,
to play .dnm / .0cc / .ftm modules in browsers (eventually on zxtune.com). Build and API details are in
[web/README.md](web/README.md).*

## 現状

| 項目 | 状態 |
| --- | --- |
| 再生エンジン（読み込み・サウンドドライバ・音源エミュレーション）の wasm 化 | 動作する |
| 2A03 / VRC6 / N163 の曲 | デモ曲 5 曲で最後まで再生できることを確認 |
| VRC7 / FDS / MMC5 / Sunsoft 5B | 同じエミュレーションコードを含むが、実際の曲では未確認 |
| シーク・ループ・チャンネルミュート | 動作する（シーク後の音は通し再生とサンプル単位で一致） |
| 複数曲入りのモジュール（曲の選択） | 実装済み、実際の曲では未確認 |
| ブラウザでの再生（Worker + AudioWorklet のデモページ） | Chromium 系で確認、他のブラウザは未確認 |
| デスクトップ版の WAV 書き出しとの一致 | 未確認（比較ツールあり: `web/test/compare.mjs`） |
| zxtune.com への組み込み | 未着手 |
| エディター（パターン編集などの画面） | 動作する（`web/html/editor.html`。下記） |
| .dnm での保存 | 動作する（デモ曲 5 曲を保存し直しても、再生音がサンプル単位で同じ） |

エディターでできること:

- 新規作成、.dnm / .0cc / .ftm を開く、.dnm で保存。作業中の曲はブラウザ（localStorage）に自動で保存し、開き直すと戻ります
- パターン編集: デスクトップ版と同じキー配置（Z・Q の段で音符、1 でノートカット、\ でリリース、16 進数で音色・音量・エフェクト）、
  範囲選択・コピー・切り取り・貼り付け、行の挿入・削除、移調、取り消し・やり直し
- 再生（フレームから・曲の最初から・パターンのループ・カーソルから）と、再生中の行への追従。キーや画面の鍵盤で音を試聴
- フレームの追加・削除・複製・コピー・並べ替えとパターン番号の変更、スピード・テンポ・行数・フレーム数・強調間隔、トラックの追加と削除
- 音色の追加・複製・削除・名前の変更と、シーケンス（音量・アルペジオ・ピッチ・ハイピッチ・デューティ）の編集（棒グラフと文字入力）
- 拡張音源（VRC6 / VRC7 / FDS / MMC5 / N163 / 5B）の切り替え、チャンネルのミュートとソロ

まだできないこと: FDS・N163 の波形、VRC7 のパッチ、DPCM サンプルの編集（その種類の音色は名前の変更だけ）、グルーヴ、ブックマーク、WAV 書き出し。

既知の制限:

- シークは曲の先頭から無音で再生して追いつく方式です。位置は正確ですが、長い曲の終盤へのシークには数秒かかります。
- 曲名などの文字列は、UTF-8 でなければ Windows-1252 として読みます。Shift-JIS の曲名は文字化けします。
- 再生できるのは同時に 1 曲だけです（元のコードが単一のサウンドジェネレーターを前提にしているため）。

## 仕組み

- `Source/` の本体コードを書き換えずに Emscripten でコンパイルしています。MFC / Win32 の部分は
  [web/compat/](web/compat/) の互換レイヤーが肩代わりします。
- デスクトップ版のオーディオスレッドの代わりに [web/src/soundgen_host.cpp](web/src/soundgen_host.cpp)
  がエンジンを 1 フレームずつ動かし、デスクトップ版の WAV 書き出しと同じ経路で音を取り出します。
- JavaScript の API とページ側のメッセージ形式は、ZXTune の wasm ビルド
  （[zxtune-web](https://github.com/hhungry2/zxtune-web/tree/web/apps/zxtune-web)）と同じ形です。
- `Source/` への変更は、MSVC 以外でコンパイルするための小さな修正と `#ifdef DNFT_PORTABLE`
  の 2 か所だけです（一覧は [web/README.md](web/README.md)）。上流の更新を取り込みやすいよう、変更は最小限にしています。

## ビルドと実行

[emsdk](https://emscripten.org/docs/getting_started/downloads.html)（6.0.9 で確認）、GNU make、python3 が必要です。

```sh
source <emsdk>/emsdk_env.sh
make -C web -j$(nproc) site        # web/dist/ にエンジン・デモページ・エディター・デモ曲
python3 -m http.server -d web/dist  # http://localhost:8000/ がプレイヤー、/editor.html がエディター
```

テスト（Node.js）:

```sh
node web/test/smoke.mjs                            # デモ曲での動作確認
node web/test/session.mjs                          # 編集セッション（編集・再生・保存）の確認
node web/test/render.mjs <モジュール> [出力.wav]      # WAV に書き出す
node web/test/compare.mjs <モジュール> <書き出し.wav>  # デスクトップ版の WAV 書き出しと比較
```

JavaScript からの使い方、ファイル構成、`Source/` への変更の一覧は [web/README.md](web/README.md) にあります。

## ライセンス

Dn-FamiTracker と同じく [GPLv3 以降](https://www.gnu.org/licenses/gpl-3.0.html) です。含まれるライブラリの
ライセンスは [LICENSE.md](LICENSE.md) を参照してください。wasm ビルドをブラウザに配信する場合は、
そのソース（このリポジトリ）を提供する必要があります。

## 元のプログラムの系譜

- Dn-FamiTracker: <https://github.com/Dn-Programming-Core-Management/Dn-FamiTracker>
- nyanpasu64 0CC-FamiTracker (archived): <https://github.com/nyanpasu64/j0CC-FamiTracker/>
- 0CC-FamiTracker: <https://github.com/HertzDevil/0CC-FamiTracker/>
- FamiTracker: <https://famitracker.com/>
