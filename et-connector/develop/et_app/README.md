# et_app

`dart_et` を使った iPhone 用 ET クライアント（Flutter）。

- SSH（dartssh2, パスワード認証）で Mac の `etterminal` を起動し、id/passkey を受け取ったら SSH は閉じる
- 以降は TCP 2022 の ET だけで通信（xterm で描画）
- アプリがフォアグラウンドに戻ったら `session.reconnect()` で即再接続
- ホスト鍵は初回に確認して保存（TOFU）。パスワードは保存しない
- iOS キーボードにない Esc / Tab / Ctrl / 矢印をツールバーで補う

## Mac 側の準備

```sh
brew install et
brew services start et          # etserver が 2022/tcp で待ち受け
```

システム設定 → 一般 → 共有 → 「リモートログイン」をオン（SSH）。
外から繋ぐなら Tailscale などで 22/tcp と 2022/tcp を届ける。

## 実行

```sh
flutter run                     # 実機 / シミュレータ
flutter test
```

プラグインは Swift Package Manager で解決されるので CocoaPods は不要。
