// Cytoscape の上に HTML のラベルを重ねる。
// canvas のラベルは1つの書式しか持てないので、「種類・名前・主要な設定値」を書き分けるために HTML で描く。
// パン・ズームのたびに位置を合わせる（transform だけを更新するのでレイアウトは発生しない）。
import { h } from './dom.js';
import { NODE_BOX } from './cyStyle.js';

function caption(node) {
  const { kind, name, summary } = node.data();
  return h('div', { class: 'ov-caption' }, [
    h('span', { class: 'ov-kind' }, kind),
    h('span', { class: 'ov-name' }, name),
    summary ? h('span', { class: 'ov-summary' }, summary) : null,
  ]);
}

function groupHead(node) {
  const { kind, name, summary, icon } = node.data();
  return h('div', { class: `ov-group ${node.classes().join(' ')}` }, [
    icon ? h('img', { src: icon, alt: '', width: 28, height: 28 }) : null,
    h('span', { class: 'ov-group-text' }, [
      h('span', { class: 'ov-group-kind' }, kind),
      h('span', { class: 'ov-group-name' }, name),
      summary ? h('span', { class: 'ov-group-summary' }, summary) : null,
    ]),
  ]);
}

export function createOverlay(host, cy) {
  const layer = h('div', { class: 'overlay', 'aria-hidden': 'true' });
  host.append(layer);
  let items = [];
  let frame = 0;

  function position() {
    const zoom = cy.zoom();
    items.forEach(({ node, el, isGroup }) => {
      const bb = node.renderedBoundingBox({ includeLabels: false, includeOverlays: false, includeUnderlays: false });
      const x = isGroup ? bb.x1 : (bb.x1 + bb.x2) / 2 - (NODE_BOX.captionWidth / 2) * zoom;
      const y = isGroup ? bb.y1 : bb.y2 + NODE_BOX.captionGap * zoom;
      el.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
      el.classList.toggle('is-faded', node.hasClass('faded'));
      el.classList.toggle('is-selected', node.hasClass('selected'));
    });
  }

  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      position();
    });
  }

  /** 要素を入れ替えたあとに呼ぶ */
  function build() {
    items = cy.nodes().map((node) => {
      const isGroup = node.data('role') === 'group';
      return { node, isGroup, el: isGroup ? groupHead(node) : caption(node) };
    });
    layer.replaceChildren(...items.map((i) => i.el));
    position();
  }

  cy.on('render', schedule);
  return { build, refresh: schedule };
}
