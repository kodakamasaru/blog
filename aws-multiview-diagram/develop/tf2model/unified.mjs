// 統合ビュー: 配置は1つにして、視点の違いは「線のレイヤー」で表す。
//   - 配置   : NW 視点の枠（Region / VPC / サブネット層）。VPC の外のリソースは Region の枠に入れる
//   - 線     : network（SG・経路）、data（データの流れ）、iam（権限）の3レイヤー
//   - 権限   : ロールはノードにせず、「ロールを使う側 → 許可された相手」の線に畳む（ロールとポリシーは根拠に残す）
// タブを切り替えても配置が変わらないので、同じリソースを探し直さなくてよい。

// ノードにしない種類（IAM の主体や管理ポリシー。権限の線の根拠として詳細パネルに出す）
const NOT_A_RESOURCE = new Set(['aws_iam_role', 'managed-policy', 'principal', 'wildcard']);

const isResource = (n) => n && !NOT_A_RESOURCE.has(n.type) && !n.id.startsWith('any:');

/** 「コンピュート → ロール」と「ロール → 相手」をつないで「コンピュート → 相手」にする */
function permissionEdges(iam, isKept) {
  const usersOf = iam.edges.filter((e) => e.kind === 'assume').reduce((acc, e) => acc.set(e.target, [...(acc.get(e.target) ?? []), e]), new Map());
  const viaRole = iam.edges
    .filter((e) => e.kind === 'allow')
    .flatMap((allow) =>
      (usersOf.get(allow.source) ?? []).map((assume) => ({
        ...allow,
        id: `perm:${assume.source}->${allow.target}`,
        source: assume.source,
        evidence: [...assume.evidence, ...allow.evidence],
      })),
    );
  const resourcePolicies = iam.edges.filter((e) => e.kind === 'resource-policy').map((e) => ({ ...e, id: `rp:${e.source}->${e.target}` }));
  // 同じ組（2つのロール経由など）はまとめる
  const merged = [...viaRole, ...resourcePolicies]
    .filter((e) => e.source !== e.target && isKept(e.source) && isKept(e.target))
    .reduce((acc, e) => {
      const prev = acc.get(e.id);
      return new Map(acc).set(
        e.id,
        prev ? { ...prev, evidence: [...prev.evidence, ...e.evidence], actions: [...new Set([...(prev.actions ?? []), ...(e.actions ?? [])])] } : e,
      );
    }, new Map());
  return [...merged.values()].map((e) => ({ ...e, layer: 'iam' }));
}

/**
 * VPC の外のリソースを、種類（サービス）ごとの枠にまとめる。同じサービスが近くに固まって探しやすくなる。
 * 1つしかない種類はまとめない。中身がすべてどの線にもつながらない枠は、最初は畳んでおく
 */
function groupByService(ids, byId, regionId, connected) {
  const byType = ids.reduce((acc, id) => acc.set(byId.get(id).type, [...(acc.get(byId.get(id).type) ?? []), id]), new Map());
  const groups = [...byType.entries()].filter(([, members]) => members.length > 1);
  const extraNodes = groups.map(([type, members]) => {
    const sample = byId.get(members[0]);
    return { id: `svc:${type}`, type, kind: sample.kind, name: `${members.length} 個`, category: sample.category, summary: '' };
  });
  const parents = Object.fromEntries([
    ...groups.flatMap(([type, members]) => members.map((id) => [id, `svc:${type}`])),
    ...extraNodes.map((g) => [g.id, regionId]),
  ]);
  const collapsed = groups.filter(([, members]) => members.every((id) => !connected.has(id))).map(([type]) => `svc:${type}`);
  return { extraNodes, parents, collapsed };
}

/**
 * @param {{ network: object, iam: object, data: object }} views 各視点
 * @param {object[]} nodes モデルのノード
 * @param {string} regionId Region の枠のノード ID
 */
export function buildUnifiedView(views, nodes, regionId) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const groups = new Set(Object.values(views.network.parents));
  const isKept = (id) => id === 'internet' || groups.has(id) || isResource(byId.get(id));

  const iamEdges = permissionEdges(views.iam, isKept);
  const edges = [
    ...views.network.edges.map((e) => ({ ...e, layer: 'network' })),
    ...views.data.edges.filter((e) => isKept(e.source) && isKept(e.target)).map((e) => ({ ...e, layer: 'data' })),
    ...iamEdges,
  ];

  // 線のないリソース（ECR など）も構成図としては「ある」ことを見せたいので、すべて置く
  const nodeIds = [...new Set([...views.network.nodes, ...edges.flatMap((e) => [e.source, e.target]), ...nodes.map((n) => n.id)])].filter(isKept);
  const outsideVpc = nodeIds.filter((id) => !(id in views.network.parents) && id !== regionId && id !== 'internet' && !groups.has(id));
  const connected = new Set(edges.flatMap((e) => [e.source, e.target]));
  const grouped = groupByService(outsideVpc, byId, regionId, connected);
  const parents = { ...views.network.parents, ...Object.fromEntries(outsideVpc.map((id) => [id, regionId])), ...grouped.parents };
  const withGroups = [...nodeIds, ...grouped.extraNodes.map((g) => g.id)];
  const withRegion = outsideVpc.length && !withGroups.includes(regionId) ? [...withGroups, regionId] : withGroups;

  // Resource: * の権限を持つロールを使っているもの（ロールを畳むので、使う側に印を移す）
  const warnings = [...new Set(views.iam.edges.filter((e) => e.kind === 'assume' && byId.get(e.target)?.warning && isKept(e.source)).map((e) => e.source))];

  // extraNodes（まとめた枠）は model.nodes に足す。collapsed は最初に畳んでおく枠
  return { nodes: withRegion, parents, edges, warnings, collapsed: grouped.collapsed, extraNodes: grouped.extraNodes };
}
