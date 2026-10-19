// 右側の詳細パネル。「図をクリックしたら詳細が開く」部分で、図には載せきれない情報をここに出す。
import { h } from './dom.js';
import { VIEWS, VIEW_NAMES } from './views.js';
import { connectionsOf, viewsContaining } from './graph.js';
import { iconOf } from './icons.js';

const ATTR_LIMIT = 40;

function section(title, ...children) {
  return h('section', { class: 'section' }, [h('h3', {}, title), ...children]);
}

function nameOf(model, id) {
  return model.nodes.find((n) => n.id === id)?.name ?? id;
}

function codeBlock(model, address) {
  // count / for_each のインスタンス（aws_subnet.private[0]）は、ブロック（aws_subnet.private）のコードを出す
  const src = model.sources[address] ?? model.sources[address.replace(/\[[^\]]*\]/g, '')];
  if (!src) return h('p', { class: 'address' }, `${address}（ソースが見つかりません）`);
  return h('div', {}, [
    h('div', { class: 'code-head' }, [h('span', {}, address), h('span', {}, `${src.file}:${src.line}`)]),
    h('pre', { class: 'code' }, src.code),
  ]);
}

function viewJump(model, state, actions, id) {
  const present = new Set(viewsContaining(model, id));
  return h(
    'div',
    { class: 'view-jump' },
    VIEW_NAMES.map((v) =>
      h(
        'button',
        {
          type: 'button',
          style: { '--btn-color': `var(--view-${v})` },
          'aria-current': v === state.view ? 'true' : null,
          disabled: !present.has(v),
          title: present.has(v) ? `${VIEWS[v].ja}で見る` : `${VIEWS[v].ja}には出てきません`,
          onClick: () => v !== state.view && actions.switchView(v),
        },
        VIEWS[v].ja,
      ),
    ),
  );
}

function connectionList(model, state, actions, id) {
  const { incoming, outgoing } = connectionsOf(model, state.view, id);
  const item = (e, dir, other) =>
    h('li', {}, h(
      'button',
      { type: 'button', class: `linkish ${e.inferred ? 'inferred' : ''}`, onClick: () => actions.selectEdge([e.id]) },
      [h('span', { class: 'dir' }, dir), h('span', {}, [h('span', { class: 'who' }, nameOf(model, other)), h('span', { class: 'what' }, `${e.label}${e.inferred ? '（推定）' : ''}`)])],
    ));
  const items = [...incoming.map((e) => item(e, '←', e.source)), ...outgoing.map((e) => item(e, '→', e.target))];
  if (items.length === 0) return h('p', {}, 'この視点ではつながりがありません。');
  return h('ul', { class: 'conn' }, items);
}

function settingsList(node) {
  if (!node.settings?.length) return null;
  return section(
    '主要な設定',
    h('dl', { class: 'settings' }, node.settings.flatMap((s) => [h('dt', {}, s.label), h('dd', { class: s.pending ? 'pending' : null }, s.value)])),
  );
}

/** plan の生の属性は、主要な設定で足りないときのために折りたたんで残す */
function rawAttrs(node) {
  const entries = Object.entries(node.attrs).filter(([k]) => k !== 'subnets' && k !== 'trustedBy').slice(0, ATTR_LIMIT);
  if (entries.length === 0) return null;
  return h('details', { class: 'raw section' }, [
    h('summary', {}, `plan の属性をそのまま見る（${entries.length}件）`),
    h('dl', { class: 'attrs' }, entries.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])),
  ]);
}

function heading(node) {
  const icon = iconOf(node);
  return h('div', { class: 'panel-head' }, [
    icon ? h('img', { src: icon, alt: '', width: 44, height: 44 }) : null,
    h('div', {}, [
      h('span', { class: 'panel-kind' }, node.kind),
      h('h2', { class: 'title' }, node.name),
    ]),
  ]);
}

function groupDetail(node, state, actions) {
  const collapsed = state.collapsed[state.view].has(node.id);
  const subnets = node.attrs.subnets
    ? section(
        'サブネット',
        h('table', { class: 'subnets' }, [
          h('thead', {}, h('tr', {}, ['name', 'cidr', 'az'].map((c) => h('th', {}, c)))),
          h('tbody', {}, node.attrs.subnets.map((s) => h('tr', {}, [s.name, s.cidr, s.az].map((c) => h('td', {}, c ?? '—'))))),
        ]),
      )
    : null;
  return [
    subnets,
    h('button', { type: 'button', class: 'toggle', onClick: () => actions.toggleCollapse(node.id) }, collapsed ? '展開する' : '折りたたむ'),
  ];
}

function nodeDetail(model, state, actions, id) {
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return emptyState();
  const inView = model.views[state.view].nodes.includes(id);
  const isGroup = Object.values(model.views[state.view].parents).includes(id);
  const codeAddress = state.code ?? node.address;

  return h('div', {}, [
    heading(node),
    node.summary ? h('p', { class: 'panel-summary' }, node.summary) : null,
    h('p', { class: 'address' }, [node.fullName && node.fullName !== node.name ? `${node.fullName} · ` : '', node.address ?? node.id]),
    inView
      ? section(`${VIEWS[state.view].ja}でのつながり`, connectionList(model, state, actions, id))
      : section(`${VIEWS[state.view].ja}でのつながり`, h('p', { class: 'note' }, 'このリソースはこの視点には出てきません。')),
    settingsList(node),
    isGroup ? groupDetail(node, state, actions) : null,
    section('他の視点で見る', viewJump(model, state, actions, id)),
    node.related?.length
      ? section(
          '関連リソース（ノードにしていないもの）',
          h('ul', { class: 'conn' }, node.related.map((a) =>
            h('li', {}, h('button', { type: 'button', class: 'linkish', 'aria-current': a === state.code ? 'true' : null, onClick: () => actions.showCode(a) }, [h('span', { class: 'dir' }, '⌁'), h('span', { class: 'what' }, a)])),
          )),
        )
      : null,
    codeAddress ? section('IaC のソース', codeBlock(model, codeAddress)) : null,
    rawAttrs(node),
  ]);
}

function edgeDetail(model, state, actions, ids) {
  const edges = model.views[state.view].edges.filter((e) => ids.includes(e.id));
  if (edges.length === 0) return emptyState();
  const [first] = edges;
  const inferred = edges.every((e) => e.inferred);
  const evidence = edges.flatMap((e) => e.evidence);
  const codeAddress = state.code ?? evidence[0]?.address;

  return h('div', {}, [
    h('span', { class: `chip ${inferred ? 'inferred' : ''}`, style: { color: `var(--view-${first.layer ?? state.view})` } }, inferred ? '推定' : first.kind),
    h('h2', { class: 'title' }, [
      h('button', { type: 'button', class: 'linkish', style: { display: 'inline', padding: 0, width: 'auto', font: 'inherit' }, onClick: () => actions.selectNode(first.source) }, nameOf(model, first.source)),
      ' → ',
      h('button', { type: 'button', class: 'linkish', style: { display: 'inline', padding: 0, width: 'auto', font: 'inherit' }, onClick: () => actions.selectNode(first.target) }, nameOf(model, first.target)),
    ]),
    h('p', { class: 'address' }, edges.map((e) => e.label).join(' / ')),
    inferred ? section('なぜ推定なのか', h('p', { class: 'note' }, inferenceNote(edges))) : null,
    actionsOf(edges).length > 3
      ? section(`許可されている操作（${actionsOf(edges).length} 件）`, h('p', { class: 'address' }, actionsOf(edges).join(', ')))
      : null,
    section(
      '根拠',
      h('ul', { class: 'conn' }, evidence.map((ev) =>
        h('li', {}, h('button', { type: 'button', class: 'linkish', 'aria-current': ev.address === codeAddress ? 'true' : null, onClick: () => actions.showCode(ev.address) }, [
          h('span', { class: 'dir' }, '⌁'),
          h('span', {}, [h('span', { class: 'who' }, ev.text), h('span', { class: 'what' }, ev.address)]),
        ])),
      )),
    ),
    codeAddress ? section('IaC のソース', codeBlock(model, codeAddress)) : null,
  ]);
}

function actionsOf(edges) {
  return [...new Set(edges.flatMap((e) => e.actions ?? []))];
}

function inferenceNote(edges) {
  if (edges.some((e) => e.strength === 'shared-role')) {
    return 'IAM で許可されていますが、このロールは複数のリソースで共有されているため、実際にどれが使うのかは IaC からは分かりません。「許可されていてアクセスできる状態」として点線で描いています。';
  }
  if (edges.some((e) => e.strength === 'iam-only')) {
    return 'IAM で、この相手への操作が許可されています。アプリが実際に呼んでいるかは IaC からは分からないので、「許可されていてアクセスできる状態」として点線で描いています（環境変数などで接続先を参照している根拠はありません）。';
  }
  return 'IaC にはアプリのコードが含まれないため、「接続先として参照している」と「権限や通信が許可されている」の両方がそろったところを、データの流れとして描いています。';
}

function emptyState() {
  return h('div', { class: 'panel-empty' }, [
    h('h2', {}, '1枚の絵ではなく、見たいものから見る'),
    h('p', {}, 'この図は terraform plan の JSON から生成しています。'),
    h('ol', {}, [
      h('li', {}, '上のタブで視点（NW / IAM / データ）を切り替える'),
      h('li', {}, 'ノードや矢印をクリックすると、根拠になった IaC のコードが開く'),
      h('li', {}, '選択したまま視点を切り替えると、同じリソースを別の視点で追える'),
    ]),
  ]);
}

export function renderPanel(model, state, actions) {
  if (state.selection?.type === 'node') return nodeDetail(model, state, actions, state.selection.id);
  if (state.selection?.type === 'edge') return edgeDetail(model, state, actions, state.selection.ids);
  return emptyState();
}
