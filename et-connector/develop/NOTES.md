# 開発ログ（記事ネタ）

## 2026-09-27: dart_et 実装・実サーバ疎通

### 環境

- Mac: Intel (x86_64) / macOS 26.5.2
- Homebrew は Intel をサポート終了しており、`dart-sdk` / `et` ともボトルなし → llvm や rust までソースビルドになるので断念
  - Dart: 公式 zip（dartsdk-macos-x64-release.zip, 3.13.4）
  - etserver: Docker（debian bookworm + 公式 apt リポジトリの `et 7.0.0-bookworm1`）→ `server/`
- untrusted tap（`dart-lang/dart`, `MisterTea/et`）は今の Homebrew だと読み込みを拒否される。core の `dart-sdk` / `et` を使う

### プロトコル（ソースから読み解いた内容）

1. **SSH bootstrap**: `echo 'ID/PASSKEY_TERM' | etterminal` を ssh で実行 → `IDPASSKEY:<16文字>/<32文字>` が返る（サーバ側で採番し直す）
2. **TCP 2022 で接続 → ハンドシェイク**: protobuf を「8 バイトの int64 リトルエンディアン長 + 本体」で送る
   - `ConnectRequest{clientId, version=6}` → `ConnectResponse{status}`
   - master（未リリース）では challenge 方式: `authChallenge`(32B) → `ConnectAuth{proof = BLAKE2b(key, メッセージ)}` → `ConnectResponse{status, resetProof}`
3. **本通信**: 「4 バイトのビッグエンディアン長 + [暗号化フラグ][ヘッダ][payload]」
   - payload は libsodium `crypto_secretbox_easy`（XSalsa20-Poly1305, MAC‖暗号文）
   - nonce は送らない。24 バイトのリトルエンディアンカウンタで、最上位バイトが方向（C→S=0, S→C=1）。暗号化・復号のたびに +1
   - 鍵は passkey の ASCII 32 バイトそのもの
4. **再接続**: `ConnectRequest` → `RETURNING_CLIENT` → 互いに「受信済みパケット数」を `SequenceHeader` で交換 → 相手が持っていない分を `CatchupBuffer`（暗号化済みパケットの配列）で送り合う
   - 送った暗号文をそのまま再送するので nonce の整合が崩れない、というのがうまいところ
5. 同じ TCP ストリームで長さプレフィックスの形式が 2 種類（int64 LE / uint32 BE）混在する

### dart_mosh から流用・参考にしたところ

- スコープの切り方: SSH と端末 UI はアプリ側。ライブラリは「bootstrap コマンド生成」「出力パース」「トランスポート」だけ
- `MoshSshBootstrap` → `EtSshBootstrap`、`MoshServerConfig.parse` → `EtCredentials.parse`
- protobuf を protoc なしで手書き（`ProtoWriter`/`ProtoReader` をほぼ流用し、bool/string/負の int32 を追加）
- `MoshSession` の API 形（`stdout` stream / `send` / `resize` / `rehome` / `close` / `done`）→ `EtSession`（`rehome` の代わりに `reconnect`）
- 違い: mosh は UDP で状態同期（SSP）、ET は TCP でバイト列の順序保証 + 再送。実装の中心がまったく違う

### ハマりどころ・発見

- **etserver 7.0.0 は未知のパケット種別でサーバプロセスごとクラッシュする**
  - master で追加された `TERMINAL_CLOSE`(11) を送ったら `STFATAL "Unknown packet type: 11"` → SIGSEGV → コンテナ終了
  - 1 クライアントの送信で全員のセッションが落ちる（ただし正しい passkey は必要）。master では「接続を切るだけ」に修正済み
  - 対策: challenge ハンドシェイクを使うサーバ（= 7.0.0 より新しい）にだけ送る
- **master と 7.0.0 リリースでプロトコルが違う**: challenge 認証、`TERMINAL_EXIT_STATUS`、`TERMINAL_CLOSE` は master のみ。GitHub の master だけ読んで実装すると 7.0.0 と話せない → 両対応にした
- 7.0.0 はシェル終了を通知しない。ソケットが切られる → 再接続 → `INVALID_KEY` が返ったら「終わった」と判断する（上流クライアントも同じ）
- 再接続の recover 中に書かれたパケット: Dart は `await` の間に `write()` が割り込むので、catchup 計算後に書かれたものを別途送る必要があった（C++ はミューテックスでブロック）
- fake サーバのバグで時間を溶かした: catchup で受け取ったパケットの返信を、リンク接続前に処理していた（上流は revive 後に処理）

### 検証結果

- unit + fake etserver: 39 テスト、カバレッジ 87%（レビュー指摘: close 時のソケットリーク、オフラインバッファ上限、再接続待機中の reconnect() を修正）
- 実 etserver 7.0.0（Docker）:
  - コマンド実行・ウィンドウサイズ反映（`tput` で確認）
  - TCP プロキシで 4 秒の回線断を起こす → 断の間のサーバ出力（tick-1〜20）が欠落・重複なし、断の間に打ったコマンドも復帰後に実行された
  - 強制再接続（`reconnect()`）中の出力も欠落なし

### 残り

- [ ] Flutter + xterm + dartssh2 で iPhone アプリ化（**Xcode と Flutter SDK が必要**）
- [ ] Mac 本体で etserver を動かす（Intel だと Homebrew がソースビルドになる）
- [ ] iOS のバックグラウンド → 復帰で `reconnect()` を呼ぶ（AppLifecycleState.resumed）
- [ ] 記事執筆

## 2026-09-27（続き）: Mac ネイティブ etserver + Flutter アプリ

### 環境構築
- Xcode 26.5 インストール後、`sudo xcodebuild -license accept` をしないと git も brew も動かない
- Flutter: VS Code 拡張の「Download SDK」は中身が `git clone`。`~/development/flutter`（3.47.5）+ `~/.zshrc` に PATH
- iOS: `xcodebuild -downloadPlatform iOS`（シミュレータ込みで 10.6 GB）
- CocoaPods 不要: shared_preferences も Swift Package Manager で解決された
- `brew install et`（Intel）: protobuf 7 分 + et 3 分のソースビルド。Apple Silicon ならボトルで一瞬のはず
  - caveats は `sudo brew services start et` だが、ユーザー権限でも動く（FIFO が `~/.local/share/etserver/etserver.idpasskey.fifo` になる）
  - `/usr/local/etc/et.cfg` の `telemetry = true` がデフォルト。記事で触れる

### ハマりどころ
- macOS の sshd はコマンド実行時の PATH が `/usr/bin:/bin:/usr/sbin:/sbin` → Homebrew の etterminal が見つからない
  → `EtSshBootstrap` に `searchPaths`（既定で `/opt/homebrew/bin` と `/usr/local/bin`）を追加
- 環境変数を PATH と HOME だけにして etterminal を起動すると SIGSEGV（USER/SHELL 等が無いと落ちる？）。sshd 経由では要確認

### 検証
- Mac ネイティブ etserver 7.0.0 に Dart クライアントで接続: `MAC=26.7 SIZE=90x20`、強制再接続後のコマンドも実行 OK

### アプリ（et_app）
- 接続画面（パスワードは保存しない）、ホスト鍵 TOFU、xterm 端末、Esc/Tab/Ctrl/矢印ツールバー
- `AppLifecycleState.resumed` で `session.reconnect()`

### iPhone 実機（iPhone SE 第3世代 / iOS 26.6.2）
- 署名: Xcode で Runner → Signing & Capabilities → Team に Personal Team を 1 回設定するだけ。証明書は自動生成
  - 「VPN とデバイス管理」で信頼する操作は不要だった（デベロッパモード + Xcode 由来のインストール）
- Intel Mac でのビルド時間: シミュレータ初回 31 分 / 実機 release 初回 10 分 / 以降の差分は 40〜90 秒
- 結果: 同じ Wi-Fi 上の Mac（192.168.x.x）に接続成功
  - カウンタ実行中に画面ロック・バックグラウンド → 復帰で番号欠落なし
  - 機内モード 15 秒 → 解除で復帰。etserver ログに `Recovering 13 Messages`（断の間の出力 13 パケットを再送）

### 実機でのハマりどころ
- **No route to host**: iOS の「ローカルネットワーク」許可。Info.plist に `NSLocalNetworkUsageDescription` が無いとダイアログも出ずに拒否される
  （シミュレータは 127.0.0.1 だったので気づかない）
- **バックスペースが効かない**: iOS ソフトキーボードは空欄での削除を通知しない。xterm の `TerminalView(deleteDetection: true)` が必要（デフォルト false）
- 長いコマンドの手打ちはつらい → ツールバーに paste ボタン（bracketed paste）を追加
- ユニバーサルクリップボードは今回うまく動かなかった（アプリ側の問題ではない）

### Tailscale 経由（Wi-Fi ↔ モバイル通信）
- Mac `100.67.19.19` / iPhone `100.117.87.57`。アプリのホストを 100.x に変えるだけ（コード変更なし）
- `lsof` で `100.67.19.19:2022->100.117.87.57` を確認
- Wi-Fi オフ → モバイル通信: `Recovering 19 Messages`
- モバイル通信のまま画面ロック約 2 分半 → 復帰: `Recovering 151 Messages`（カウンタ 151 行分を一括再送）
- 注意（記事で書き分ける）: Tailscale は内側の IP が変わらないので、短い切替なら素の SSH でも耐えることがある。
  ET の強みは TCP 自体が死ぬ長時間断・スリープ・バックグラウンド化からの無欠落復帰

### etserver の常駐
- `brew services start et`（sudo なし）で `~/Library/LaunchAgents/sh.brew.et.plist` として常駐。「root でないとシステム起動時には起動しない」警告のみ
- `/usr/local/etc/et.cfg` の `telemetry` を false に（元ファイルは `et.cfg.orig`）
- 常駐 etserver に対しても接続・リサイズ・強制再接続を確認
