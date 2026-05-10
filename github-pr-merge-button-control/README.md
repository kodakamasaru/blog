# itHubのSquashマージの強制を柔軟に制御する

## 概要

GitHubのPR画面で、`Squash and merge`、`Create a merge commit`、`Rebase and merge` のマージボタンを base/headブランチの組み合わせに応じて制御するTampermonkeyスクリプトを作ってみました。

## 経緯

GitHubのスカッシュマージは履歴がすっきりして非常に便利な機能ですが、
ブランチ運用として組み込む際は通常のマージ（`Create a merge commit`)との切り替えが発生し、
ヒューマンエラーが発生しやすくなります。

Branch Protection Ruleを使えば多少の制御はできますが、以下のような課題があります。
- head(マージ元), base(マージ先)の組み合わせではなくbaseでしか制御できない
- privateリポジトリのfreeプランでは使用できない

そこで、それらを解消できる仕組みを考えました。

## 完成品紹介

このように、PRのbase/headブランチを見て、許可されていないマージ方法のボタンが非活性になります。

<img alt="" src="merge-button-disabled.png">

## 実装

こちらがTampermonkeyスクリプトです。
使用方法は[こちら](https://www.nxted.co.jp/blog/blog_detail?id=196)と同様なので、スクリプト部分だけ差し替えて適用してください。

また、下記コード内の`RULES`部分を書き換えることでPJに応じた制御ルールに変更可能です。

```javascript:check_pr_merge_button.user.js
// ==UserScript==
// @name         Check PR Merge Button on GitHub
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  PRマージボタン制御
// @match        https://github.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // マージ方法のラベル定義（GitHub UIの表記に依存）
    const MERGE_LABEL = {
        MERGE: 'Merge pull request',
        SQUASH: 'Squash and merge',
        REBASE: 'Rebase and merge',
    };

    // ルールセット（配列、上から順にマッチ判定）
    // - headPrefix: head ブランチの接頭辞（省略時は全てにマッチ）
    // - basePrefix: base ブランチの接頭辞（省略時は全てにマッチ）
    // - disabledLabels: 非活性にするマージボタンのラベル配列
    // ※ 最初にマッチしたルールが適用される
    const RULES = [
        // production への マージは develop/* または hotfix/* からのマージコミットのみ
        {
            headPrefix: 'develop/',
            basePrefix: 'production',
            disabledLabels: [MERGE_LABEL.SQUASH, MERGE_LABEL.REBASE],
        },
        {
            headPrefix: 'hotfix/',
            basePrefix: 'production',
            disabledLabels: [MERGE_LABEL.SQUASH, MERGE_LABEL.REBASE],
        },
        {
            headPrefix: '',
            basePrefix: 'production',
            disabledLabels: [MERGE_LABEL.MERGE, MERGE_LABEL.SQUASH, MERGE_LABEL.REBASE],
        },

        // develop/* への マージは feature/* からのスカッシュマージのみ
        {
            headPrefix: 'feature/',
            basePrefix: 'develop/',
            disabledLabels: [MERGE_LABEL.MERGE, MERGE_LABEL.REBASE],
        },
        {
            headPrefix: '',
            basePrefix: 'develop/',
            disabledLabels: [MERGE_LABEL.MERGE, MERGE_LABEL.SQUASH, MERGE_LABEL.REBASE],
        },

        // hotfix/* への マージは feature/* からのスカッシュマージのみ
        {
            headPrefix: 'feature/',
            basePrefix: 'hotfix/',
            disabledLabels: [MERGE_LABEL.MERGE, MERGE_LABEL.REBASE],
        },
        {
            headPrefix: '',
            basePrefix: 'hotfix/',
            disabledLabels: [MERGE_LABEL.MERGE, MERGE_LABEL.SQUASH, MERGE_LABEL.REBASE],
        },
    ];

    function getBranchNames() {
        // GitHubのReact App hydration用JSONからbase/headブランチ名を取得する
        // <script type="application/json" data-target="react-app.embeddedData"> に
        // payload.pullRequestsLayoutRoute.pullRequest.baseBranch / headBranch が含まれる
        const script = document.querySelector(
            'script[type="application/json"][data-target="react-app.embeddedData"]'
        );
        if (!script) return { head: '', base: '' };

        try {
            const data = JSON.parse(script.textContent);
            const pr = data?.payload?.pullRequestsLayoutRoute?.pullRequest;
            return {
                head: pr?.headBranch || '',
                base: pr?.baseBranch || '',
            };
        } catch (e) {
            return { head: '', base: '' };
        }
    }

    function findMatchingRule(head, base) {
        for (const rule of RULES) {
            const headMatch = !rule.headPrefix || head?.startsWith(rule.headPrefix);
            const baseMatch = !rule.basePrefix || base?.startsWith(rule.basePrefix);
            if (headMatch && baseMatch) {
                return rule;
            }
        }
        return null;
    }

    function isLabelDisabled(rule, label) {
        const labels = rule.disabledLabels || [];
        return labels.includes(label);
    }

    function isTargetLabel(label) {
        return Object.values(MERGE_LABEL).includes(label);
    }

    function disableMergeButtons() {
        const { head, base } = getBranchNames();
        const targets = document.querySelectorAll('[class^="prc-Button-Label-"]');
        const rule = findMatchingRule(head, base);

        targets.forEach(el => {
            const parentButton = el.parentElement?.parentElement;
            if (!(parentButton && parentButton.tagName.toLowerCase() === 'button')) return;

            const label = (el.innerText || '').trim();

            // マージボタン以外は対象外（何もしない）
            if (!isTargetLabel(label)) {
                return;
            }

            // マッチするルールがなければ制限なし
            if (!rule) {
                parentButton.disabled = false;
                return;
            }

            // マージ方法の非活性判定
            if (isLabelDisabled(rule, label)) {
                parentButton.disabled = true;
                return;
            }

            // チェックを通ったら活性状態に戻す
            parentButton.disabled = false;
        });
    }

    // 初期表示時に実行
    disableMergeButtons();

    // 変更監視
    const observer = new MutationObserver(disableMergeButtons);
    observer.observe(document.body, { childList: true, subtree: true });
})();
```

ちなみにホワイトリスト形式ではなくブラックリスト形式で非活性制御をしているのは、
Draft解除ボタンやブランチ削除ボタンもマージボタンと同じDOM要素が使われているので、
それらに干渉しないようにするためです。

### サンプルルール

上記は [Clean-history GitFlow（以下、CGF）](https://www.nxted.co.jp/blog/blog_detail?id=187) 用のルール設定にしています。

| マージ先(base) | マージ元(head) | 許可されるマージ方法 |
|--|--|--|
| `production` | `develop/*` | Create a merge commit のみ |
| `production` | `hotfix/*` | Create a merge commit のみ |
| `production` | 上記以外 | 全て禁止 |
| `develop/*` | `feature/*` | Squash and merge のみ |
| `develop/*` | 上記以外 | 全て禁止 |
| `hotfix/*` | `feature/*` | Squash and merge のみ |
| `hotfix/*` | 上記以外 | 全て禁止 |
| 上記以外 | 任意 | 制限なし |

## 最後に

ブランチ運用ルールにおいてヒューマンエラーは課題になりがちなので仕組みで防いでいきたいですね。
ちなみに、マージはGitHubアクションに任せる&手動でのマージはブロックというアプローチを採っている例もあります。（手動マージのブロックには有料プランが必要）
[GitHub のマージ方式を人間に毎回選ばせるのは、もうやめよう（やめた） - エムスリーテックブログ](https://www.m3tech.blog/entry/github-auto-merge)

本記事で紹介した方法の方がハッキー寄りなので、
- 「freeプランだけど制御したい」
- 「チームとしての導入ではなく、自分用にチェックの仕組みがほしい」
という場面以外は上述記事の方法を使うのが無難かもしれません。

以上です。最後まで読んでいただきありがとうございました。

## 参考

* [GitHub のマージ方式を人間に毎回選ばせるのは、もうやめよう（やめた） - エムスリーテックブログ](https://www.m3tech.blog/entry/github-auto-merge)
* [Tampermonkey](https://www.tampermonkey.net/)
* [MutationObserver - Web APIs | MDN](https://developer.mozilla.org/ja/docs/Web/API/MutationObserver)
