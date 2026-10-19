// Cytoscape のスタイル。色は styles.css の CSS 変数から読んで、定義を1か所にまとめている。
// ノードはアイコンだけを描き、名前や設定値は overlay.js が HTML で重ねる（文字の大きさや太さを混ぜられるようにするため）。

/**
 * ノードはアイコンの大きさにして、矢印がアイコンに刺さるようにする。
 * キャプションは overlay.js が HTML で描くが、レイアウトで場所を空けるために同じ文字列を透明なラベルとしても持たせる。
 */
export const NODE_BOX = Object.freeze({ icon: 52, captionWidth: 176, captionGap: 6 });
export const GROUP_PADDING = 34;
/** 枠の見出し（アイコン + 種類 + 名前）が収まる幅 */
export const GROUP_MIN_WIDTH = 250;
export const GROUP_MIN_HEIGHT = 120;

/** Cytoscape は oklch() を解釈できないので、canvas に塗って rgb() に変換する */
function toRgb(color) {
  const ctx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

export function readTokens() {
  const css = getComputedStyle(document.documentElement);
  const raw = (name) => css.getPropertyValue(name).trim();
  const color = (name) => toRgb(raw(name));
  return {
    canvas: color('--canvas'),
    ink: color('--ink'),
    inkSoft: color('--ink-soft'),
    edge: color('--edge'),
    font: raw('--font-ui').replaceAll("'", ''),
    views: { network: color('--view-network'), iam: color('--view-iam'), data: color('--view-data') },
    aws: {
      region: color('--aws-region'),
      vpc: color('--aws-vpc'),
      publicLine: color('--aws-public'),
      publicFill: color('--aws-public-fill'),
      privateLine: color('--aws-private'),
      privateFill: color('--aws-private-fill'),
      warning: color('--warning'),
    },
  };
}

function nodeStyles(t) {
  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        width: NODE_BOX.icon,
        height: NODE_BOX.icon,
        'background-opacity': 0,
        'border-width': 0,
        'background-image': 'data(icon)',
        'background-fit': 'contain',
        label: 'data(caption)',
        'text-opacity': 0,
        'text-valign': 'bottom',
        'text-margin-y': NODE_BOX.captionGap,
        'text-wrap': 'wrap',
        'text-max-width': NODE_BOX.captionWidth,
        'font-family': t.font,
        'font-size': 12,
        'line-height': 1.35,
        'transition-property': 'opacity',
        'transition-duration': 180,
      },
    },
    { selector: 'node[!icon]', style: { 'background-image': 'none' } },
    { selector: 'node.has-warning', style: { 'underlay-color': t.aws.warning, 'underlay-opacity': 0.12, 'underlay-padding': 5, 'underlay-shape': 'round-rectangle' } },
    { selector: 'node.cat-warning', style: { 'underlay-color': t.aws.warning, 'underlay-opacity': 0.15, 'underlay-padding': 4 } },
    {
      // AWS のグループ表記: 角は丸めない、左上にアイコン（アイコンと名前は overlay で描く）
      selector: 'node.group',
      style: {
        shape: 'rectangle',
        label: '',
        'background-image': 'none',
        'background-opacity': 0,
        'border-width': 1.5,
        'border-color': t.inkSoft,
        padding: GROUP_PADDING,
        // Cytoscape の min-width は余白を含まない内側の幅なので、ELK に渡す外寸から余白を引く
        'min-width': GROUP_MIN_WIDTH - GROUP_PADDING * 2,
        'min-height': GROUP_MIN_HEIGHT - GROUP_PADDING * 2,
      },
    },
    { selector: 'node.group.region', style: { 'border-style': 'dashed', 'border-color': t.aws.region } },
    { selector: 'node.group.aws_vpc', style: { 'border-color': t.aws.vpc } },
    { selector: 'node.group.public-subnet', style: { 'border-width': 0, 'background-color': t.aws.publicFill, 'background-opacity': 1 } },
    { selector: 'node.group.private-subnet', style: { 'border-width': 0, 'background-color': t.aws.privateFill, 'background-opacity': 1 } },
    { selector: 'node.collapsed', style: { 'border-width': 1.5, 'border-style': 'dashed', 'border-color': t.inkSoft } },
  ];
}

function edgeStyles(t, viewName) {
  const accent = t.views[viewName];
  return [
    {
      selector: 'edge',
      style: {
        width: 1.6,
        'curve-style': 'bezier',
        'line-color': t.edge,
        'target-arrow-color': t.edge,
        'source-arrow-color': t.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 1,
        label: 'data(label)',
        'font-family': t.font,
        'font-size': 11,
        color: t.ink,
        'text-background-color': t.canvas,
        'text-background-opacity': 0.92,
        'text-background-padding': 2,
        'text-wrap': 'wrap',
        'text-max-width': 190,
        'transition-property': 'opacity, width, line-color',
        'transition-duration': 180,
      },
    },
    { selector: 'edge.route', style: { 'line-style': 'dotted', width: 1.4 } },
    { selector: 'edge.assume', style: { 'target-arrow-shape': 'circle', 'arrow-scale': 0.7 } },
    { selector: 'edge.resource-policy', style: { 'line-style': 'dashed', 'line-dash-pattern': [7, 4] } },
    // 推定した線は数が多くラベルが重なるので、普段はラベルを隠し、選んだノードの周りだけ出す
    { selector: 'edge.inferred', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 4], 'text-opacity': 0 } },
    { selector: 'edge.inferred.neighbor, edge.inferred.selected', style: { 'text-opacity': 1 } },
    { selector: 'edge.explicit.flow', style: { width: 2.2 } },
    { selector: 'edge.bidirectional', style: { 'source-arrow-shape': 'triangle' } },
    // IAM はロールからリソースへの線が交差しやすいので、ラベルを線に沿わせて重なりを減らす
    ...(viewName === 'iam' ? [{ selector: 'edge', style: { 'text-rotation': 'autorotate', 'text-margin-y': -8, 'text-background-opacity': 0 } }] : []),

    { selector: '.faded', style: { opacity: 0.14 } },
    { selector: 'node.selected', style: { 'underlay-color': accent, 'underlay-opacity': 0.14, 'underlay-padding': 6, 'underlay-shape': 'round-rectangle' } },
    { selector: 'edge.neighbor, edge.selected', style: { 'line-color': accent, 'target-arrow-color': accent, 'source-arrow-color': accent, width: 2.6 } },
    { selector: 'edge.selected', style: { width: 3.6 } },
  ];
}

/**
 * 統合ビュー: 線の色でレイヤー（各視点の色）を見分ける。ネットワークと権限の線は数が多いので、
 * ラベルは選んだノードの周りだけに出す。非表示のレイヤーは display: none（配置は変えない）
 */
function layerStyles(t) {
  const colored = (layer, extra = {}) => ({
    selector: `edge.layer-${layer}`,
    style: { 'line-color': t.views[layer], 'target-arrow-color': t.views[layer], 'source-arrow-color': t.views[layer], ...extra },
  });
  return [
    colored('network', { width: 1.3, 'text-opacity': 0 }),
    colored('data', { width: 2.4 }),
    colored('iam', { width: 1.4, 'line-style': 'dotted', 'text-opacity': 0, 'text-rotation': 'autorotate' }),
    { selector: 'edge.layer-data.inferred', style: { width: 1.8 } },
    { selector: 'edge.layer-network.neighbor, edge.layer-iam.neighbor, edge.layer-network.selected, edge.layer-iam.selected', style: { 'text-opacity': 1 } },
    // 選んだときもレイヤーの色のまま太くする（どのレイヤーの線か分かるように）
    { selector: 'edge.neighbor', style: { width: 3 } },
    { selector: 'edge.layer-network.neighbor', style: { 'line-color': t.views.network, 'target-arrow-color': t.views.network, 'source-arrow-color': t.views.network } },
    { selector: 'edge.layer-data.neighbor', style: { 'line-color': t.views.data, 'target-arrow-color': t.views.data, 'source-arrow-color': t.views.data } },
    { selector: 'edge.layer-iam.neighbor', style: { 'line-color': t.views.iam, 'target-arrow-color': t.views.iam, 'source-arrow-color': t.views.iam } },
    { selector: 'edge.layer-off', style: { display: 'none' } },
  ];
}

export function cyStyle(t, viewName) {
  return [...nodeStyles(t), ...edgeStyles(t, viewName), ...(viewName === 'unified' ? layerStyles(t) : [])];
}

/** 統合ビューの凡例・切り替えボタン用の線のサンプル */
export function layerSwatch(layer, t) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '34');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'line');
  const dash = { network: '', data: '', iam: '2 3' }[layer];
  Object.entries({ x1: 1, y1: 5, x2: 26, y2: 5, stroke: t.views[layer], 'stroke-width': layer === 'data' ? 2.4 : 1.6, 'stroke-dasharray': dash }).forEach(([k, val]) =>
    line.setAttribute(k, String(val)),
  );
  const head = document.createElementNS(ns, 'path');
  head.setAttribute('d', 'M26 1 L33 5 L26 9 Z');
  head.setAttribute('fill', t.views[layer]);
  svg.append(line, head);
  return svg;
}

/** 凡例の線のサンプル（SVG）。cyStyle のエッジと同じ線種を使う */
export function legendSwatch(kind, t) {
  const spec = {
    sg: { dash: '' },
    route: { dash: '2 3' },
    assume: { dash: '', head: 'circle' },
    allow: { dash: '' },
    'resource-policy': { dash: '7 4' },
    flow: { dash: '', width: 2.2 },
    'flow-inferred': { dash: '6 4' },
  }[kind];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '34');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(ns, 'line');
  Object.entries({ x1: 1, y1: 5, x2: 26, y2: 5, stroke: t.edge, 'stroke-width': spec.width ?? 1.6, 'stroke-dasharray': spec.dash }).forEach(([k, val]) =>
    line.setAttribute(k, String(val)),
  );
  const head = document.createElementNS(ns, spec.head === 'circle' ? 'circle' : 'path');
  if (spec.head === 'circle') Object.entries({ cx: 29, cy: 5, r: 3.5 }).forEach(([k, val]) => head.setAttribute(k, String(val)));
  else head.setAttribute('d', 'M26 1 L33 5 L26 9 Z');
  head.setAttribute('fill', t.edge);
  svg.append(line, head);
  return svg;
}
