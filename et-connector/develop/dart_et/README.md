# dart_et

Pure Dart の [Eternal Terminal (ET)](https://eternalterminal.dev/) クライアント実装。

[dart_mosh](https://github.com/gwitko/dart_mosh) と同じく **ET のトランスポートだけ** を担当します。
SSH（`etterminal` の起動と `IDPASSKEY` の受け取り）と端末描画はアプリ側の責務です。

## 対応状況

| 項目 | 状態 |
|---|---|
| プロトコル | v6（etserver 6.x / 7.0.0 / master） |
| 暗号 | XSalsa20-Poly1305（libsodium `crypto_secretbox` 互換, pinenacl） |
| ハンドシェイク | 7.0.0 までの legacy 方式 + master の challenge 方式（BLAKE2b proof） |
| 自動再接続 | ○（シーケンス番号交換 + catchup 再送。オフライン中の入出力も欠落なし） |
| keepalive | ○（5 秒無通信で probe、2 周期応答なしで張り直し） |
| リセット復帰（サーバ再起動後） | ○（reset salt による rekey） |
| ポートフォワード / jumphost | × |

## 使い方

```dart
import 'package:dart_et/dart_et.dart';

// 1. 自前の SSH 接続で etterminal を起動する（dartssh2 など）
final command = const EtSshBootstrap(
  etterminalPath: '/opt/homebrew/bin/etterminal',
).command(EtCredentials.random());
final output = await ssh.run(command);

// 2. 出力から id / passkey を取り出して etserver (TCP 2022) に接続
final session = await EtSession.connect(
  host: 'my-mac.local',
  credentials: EtCredentials.parse(output),
  columns: 80,
  rows: 24,
);

session.stdout.listen(terminal.write);
terminal.onInput = session.send;
terminal.onResize = session.resize;
session.states.listen(print); // connected / reconnecting / closed

// iOS でフォアグラウンド復帰したら、死んだソケットを待たずに張り直す
session.reconnect();
```

CLI 版（システムの `ssh` で bootstrap）:

```sh
dart run example/et_cli.dart user@host [--port 2022] [--etterminal PATH] [-- ssh args...]
```

## 構成

```
lib/src/
├── credentials.dart        IDPASSKEY の生成・パース
├── ssh_bootstrap.dart      etterminal 起動コマンド
├── crypto/
│   ├── et_cipher.dart      secretbox + カウンタ nonce（CryptoHandler 移植）
│   └── auth_proof.dart     challenge / reset decision の BLAKE2b proof
├── protocol/
│   ├── protobuf.dart       最小 protobuf codec（dart_mosh から流用・拡張）
│   ├── messages.dart       ET.proto / ETerminal.proto の必要分
│   └── packet.dart         パケット種別と wire 形式
├── transport/
│   ├── byte_queue.dart     ソケットの chunk を「N バイト読む」に変換
│   ├── framing.dart        handshake: int64 LE 長 / packet: uint32 BE 長
│   ├── backed_writer.dart  暗号化・再送用バックアップ（BackedWriter 移植）
│   ├── backed_reader.dart  復号・受信数カウント（BackedReader 移植）
│   ├── link.dart           TCP 1 本分
│   └── connection.dart     ハンドシェイク・recover・再接続（ClientConnection 移植）
└── session.dart            端末セッション（TerminalClient の端末部分）
```

## 互換性メモ

- etserver **7.0.0 は未知のパケット種別を受け取るとサーバプロセスごと落ちる**（`STFATAL`）。
  master で追加された `TERMINAL_CLOSE` は、challenge ハンドシェイクを使うサーバにだけ送る。
- 7.0.0 は `TERMINAL_EXIT_STATUS` を送らない。シェル終了時はソケットが切られ、
  再接続すると `INVALID_KEY` が返る。これを「セッション終了」として扱う（上流クライアントと同じ）。

## テスト

```sh
dart test                       # unit + in-process fake etserver
# 実サーバ（../server の Docker コンテナ）に対する結合テスト
ET_IT_TARGET=dev@127.0.0.1 ET_IT_SSH_ARGS="-i KEY -p 2222" dart test test/integration_test.dart
```

暗号のテストベクタは libsodium（PyNaCl）で生成したもの。
