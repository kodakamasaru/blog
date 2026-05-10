# Googleスプレッドシートに VSCode 風のシート切り替えパレットを追加してみた

## 概要

Googleスプレッドシートで`Ctrl+Shift+O`を押すと、VSCodeの「ファイル名検索」のような検索パレットが開いて、シート名で絞り込んで切り替えられるようになるTampermonkeyスクリプトを作ってみました。

## 完成品紹介

このように、`Ctrl+Shift+O`でパレットが開き、シート名の一部を入力するだけで該当シートに飛べます。

<img alt="" src="demo.png">

文字を入力するとマッチした位置がハイライトされ、↑↓キーで候補を選び、Enterで決定、Escapeで閉じる、というVSCodeと同じキー操作で動きます。現在開いているシートには`current`、非表示シートには`hidden`のバッジを付けて区別できるようにしてあります。

## 使い方

こちらがTampermonkeyスクリプトの全文です。
使用方法は[こちら](https://www.nxted.co.jp/blog/blog_detail?id=196)と同様なので、スクリプト部分だけ差し替えて適用してください。

```javascript:spreadsheet-sheet-switcher.user.js
// ==UserScript==
// @name         Google Sheets - Sheet Switcher (VSCode-style)
// @namespace    https://github.com/kodakamasaru/scripts
// @version      0.1.0
// @description  Google スプレッドシートで Ctrl+Shift+O を押すと VSCode 風のシート名あいまい検索パレットを開く。
// @author       kodakamasaru
// @match        https://docs.google.com/spreadsheets/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // あいまい検索スコアリング
  // VSCode の fuzzyScore (src/vs/base/common/filters.ts, MIT) を参考にした実装。
  // (クエリ位置, 候補位置) の DP で最適な部分列マッチを求める。
  // ボーナス: 大小一致、単語境界 (先頭・区切り後・camelCase)、連続一致。
  // クエリが候補の部分列として存在しなければ null を返す。
  // -------------------------------------------------------------------------
  const SEP = /[\s_\-./\\()\[\]]/;

  function charBonus(target, ti) {
    if (ti === 0) return 8;
    const prev = target[ti - 1];
    if (SEP.test(prev)) return 8;
    const cur = target[ti];
    if (prev === prev.toLowerCase() && prev !== prev.toUpperCase()
        && cur === cur.toUpperCase() && cur !== cur.toLowerCase()) {
      return 7;
    }
    return 0;
  }

  function fuzzyScore(query, target) {
    if (!query) return { score: 0, matches: [] };
    const n = query.length;
    const m = target.length;
    if (n > m) return null;

    const qLow = query.toLowerCase();
    const tLow = target.toLowerCase();

    const NEG = -Infinity;
    const score = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(NEG));
    const trace = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-1));
    for (let j = 0; j <= m; j++) score[0][j] = 0;

    for (let i = 1; i <= n; i++) {
      for (let j = i; j <= m; j++) {
        if (qLow[i - 1] !== tLow[j - 1]) continue;

        let charScore = 1;
        if (query[i - 1] === target[j - 1]) charScore += 1;
        charScore += charBonus(target, j - 1);

        let best = NEG;
        let bestK = -1;
        for (let k = i - 1; k < j; k++) {
          if (score[i - 1][k] === NEG) continue;
          const consecutive = (k === j - 1 && i > 1) ? 5 : 0;
          const total = score[i - 1][k] + charScore + consecutive;
          if (total > best) {
            best = total;
            bestK = k;
          }
        }
        score[i][j] = best;
        trace[i][j] = bestK;
      }
    }

    let bestEnd = -1;
    let bestScore = NEG;
    for (let j = n; j <= m; j++) {
      if (score[n][j] > bestScore) {
        bestScore = score[n][j];
        bestEnd = j;
      }
    }
    if (bestEnd < 0 || bestScore === NEG) return null;

    const matches = [];
    let i = n;
    let j = bestEnd;
    while (i > 0) {
      matches.unshift(j - 1);
      j = trace[i][j];
      i--;
    }

    bestScore -= m * 0.01;
    return { score: bestScore, matches };
  }

  // -------------------------------------------------------------------------
  // シートタブの列挙
  // -------------------------------------------------------------------------
  function getSheetTabs() {
    const tabs = document.querySelectorAll('.docs-sheet-tab');
    const out = [];
    for (const tab of tabs) {
      const nameEl = tab.querySelector('.docs-sheet-tab-name')
        || tab.querySelector('.docs-sheet-tab-caption');
      let name = nameEl ? (nameEl.textContent || '').trim() : '';
      if (!name) name = (tab.getAttribute('aria-label') || '').trim();
      if (!name) continue;

      const active = tab.getAttribute('aria-selected') === 'true'
        || tab.classList.contains('docs-sheet-active-tab');
      const hidden = !active && (
        tab.classList.contains('docs-sheet-tab-hidden')
        || tab.getAttribute('aria-hidden') === 'true'
        || tab.offsetParent === null
      );
      out.push({ name, el: tab, active, hidden });
    }
    return out;
  }

  function activateTab(el) {
    el.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    ['mousedown', 'mouseup', 'click'].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window, button: 0,
      }));
    });
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------
  const STYLE = `
    #ssw-root { position: fixed; inset: 0; z-index: 2147483647; display: none;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #ssw-root.ssw-open { display: block; }
    .ssw-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.4); }
    .ssw-panel { position: absolute; top: 12vh; left: 50%; transform: translateX(-50%);
                 width: min(560px, 90vw); background: #252526; color: #cccccc;
                 border: 1px solid #454545; border-radius: 6px;
                 box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden; }
    .ssw-input { width: 100%; box-sizing: border-box; padding: 10px 14px;
                 background: #3c3c3c; color: #f0f0f0; border: none; outline: none;
                 font-size: 14px; border-bottom: 1px solid #454545; }
    .ssw-input::placeholder { color: #888; }
    .ssw-list { list-style: none; margin: 0; padding: 4px 0; max-height: 50vh;
                overflow-y: auto; }
    .ssw-item { padding: 6px 14px; cursor: pointer; font-size: 13px;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                display: flex; align-items: center; gap: 8px; }
    .ssw-item.ssw-selected { background: #094771; color: #ffffff; }
    .ssw-item.ssw-hidden { opacity: 0.65; }
    .ssw-match { color: #4daafc; font-weight: 600; }
    .ssw-item.ssw-selected .ssw-match { color: #9cdcfe; }
    .ssw-badge { font-size: 11px; padding: 1px 6px; border-radius: 3px;
                 border: 1px solid currentColor; color: #888; }
    .ssw-badge-current { color: #6a9955; }
    .ssw-badge-hidden { color: #d7ba7d; }
    .ssw-empty { padding: 12px 14px; color: #888; font-size: 13px; }
  `;

  let root = null;
  let inputEl = null;
  let listEl = null;
  let items = [];
  let selected = 0;
  let prevFocus = null;

  function ensureUI() {
    if (root) return;
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.id = 'ssw-root';

    const backdrop = document.createElement('div');
    backdrop.className = 'ssw-backdrop';
    backdrop.addEventListener('click', close);
    root.appendChild(backdrop);

    const panel = document.createElement('div');
    panel.className = 'ssw-panel';

    inputEl = document.createElement('input');
    inputEl.className = 'ssw-input';
    inputEl.type = 'text';
    inputEl.spellcheck = false;
    inputEl.autocomplete = 'off';
    inputEl.placeholder = 'シート名を入力...';
    inputEl.addEventListener('input', refresh);
    inputEl.addEventListener('keydown', onInputKey);
    panel.appendChild(inputEl);

    listEl = document.createElement('ul');
    listEl.className = 'ssw-list';
    panel.appendChild(listEl);

    root.appendChild(panel);
    document.body.appendChild(root);
  }

  function open() {
    ensureUI();
    prevFocus = document.activeElement;
    if (prevFocus && typeof prevFocus.blur === 'function') prevFocus.blur();
    inputEl.value = '';
    root.classList.add('ssw-open');
    refresh();
    inputEl.focus();
  }

  function close() {
    if (!root) return;
    root.classList.remove('ssw-open');
  }

  function refresh() {
    const query = inputEl.value;
    const tabs = getSheetTabs();
    if (!query) {
      items = tabs.map(t => ({ ...t, matches: [], score: 0 }));
    } else {
      items = tabs
        .map(t => {
          const r = fuzzyScore(query, t.name);
          return r ? { ...t, matches: r.matches, score: r.score } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);
    }
    selected = 0;
    render();
  }

  function render() {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ssw-empty';
      empty.textContent = '該当するシートがありません';
      listEl.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const li = document.createElement('li');
      const cls = ['ssw-item'];
      if (i === selected) cls.push('ssw-selected');
      if (item.hidden) cls.push('ssw-hidden');
      li.className = cls.join(' ');

      const nameWrap = document.createElement('span');
      appendHighlighted(nameWrap, item.name, item.matches);
      li.appendChild(nameWrap);

      if (item.active) {
        const badge = document.createElement('span');
        badge.className = 'ssw-badge ssw-badge-current';
        badge.textContent = 'current';
        li.appendChild(badge);
      } else if (item.hidden) {
        const badge = document.createElement('span');
        badge.className = 'ssw-badge ssw-badge-hidden';
        badge.textContent = 'hidden';
        li.appendChild(badge);
      }

      li.addEventListener('mousedown', e => { e.preventDefault(); choose(i); });
      li.addEventListener('mouseenter', () => { selected = i; updateSelection(); });
      listEl.appendChild(li);
    });
  }

  function updateSelection() {
    Array.from(listEl.children).forEach((el, i) => {
      if (el.classList) el.classList.toggle('ssw-selected', i === selected);
    });
    const el = listEl.children[selected];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function appendHighlighted(parent, name, matches) {
    const set = new Set(matches);
    let buffer = '';
    let bufferIsMatch = false;

    const flush = () => {
      if (!buffer) return;
      if (bufferIsMatch) {
        const span = document.createElement('span');
        span.className = 'ssw-match';
        span.textContent = buffer;
        parent.appendChild(span);
      } else {
        parent.appendChild(document.createTextNode(buffer));
      }
      buffer = '';
    };

    for (let i = 0; i < name.length; i++) {
      const isMatch = set.has(i);
      if (i > 0 && isMatch !== bufferIsMatch) flush();
      bufferIsMatch = isMatch;
      buffer += name[i];
    }
    flush();
  }

  function onInputKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length > 0) {
        selected = (selected + 1) % items.length;
        updateSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length > 0) {
        selected = (selected - 1 + items.length) % items.length;
        updateSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(selected);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function choose(i) {
    const item = items[i];
    if (!item) return;
    close();
    activateTab(item.el);
  }

  // -------------------------------------------------------------------------
  // ホットキー: Ctrl+Shift+O
  // capture フェーズ + stopImmediatePropagation で
  // Google スプレッドシート本体の keydown ハンドラより先に奪う。
  // -------------------------------------------------------------------------
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey
        && (e.key === 'O' || e.key === 'o' || e.code === 'KeyO')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      open();
    }
  }, true);
})();
```

## ポイント

VSCodeの実装を参考に、入力内容との一致具合をスコア化してソートするようにしています。
なお、VSCodeではファイル名検索はCtrl + Pですが、印刷のショートカットと競合してしまうためCtrl + Shift + Oとしました。

## 最後に

今回記事を執筆するにあたってスプレッドシート内臓のショートカット集を確認したのですが、
今まで知らなかった便利なものがいくつかあったのでご紹介です。

| ショートカット | 動作 |
|--|--|
| `Ctrl + /` | キーボードショートカット一覧を表示 |
| `Ctrl + O` | ファイルを開くダイアログを表示 |
| `Ctrl + Alt + -` | 行/列の追加または削除（ダイアログで選択） |

以上です。最後まで読んでいただきありがとうございます。

## 参考

- [Tampermonkey](https://www.tampermonkey.net/)
- [VSCode の fuzzyScore 実装(src/vs/base/common/filters.ts)](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/fuzzyScorer.ts)
