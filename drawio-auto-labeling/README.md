# Draw.ioのアイコンへのラベリングを自動化するVSCode拡張を作った

## 概要

Draw.ioのサイドバーから図形をドラッグするときに、特定のキーを押しながらドロップすると、その図形の表示名(例:`EC2`、`Secrets Manager`)を自動でラベルとして適用してくれるVSCode拡張を作りました。

Marketplaceに公開済みなので、ストアページの動画を見ていただくのがイメージしやすいかと思います。
- [Draw.io Auto Labeling](https://marketplace.visualstudio.com/items?itemName=kodakamasaru.drawio-auto-labeling)

### 注意点

今回作成したのはVSCode拡張の[`hediet.vscode-drawio`](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio)向けのプラグインです。その他の環境には対応していません。
- ◯: VSCode + [`hediet.vscode-drawio`](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio) 
- ×: Draw.io Web版 / デスクトップアプリ版

※プラグイン本体(`auto-labeling.js`)は標準のDraw.io Plugin APIを使っているので、JSファイルを取り出して公式Draw.ioに読み込ませれば流用できる可能性はありますが、未検証です。

## 経緯

AWS構成図などをDraw.ioで書くときに、アイコンを置いたあとに自分でラベルを書き直す作業がそこそこ手間でした。

例えば AWS Route 53 のアイコンをドロップすると、デフォルトではラベルが空のまま置かれるので、ダブルクリックして「Route 53」と打ち込む流れになります。
これが地味に手間で、さらに`Route53`と詰めてしまう等正式表記とずれてないかも意識を割かなければいけません。

そこで、最初から正式表記が出てくれるような機能がほしく、アイコン名をそのまま表示しようという発想になりました。

## 使い方

[VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=kodakamasaru.drawio-auto-labeling) からインストールできます。
※インストールすると依存関係で`hediet.vscode-drawio`も自動で入ります。

1. `.drawio`ファイルを開く
2. サイドバーから図形をドラッグし、`Cmd`(macOS)や`Ctrl`を押しながらドロップする
3. 図形のタイトル(例:`Amazon EC2`)がそのままラベルとして適用される

初回は`hediet.vscode-drawio`側からプラグインの承認ダイアログが出るので「Allow」を押してください。
※設定を変更するたびにプラグインのフィンガープリントが変わるため、再度承認ダイアログが出ます。

## 設定

`settings.json`で以下を設定できます。

| 設定キー | 型 | デフォルト | 説明 |
|--|--|--|--|
| `drawio-auto-labeling.modifierKey` | `cmd`/`ctrl`/`alt(option)`/`shift` | `cmd` | ラベリング発動の修飾キー |
| `drawio-auto-labeling.dictionary` | key/value | 空 | アイコンタイトル → 適用ラベル のマッピング |

設定例:

```json:settings.json
{
  "drawio-auto-labeling.modifierKey": "alt",
  "drawio-auto-labeling.dictionary": {
    "Secrets Manager": "シークレットマネージャー"
  }
}
```

マッピングが設定されている場合アイコン名ではなくそちらが優先されます。

## 実装

`hediet.vscode-drawio`は外部プラグインを読み込む仕組みを持っていて、プラグインは単一のJSファイルとしてロード時にDraw.ioのUIオブジェクトを受け取れます。

今回は、サイドバーのドラッグ生成関数`ui.sidebar.createDragSource`をラップして、ドロップハンドラの呼び出し前後でモデルを比較 ⇒ 新しく追加されたセルを検出 ⇒ 修飾キーが押されていればそのセルにラベルを設定する、という方針にしました。

```javascript:auto-labeling.js
sidebar.createDragSource = function (elt, dropHandler, preview, w, h) {
  var wrappedDropHandler = function (graph, evt, target, x, y) {
    var model = graph.getModel();
    var cellsBefore = collectCellIds(model);
    var result;
    if (typeof dropHandler === 'function') {
      result = dropHandler.apply(this, arguments);
    }

    if (!isModifierHeld(evt, CONFIG.modifierKey)) return result;

    var rawTitle = readTitle(elt);
    if (!rawTitle) return result;

    var label = mapLabel(rawTitle, CONFIG.dictionary);
    if (!label) return result;

    model.beginUpdate();
    try {
      var cells = model.cells || {};
      for (var id in cells) {
        if (!Object.prototype.hasOwnProperty.call(cells, id)) continue;
        if (cellsBefore[id]) continue;
        var cell = cells[id];
        if (!cell || !cell.vertex) continue;
        if (cell.value) continue;
        graph.cellLabelChanged(cell, label);
      }
    } finally {
      model.endUpdate();
    }

    return result;
  };
  return origCreateDragSource.call(this, elt, wrappedDropHandler, preview, w, h);
};
```

`beginUpdate`/`endUpdate`で1ドロップを1トランザクションにしているので、Undoを1回押すと配置とラベル付けがまとめて取り消されます。
## 参考

* [hediet/vscode-drawio](https://github.com/hediet/vscode-drawio)
* [kodakamasaru/drawio-auto-labeling](https://github.com/kodakamasaru/drawio-auto-labeling)

最後まで読んでいただきありがとうございます。
