// plan JSON（+ .tf のソース）から、ビューア用のモデルを組み立てる。
// モデルは「ノードの一覧」と「視点ごとの見え方（どのノードを出すか・親子関係・エッジ）」に分かれている。
// 同じノードがどの視点にも同じ ID で出てくるので、視点を切り替えても選択中のノードを追いかけられる。
import { indexPlan, allRefsOf, sensitiveStrings } from './plan.mjs';
import { maskLiterals } from './source.mjs';
import { CATALOG, INTERNET_ID, displayName, isNodeResource, commonPrefix } from './catalog.mjs';
import { buildNetworkView } from './network.mjs';
import { buildIamView, trustedBy, wildcardActionsByRole } from './iam.mjs';
import { buildDataView } from './dataflow.mjs';
import { settingsOf } from './settings.mjs';
import { policyContext } from './policy.mjs';
import { buildUnifiedView } from './unified.mjs';

const MAX_ATTR_LENGTH = 80;
const HIDDEN_ATTRS = new Set(['tags', 'tags_all', 'filename', 'force_destroy']);

function primitiveAttrs(values) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([k, v]) =>
        !HIDDEN_ATTRS.has(k) &&
        ['string', 'number', 'boolean'].includes(typeof v) &&
        String(v).length <= MAX_ATTR_LENGTH &&
        v !== '' &&
        v !== false,
    ),
  );
}

/** ノードではない周辺リソース（SG、タスク定義、ポリシーなど）のうち、このノードと直接参照し合っているもの */
function relatedResources(address, index) {
  const others = [...index.values()].filter((r) => r.address !== address && !isNodeResource(r));
  const referencing = others.filter((r) => allRefsOf(r.expressions, index).includes(address));
  const referenced = allRefsOf(index.get(address).expressions, index).filter((a) => !isNodeResource(index.get(a)));
  return [...new Set([...referenced, ...referencing.map((r) => r.address)])];
}

function resourceNode(r, index, prefix, sources, ctx) {
  const { kind, category } = CATALOG[r.type];
  const name = displayName(r);
  const extra = r.type === 'aws_iam_role' ? { trustedBy: trustedBy(r, index, ctx) } : {};
  const { summary, settings } = settingsOf(r, { index, sources, prefix, ...extra });
  return {
    id: r.address,
    address: r.address,
    type: r.type === 'aws_lb' ? `aws_lb.${r.values.load_balancer_type ?? 'application'}` : r.type,
    summary,
    settings,
    kind: r.type === 'aws_lb' && r.values.load_balancer_type === 'network' ? 'NLB' : kind,
    name: name.startsWith(prefix) ? name.slice(prefix.length) : name,
    fullName: name,
    category,
    attrs: { ...primitiveAttrs(r.values), ...extra },
    related: relatedResources(r.address, index),
  };
}

/**
 * リージョン。provider の region が定数ならそれ、変数ならその値、どちらでもなければ
 * リソースの region 属性（AWS プロバイダ v6 以降）やサブネットの AZ から推定する。
 */
function regionOf(plan, index) {
  const expr = plan.configuration?.provider_config?.aws?.expressions?.region;
  if (typeof expr?.constant_value === 'string') return expr.constant_value;
  const varName = (expr?.references ?? []).find((r) => r.startsWith('var.'))?.slice(4);
  const fromVar = varName ? plan.variables?.[varName]?.value : null;
  if (typeof fromVar === 'string') return fromVar;
  const values = [...index.values()].map((r) => r.values);
  const fromAttr = values.map((v) => v.region).find((r) => typeof r === 'string' && /^[a-z]{2}-[a-z]+-\d$/.test(r));
  const fromAz = values.map((v) => v.availability_zone).find((az) => typeof az === 'string' && /^[a-z]{2}-[a-z]+-\d[a-z]$/.test(az));
  return fromAttr ?? (fromAz ? fromAz.slice(0, -1) : 'リージョン不明');
}

/**
 * モジュールのロールが3つとも "fargate" になる、のように同じ種類で名前が重なったら区別する。
 * 補う情報は、インスタンスのキー → モジュール名 → ブロック名の順に、重なりが解消するものを使う。
 */
function disambiguate(nodes, index) {
  const keyOf = (n) => `${n.kind}|${n.name}`;
  const groups = nodes.reduce((acc, n) => acc.set(keyOf(n), [...(acc.get(keyOf(n)) ?? []), n]), new Map());
  const hintsOf = (n) => {
    const r = index.get(n.address);
    const key = n.address.match(/\[(?:"([^"]+)"|(\d+))\]$/);
    return [key?.[1] ?? key?.[2], r.modulePath.split('.').filter((p) => p !== 'module').at(-1), r.name].filter(Boolean);
  };
  const renamed = new Map(
    [...groups.values()]
      .filter((g) => g.length > 1 && g.every((n) => n.address))
      .flatMap((g) => {
        const level = [0, 1, 2].find((i) => new Set(g.map((n) => hintsOf(n)[i])).size === g.length) ?? 2;
        return g.map((n) => [n.id, `${n.name} (${hintsOf(n)[level] ?? hintsOf(n).at(-1)})`]);
      }),
  );
  return nodes.map((n) => (renamed.has(n.id) ? { ...n, name: renamed.get(n.id) } : n));
}

const EMPTY_REASON = Object.freeze({
  network: 'VPC やサブネットに置かれたリソースがありません（VPC を別のスタックで作っている場合、この plan には含まれません）。',
  iam: 'IAM ロールやリソースベースポリシーがありません。',
  data: 'データの流れを読み取れるリソースがありません。',
});

/** ノードが枠（Region / VPC / サブネット）しかない視点は、空として理由を付ける */
function withEmptyReason(name, view, groupIds) {
  const hasContent = view.nodes.some((id) => !groupIds.has(id));
  return hasContent ? view : { ...view, nodes: [], parents: {}, edges: [], empty: EMPTY_REASON[name] };
}

/**
 * Resource: "*" の権限は、共有のノードへの線にすると線が集中して読めないので、ロール自身の警告と設定欄にする
 */
function withWildcard(node, wildcardActions) {
  const actions = wildcardActions.get(node.id);
  if (!actions?.length) return node;
  return {
    ...node,
    warning: true,
    summary: [node.summary, `⚠ Resource:* ${actions.length} 件`].filter(Boolean).join(' · '),
    settings: [...node.settings, { label: 'Resource: * の操作', value: actions.join(', ') }],
  };
}

/** NW 視点で線にしなかった「枠の中からの許可」を、リソースの設定欄に足す */
function withNotes(node, notes, nameOf) {
  const list = notes[node.id];
  if (!list?.length) return node;
  const value = list.map((n) => `${nameOf(n.from)} から ${n.label}`).join(' / ');
  return { ...node, settings: [...node.settings, { label: '受け付ける通信', value }] };
}

function regionNode(id, region) {
  return { id, type: 'region', kind: 'Region', name: region, category: 'group', summary: '', settings: [], attrs: {}, related: [], address: null };
}

/** データフロー視点では、VPC 内のリソースは VPC の枠に、それ以外の AWS リソースは Region の枠に入れる */
function dataParents(view, network, regionId, nodeIds) {
  const vpcOf = (id) => {
    for (let cur = network.parents[id]; cur; cur = network.parents[cur]) if (cur.startsWith('aws_vpc.')) return cur;
    return null;
  };
  const entries = view.nodes.filter((id) => nodeIds.has(id)).map((id) => [id, vpcOf(id) ?? regionId]);
  const vpcs = [...new Set(entries.map(([, p]) => p).filter((p) => p !== regionId))];
  return {
    ...view,
    nodes: [...new Set([regionId, ...vpcs, ...view.nodes])],
    parents: Object.fromEntries([...entries, ...vpcs.map((v) => [v, regionId])]),
  };
}

/** リソースではないがエッジの端点として出てくるノード（インターネット、サービスプリンシパルなど） */
function syntheticNode(id) {
  const base = { summary: '', settings: [], attrs: {}, related: [], category: 'external' };
  if (id === INTERNET_ID) return { ...base, id, type: 'internet', kind: 'Internet', name: 'Internet' };
  if (id === 'any:*') return { ...base, id, type: 'wildcard', kind: 'Wildcard', name: 'Resource: *', category: 'warning' };
  if (id.startsWith('principal:')) return { ...base, id, type: 'principal', kind: 'Service Principal', name: id.slice('principal:'.length) };
  if (id.startsWith('cidr:')) return { ...base, id, type: 'cidr', kind: 'CIDR', name: id.slice('cidr:'.length) };
  if (id.startsWith('managed:')) return { ...base, id, type: 'managed-policy', kind: 'AWS 管理ポリシー', name: id.slice('managed:'.length), category: 'security' };
  return null;
}

/**
 * @param {object} plan terraform show -json の出力
 * @param {Record<string, object>} [sources] scanStack() のコード片（キーはブロックのアドレス）
 * @param {{ locals?: object, dynamics?: object }} [options] scanStack() の locals と dynamic ブロック（参照を辿るのに使う）
 */
export function buildModel(plan, rawSources = {}, { locals = {}, dynamics = {}, moduleMapArgs = {} } = {}) {
  const secrets = sensitiveStrings(plan);
  const sources = Object.fromEntries(Object.entries(rawSources).map(([k, s]) => [k, { ...s, code: maskLiterals(s.code, secrets) }]));
  const index = indexPlan(plan, { locals, dynamics, moduleMapArgs });
  const nodeResources = [...index.values()].filter(isNodeResource);
  const nodeIds = new Set(nodeResources.map((r) => r.address));
  const prefix = commonPrefix(nodeResources.map(displayName));

  const region = regionOf(plan, index);
  const regionId = `region:${region}`;

  const ctx = policyContext(index, sources);
  const { groupNodes, notes, view: network } = buildNetworkView(index, nodeIds, regionId);
  const iam = buildIamView(index, nodeIds, ctx);
  const data = dataParents(buildDataView(index, nodeIds, network.edges, ctx), network, regionId, nodeIds);

  const groupIds = new Set([regionId, ...groupNodes.map((g) => g.id), ...[...nodeIds].filter((id) => index.get(id).type === 'aws_vpc')]);
  const views = Object.fromEntries(Object.entries({ network, iam, data }).map(([name, v]) => [name, withEmptyReason(name, v, groupIds)]));
  const referenced = new Set(Object.values(views).flatMap((v) => v.nodes));
  const synthetic = [...referenced]
    .filter((id) => !nodeIds.has(id) && !id.startsWith('tier:') && id !== regionId)
    .map(syntheticNode)
    .filter(Boolean);

  const nodes = (() => {
    const all = disambiguate([...nodeResources.map((r) => resourceNode(r, index, prefix, sources, ctx)), regionNode(regionId, region), ...groupNodes, ...synthetic], index);
    const nameOf = (id) => {
      const n = all.find((x) => x.id === id);
      return n ? `${n.kind} ${n.name}` : id;
    };
    const wildcard = wildcardActionsByRole(index, ctx);
    return all.map((n) => withWildcard(withNotes(n, notes, nameOf), wildcard));
  })();

  const { extraNodes, ...unified } = buildUnifiedView(views, nodes, regionId);
  return {
    meta: { prefix, region, generatedFrom: 'terraform show -json', terraformVersion: plan.terraform_version },
    nodes: [...nodes, ...extraNodes],
    sources,
    views: { ...views, unified },
  };
}
