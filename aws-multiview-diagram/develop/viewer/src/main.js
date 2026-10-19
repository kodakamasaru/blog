import cytoscape from 'cytoscape';
import elk from 'cytoscape-elk';
import { projectView, visibleOwner } from './graph.js';
import { cyStyle, readTokens, legendSwatch, layerSwatch } from './cyStyle.js';
import { renderPanel } from './panel.js';
import { VIEWS, VIEW_NAMES, LAYERS, LAYER_NAMES, DEFAULT_LAYERS } from './views.js';
import { h } from './dom.js';
import { createOverlay } from './overlay.js';
import { GROUP_PADDING, GROUP_MIN_WIDTH, GROUP_MIN_HEIGHT } from './cyStyle.js';

cytoscape.use(elk);

const FIT_PADDING = 84;
const SWITCH_FADE_MS = 160;
// 検索で飛んだときのズーム（文字が読める大きさ）
const FOCUS_ZOOM = 1;
const FOCUS_MS = 350;

function layoutOptions(viewName) {
  const { direction, layerGap, nodeGap, hierarchy = 'INCLUDE_CHILDREN' } = VIEWS[viewName].layout;
  // SEPARATE_CHILDREN: 枠ごとに独立して配置し、つながっていない塊を詰めて並べる（統合ビューの縦長を防ぐ）
  const packing = hierarchy === 'SEPARATE_CHILDREN' ? { 'elk.separateConnectedComponents': true, 'elk.spacing.componentComponent': 40 } : {};
  return {
    name: 'elk',
    fit: false,
    animate: false,
    nodeDimensionsIncludeLabels: true,
    elk: {
      algorithm: 'layered',
      'elk.direction': direction,
      'elk.hierarchyHandling': hierarchy,
      ...packing,
      'elk.layered.spacing.nodeNodeBetweenLayers': layerGap,
      'elk.spacing.nodeNode': nodeGap,
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    // 枠（Region / VPC / サブネット）の余白と最小幅を ELK にも伝えないと、Cytoscape 側の枠と重なる
    nodeLayoutOptions: (node) =>
      node.isParent()
        ? {
            'elk.padding': `[top=${GROUP_PADDING},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
            'elk.nodeSize.constraints': 'MINIMUM_SIZE',
            'elk.nodeSize.minimum': `(${GROUP_MIN_WIDTH}, ${GROUP_MIN_HEIGHT})`,
          }
        : {},
  };
}

// ---------- state（URL のハッシュにも保存して、リンクで同じ見え方を共有できるようにする） ----------

function parseHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const view = VIEW_NAMES.includes(params.get('view')) ? params.get('view') : 'network';
  const node = params.get('node');
  const layers = params.has('layers') ? params.get('layers').split(',').filter((l) => LAYER_NAMES.includes(l)) : [...DEFAULT_LAYERS];
  return { view, selection: node ? { type: 'node', id: node } : null, layers };
}

function writeHash(state) {
  const params = new URLSearchParams({ view: state.view });
  if (state.selection?.type === 'node') params.set('node', state.selection.id);
  if (state.view === 'unified') params.set('layers', state.layers.join(','));
  history.replaceState(null, '', `#${params}`);
}

let state = {
  ...parseHash(),
  collapsed: Object.fromEntries(VIEW_NAMES.map((v) => [v, new Set()])),
  code: null,
};

// ---------- DOM ----------

const els = {
  body: document.body,
  tabs: document.querySelector('.views'),
  desc: document.getElementById('view-desc'),
  legend: document.getElementById('legend'),
  canvas: document.getElementById('cy'),
  panel: document.getElementById('panel'),
  emptyNote: document.getElementById('empty-note'),
  search: document.getElementById('search'),
  searchList: document.getElementById('search-list'),
};

let pendingFocus = null;

let model = null;
let tokens = null;
let cy = null;
let overlay = null;
let renderedGraphKey = null;

const actions = {
  selectNode: (id) => setState({ selection: { type: 'node', id }, code: null }),
  selectEdge: (ids) => setState({ selection: { type: 'edge', ids }, code: null }),
  clear: () => setState({ selection: null, code: null }),
  switchView: (view) => setState({ view, code: null, selection: state.selection?.type === 'node' ? state.selection : null }),
  toggleCollapse: (id) => {
    const current = state.collapsed[state.view];
    const next = new Set(current.has(id) ? [...current].filter((x) => x !== id) : [...current, id]);
    setState({ collapsed: { ...state.collapsed, [state.view]: next } });
  },
  showCode: (address) => setState({ code: address }),
  // 検索から: 畳んだ枠の中にあれば開いて、選択してそこへ寄る
  focusNode: (id) => {
    const { parents } = model.views[state.view];
    const ancestors = [];
    for (let cur = parents[id]; cur; cur = parents[cur]) ancestors.push(cur);
    const collapsed = new Set([...state.collapsed[state.view]].filter((g) => !ancestors.includes(g)));
    pendingFocus = id;
    setState({ selection: { type: 'node', id }, code: null, collapsed: { ...state.collapsed, [state.view]: collapsed } });
  },
  toggleLayer: (layer) =>
    setState({ layers: state.layers.includes(layer) ? state.layers.filter((l) => l !== layer) : LAYER_NAMES.filter((l) => l === layer || state.layers.includes(l)) }),
};

function setState(patch) {
  state = { ...state, ...patch };
  render();
}

function renderTabs() {
  els.tabs.replaceChildren(
    ...VIEW_NAMES.map((v) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'view-tab',
          style: { '--tab-color': `var(--view-${v})` },
          'aria-selected': String(v === state.view),
          onClick: () => actions.switchView(v),
        },
        [h('span', { class: 'num' }, `${VIEWS[v].key} · ${VIEWS[v].label}`), h('span', { class: 'ja' }, VIEWS[v].ja)],
      ),
    ),
  );
}

function renderChrome() {
  els.body.dataset.view = state.view;
  const empty = model.views[state.view].empty;
  els.emptyNote.hidden = !empty;
  els.emptyNote.textContent = empty ? `この視点には描けるものがありません。${empty}` : '';
  renderTabs();
  renderSearchList();
  els.desc.replaceChildren(...VIEWS[state.view].desc.map(([text, strong]) => (strong ? h('strong', {}, text) : text)));
  els.legend.replaceChildren(...(state.view === 'unified' ? layerToggles() : VIEWS[state.view].legend.map((item) => h('li', {}, [legendSwatch(item.kind, tokens), item.text]))));
}

// ---------- 検索 ----------

function searchableNodes() {
  const view = model.views[state.view];
  const groups = new Set(Object.values(view.parents));
  return view.nodes.map((id) => model.nodes.find((n) => n.id === id)).filter((n) => n && !groups.has(n.id) && n.id !== 'internet');
}

function renderSearchList() {
  els.searchList.replaceChildren(...searchableNodes().map((n) => h('option', { value: n.name, label: n.kind })));
}

/** 名前の完全一致を優先し、無ければ部分一致（大文字小文字は区別しない）の先頭 */
function findNode(query) {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const nodes = searchableNodes();
  return (nodes.find((n) => n.name.toLowerCase() === q) ?? nodes.find((n) => `${n.kind} ${n.name}`.toLowerCase().includes(q)))?.id ?? null;
}

function onSearch() {
  const id = findNode(els.search.value);
  els.search.setCustomValidity(id ? '' : '見つかりません');
  els.search.reportValidity();
  if (id) actions.focusNode(id);
}

/** 統合ビューでは凡例がレイヤーの切り替えボタンを兼ねる（Shift + 1〜3 でも切り替え） */
function layerToggles() {
  return LAYER_NAMES.map((layer, i) =>
    h('li', {}, [
      h(
        'button',
        {
          type: 'button',
          class: 'layer-toggle',
          style: { '--layer-color': `var(--view-${layer})` },
          'aria-pressed': String(state.layers.includes(layer)),
          title: `Shift + ${i + 1}`,
          onClick: () => actions.toggleLayer(layer),
        },
        [layerSwatch(layer, tokens), LAYERS[layer].label, h('span', { class: 'layer-note' }, LAYERS[layer].note)],
      ),
    ]),
  );
}

// ---------- graph ----------

function graphKey() {
  return `${state.view}|${[...state.collapsed[state.view]].sort().join(',')}`;
}

async function renderGraph() {
  const key = graphKey();
  if (key === renderedGraphKey) return;
  const viewChanged = renderedGraphKey?.split('|')[0] !== state.view;
  renderedGraphKey = key;

  if (viewChanged && cy) {
    els.canvas.classList.add('is-switching');
    await new Promise((r) => setTimeout(r, SWITCH_FADE_MS));
  }
  cy.batch(() => {
    cy.elements().remove();
    cy.add(projectView(model, state.view, state.collapsed[state.view]));
    cy.style(cyStyle(tokens, state.view));
  });
  // 外向きの経路（サブネット → NAT → IGW）は、インターネットから入ってくる流れと逆向きの循環を作って
  // 配置を崩すので、レイアウトの計算からは外す（線の表示は残す）
  const layoutEles = cy.elements().not(cy.edges('.route').filter((e) => e.source().id() !== 'internet'));
  const layout = layoutEles.layout(layoutOptions(state.view));
  const done = layout.promiseOn('layoutstop');
  layout.run();
  await done;
  cy.fit(undefined, FIT_PADDING);
  overlay.build();
  applySelection();
  els.canvas.classList.remove('is-switching');
}

/** 詳細パネルが右から開くので、選択した要素がパネルの下に隠れないようにずらす */
function keepVisible(target) {
  const panelWidth = els.panel.getBoundingClientRect().width;
  const visibleRight = els.canvas.clientWidth - panelWidth - 24;
  const bb = target.renderedBoundingBox();
  if (bb.x2 > visibleRight) cy.animate({ panBy: { x: visibleRight - bb.x2, y: 0 } }, { duration: 250 });
}

/** 非表示のレイヤーの線を隠す（配置はそのまま） */
function applyLayers() {
  cy.edges().removeClass('layer-off');
  if (state.view !== 'unified') return;
  LAYER_NAMES.filter((l) => !state.layers.includes(l)).forEach((l) => cy.edges(`.layer-${l}`).addClass('layer-off'));
}

function applySelection() {
  applyLayers();
  cy.elements().removeClass('faded selected neighbor');
  const sel = state.selection;
  if (!sel) return;
  const { parents } = model.views[state.view];
  const collapsed = state.collapsed[state.view];

  const target =
    sel.type === 'node'
      ? cy.getElementById(visibleOwner(sel.id, parents, collapsed))
      : cy.edges().filter((e) => e.data('edgeIds').some((id) => sel.ids.includes(id)));
  if (target.empty()) return;

  // 隠しているレイヤーの線でつながる相手は強調しない
  const edges = target.connectedEdges().not('.layer-off');
  const focus = sel.type === 'node' ? target.union(edges).union(edges.connectedNodes()) : target.union(target.connectedNodes());
  const keep = focus.union(focus.ancestors());
  cy.elements().not(keep).addClass('faded');
  target.addClass('selected');
  keepVisible(target);
  if (sel.type === 'node') edges.addClass('neighbor');
}

function initCy() {
  cy = cytoscape({
    container: els.canvas,
    wheelSensitivity: 0.25,
    minZoom: 0.3,
    maxZoom: 2.5,
    boxSelectionEnabled: false,
  });
  overlay = createOverlay(els.canvas, cy);
  cy.on('tap', 'node', (evt) => actions.selectNode(evt.target.id()));
  cy.on('tap', 'edge', (evt) => actions.selectEdge(evt.target.data('edgeIds')));
  cy.on('tap', (evt) => evt.target === cy && actions.clear());
  cy.on('dbltap', 'node', (evt) => {
    const id = evt.target.id();
    const isGroup = Object.values(model.views[state.view].parents).includes(id);
    if (isGroup) actions.toggleCollapse(id);
  });
  cy.on('mouseover', 'node, edge', () => (els.canvas.style.cursor = 'pointer'));
  cy.on('mouseout', 'node, edge', () => (els.canvas.style.cursor = ''));
  window.addEventListener('resize', () => cy.fit(undefined, FIT_PADDING));
}

// ---------- render ----------

async function render() {
  writeHash(state);
  renderChrome();
  els.panel.replaceChildren(renderPanel(model, state, actions));
  els.body.classList.toggle('has-selection', Boolean(state.selection));
  await renderGraph();
  applySelection();
  if (pendingFocus) {
    const target = cy.getElementById(pendingFocus);
    pendingFocus = null;
    if (target.nonempty()) cy.animate({ center: { eles: target }, zoom: Math.max(cy.zoom(), FOCUS_ZOOM) }, { duration: FOCUS_MS });
  }
}

function onKey(evt) {
  if (evt.target.closest('input, textarea')) {
    if (evt.key === 'Escape') evt.target.blur();
    return;
  }
  if (evt.key === '/') {
    evt.preventDefault();
    els.search.focus();
    return;
  }
  // Shift + 1〜3 は統合ビューのレイヤー切り替え（evt.code で数字キーを見る。Shift で記号になるため）
  const digit = evt.code?.match(/^Digit(\d)$/)?.[1];
  if (evt.shiftKey && digit && state.view === 'unified') {
    const layer = LAYER_NAMES[Number(digit) - 1];
    if (layer) actions.toggleLayer(layer);
    return;
  }
  const view = VIEW_NAMES.find((v) => VIEWS[v].key === evt.key);
  if (view) actions.switchView(view);
  if (evt.key === 'Escape') actions.clear();
}

async function main() {
  try {
    // ?model=samples/xxx.json で別のモデルを開ける（網羅率の確認用。パスは viewer/public 配下に限る）
    const requested = new URLSearchParams(location.search).get('model');
    const modelPath = requested && /^[\w./-]+\.json$/.test(requested) && !requested.includes('..') ? requested : 'model.json';
    const res = await fetch(`${import.meta.env.BASE_URL}${modelPath}`);
    if (!res.ok) throw new Error(`model.json を読み込めませんでした（HTTP ${res.status}）`);
    model = await res.json();
  } catch (err) {
    els.panel.replaceChildren(h('div', { class: 'panel-empty' }, [h('h2', {}, '読み込みに失敗しました'), h('p', {}, err.message), h('p', {}, 'npm run model で viewer/public/model.json を生成してください。')]));
    return;
  }
  // 統合ビューで「どの線にもつながらないもの」をまとめた枠は、最初は畳んでおく
  state = { ...state, collapsed: { ...state.collapsed, unified: new Set(model.views.unified?.collapsed ?? []) } };
  await document.fonts.ready;
  tokens = readTokens();
  initCy();
  // 撮影・E2E 用（?e2e を付けたときだけ Cytoscape のインスタンスを公開して、ノードの座標を取れるようにする）
  if (new URLSearchParams(location.search).has('e2e')) window.__tfscope = { cy };
  document.addEventListener('keydown', onKey);
  els.search.addEventListener('change', onSearch);
  els.search.addEventListener('input', () => els.search.setCustomValidity(''));
  window.addEventListener('hashchange', () => {
    const fromHash = parseHash();
    const current = state.selection?.type === 'node' ? state.selection.id : null;
    const next = fromHash.selection?.id ?? null;
    const layersChanged = fromHash.layers.join() !== state.layers.join();
    if (fromHash.view !== state.view || next !== current || layersChanged) setState({ ...fromHash, code: null });
  });
  await render();
}

main();
