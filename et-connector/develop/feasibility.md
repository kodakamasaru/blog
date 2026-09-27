# iPhone → Mac を ET (Eternal Terminal) で接続する：実現可能性メモ

調査日: 2026-09-27

## 既存状況

| 項目 | 状況 |
|---|---|
| iOS の ET 対応アプリ | Panic **Prompt 3** が 3.0 (2024-01) から ET / mosh 対応済み（有料） |
| mosh の Dart 実装 | `dart_mosh` 0.0.4（pure Dart、SSH と UI は範囲外。bootstrap はアプリ側） |
| ET の Dart / Swift 実装 | **見当たらない** |
| ET の他言語移植 | Rust: AArnott/eternal-terminal-client, at-least/et-client, minpeter/et.rs / Go: tphakala/et-go（すべて protocol v6 互換） |
| 公式プロトコル仕様 | なし（Issue #452 で要望されたまま）。C++ ソースと移植実装が事実上の仕様 |

## ET プロトコル概要

1. SSH でサーバに入り、`etterminal` を起動 → セッション ID と passkey を受け取って SSH を閉じる
2. TCP 2022 で etserver に接続
3. 暗号: libsodium `crypto_secretbox`（XSalsa20-Poly1305）。nonce はカウンタで、MSB で方向を区別。鍵更新は `crypto_generichash`（BLAKE2b）
4. メッセージは protobuf
5. 再接続: BackedReader/BackedWriter が送受信済みバイトのシーケンス番号を持ち、差分を再送 → スクロールバックが欠けない

## Dart での実装に使える部品

| 役割 | パッケージ |
|---|---|
| SSH bootstrap | `dartssh2` |
| XSalsa20-Poly1305 / BLAKE2b | `pinenacl`（pure Dart の TweetNaCl 移植、SecretBox と Blake2b あり） |
| protobuf | `protobuf` + `protoc_plugin`（ET の .proto をそのまま流用） |
| TCP | `dart:io` Socket |
| 端末 UI | `xterm`（xterm.dart） |

→ ネイティブ依存（FFI）なしで組める見込み。

## 判定

- **実現可能性: 高い**。暗号・シリアライズ・転送のどれも Dart に既製品がある。難所は仕様書がないハンドシェイク／再接続シーケンスで、et-go（Go、コンパクト）を読みながら移植するのが近道
- **「Prompt 3 で繋いでみた」だけの記事**: 題材としては弱い（手順は 5 分で終わり、新規性がない）
- **「Dart で ET クライアントを書いて iPhone から Mac に繋いだ」**: 題材として強い
  - dart_mosh はあるのに dart_et がない、という空白
  - 公式仕様がない → ソースから読み解く過程そのものがネタになる
  - デモ映えする: Wi-Fi ↔ 4G 切替やアプリのバックグラウンド移行後も、セッションとスクロールバックが残る
  - mosh との比較軸がはっきりしている（UDP vs TCP、ローカルエコー予測 vs スクロールバック完全保持）

## 注意点

- ET にはローカルエコー予測がないので、高遅延の回線では mosh の方が打鍵が快適。記事では正直に比較する
- iOS はバックグラウンドで TCP を切るので、復帰時の再接続実装が必須（ET 向きの題材でもある）
- Mac 側: `brew install MisterTea/et/et` → `brew services start et`。外から繋ぐ場合は Tailscale 等で 2022/tcp を届ける
- ssh bootstrap の `etterminal` は非ログインシェルだと PATH が通らないことがある（/opt/homebrew/bin）

## 記事構成案（ツール作成系）

1. 動機: mosh は dart_mosh があるが、ET はない
2. ET とは / mosh との違い
3. Mac に etserver を入れる
4. プロトコル解析（bootstrap → 暗号 → protobuf → 再接続）
5. Dart 実装（最小: 接続・入出力・リサイズ・再接続）
6. Flutter + xterm で iPhone アプリ化
7. デモ（回線切替・バックグラウンド復帰）
8. mosh / Prompt 3 との比較、まとめ
