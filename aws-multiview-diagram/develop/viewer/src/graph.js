// モデルの1つの視点を、折りたたみ状態に応じて Cytoscape の elements に変換する（DOM に依存しない純粋関数）。
// 折りたたまれたグループの中にあるノードは、そのグループに吸収され、エッジの端点もグループに付け替える。
import { iconOf } from './icons.js';

/** 祖先をたどって、折りたたまれている一番外側のグループを返す（無ければ自分自身） */
export function visibleOwner(id, parents, collapsed) {
  const chain = [];
  for (let cur = id; cur != null; cur = parents[cur]) chain.push(cur);
  const outermost = [...chain].reverse().find((c) => c !== id && collapsed.has(c));
  return outermost ?? id;
}

export function childCounts(parents) {
  return Object.values(parents).reduce((acc, p) => ({ ...acc, [p]: (acc[p] ?? 0) + 1 }), {});
}

/**
 * @param {object} model tf2model の出力
 * @param {'network'|'iam'|'data'} viewName
 * @param {Set<string>} collapsed 折りたたんでいるグループの ID
 */
export function projectView(model, viewName, collapsed = new Set()) {
  const view = model.views[viewName];
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const { parents } = view;
  const counts = childCounts(parents);
  const isGroup = (id) => (counts[id] ?? 0) > 0;

  const warned = new Set(view.warnings ?? []);
  const visible = view.nodes.filter((id) => visibleOwner(id, parents, collapsed) === id);
  const nodes = visible.map((id) => withCaption(nodeElement(id)));

  function nodeElement(id) {
    const n = nodeById.get(id);
    const isCollapsed = collapsed.has(id);
    const role = isGroup(id) ? (isCollapsed ? 'collapsed' : 'group') : 'leaf';
    const parent = parents[id];
    return {
      group: 'nodes',
      data: {
        id,
        parent: parent && !collapsed.has(parent) ? parent : undefined,
        icon: iconOf(n),
        kind: n.kind,
        name: n.name,
        summary: isCollapsed ? `${counts[id]} 個を折りたたみ中` : n.summary ?? '',
        role,
      },
      classes: [`cat-${n.category}`, role, n.type?.replaceAll('.', '-'), n.warning || warned.has(id) ? 'has-warning' : ''].filter(Boolean).join(' '),
    };
  }

  const edges = view.edges
    .map((e) => ({ ...e, from: visibleOwner(e.source, parents, collapsed), to: visibleOwner(e.target, parents, collapsed) }))
    .filter((e) => e.from !== e.to)
    .reduce((acc, e) => {
      const key = `${e.layer ?? ''}:${e.kind}:${e.from}->${e.to}`;
      const prev = acc.get(key);
      const merged = prev
        ? { ...prev, ids: [...prev.ids, e.id], labels: [...new Set([...prev.labels, e.label])], inferred: prev.inferred && e.inferred }
        : { ...e, key, ids: [e.id], labels: [e.label] };
      return new Map(acc).set(key, merged);
    }, new Map());

  const edgeElements = [...edges.values()].map((e) => ({
    group: 'edges',
    data: { id: e.key, source: e.from, target: e.to, label: e.labels.join(' / '), edgeIds: e.ids },
    classes: [e.kind, e.inferred ? 'inferred' : 'explicit', e.bidirectional ? 'bidirectional' : '', e.layer ? `layer-${e.layer}` : ''].filter(Boolean).join(' '),
  }));

  return [...nodes, ...edgeElements];
}

/** レイアウトでキャプションの場所を空けるための文字列（表示は overlay.js が行う） */
function withCaption(el) {
  const { kind, name, summary, role } = el.data;
  const caption = role === 'group' ? '' : [kind, name, summary].filter(Boolean).join('\n');
  return { ...el, data: { ...el.data, caption } };
}

/** 選択中のノードについて、その視点でつながっているエッジ */
export function connectionsOf(model, viewName, id) {
  const { edges } = model.views[viewName];
  return {
    incoming: edges.filter((e) => e.target === id),
    outgoing: edges.filter((e) => e.source === id),
  };
}

/** ノードが出てくる視点の一覧 */
export function viewsContaining(model, id) {
  return Object.entries(model.views)
    .filter(([, v]) => v.nodes.includes(id))
    .map(([name]) => name);
}
