// NW 視点: 「どこに置かれていて」「どこからどこへ通信が許可されているか」
//   - 配置   : subnet を参照している属性から、リソースをサブネット層（Tier タグ）に入れる
//   - 通信   : SG ルールの「参照元 SG → 対象 SG」を、それぞれの SG を持つリソース同士の矢印にする
//   - 経路   : ルートテーブルの route を「サブネット層 → IGW / NAT」の矢印にする
import { refsOf, refsOfType, constOf, resourcesOfType, allRefsOf } from './plan.mjs';
import { CATALOG, INTERNET_ID, edge, mergeEdges } from './catalog.mjs';

function placementOf(resource) {
  return CATALOG[resource.type]?.placement ?? {};
}

/**
 * 配置の属性（"network_configuration.0.subnets" など）の先頭のキー配下にある参照を、種類で絞って集める。
 * モジュールでは同じ属性が dynamic ブロックで書かれていて決め打ちのパスでは見つからないことがあるので、
 * パスの末尾までは辿らず、先頭のキー配下をまとめて見る。
 */
function refsUnder(expressions, path, index, type) {
  const top = path.split('.')[0];
  return allRefsOf(expressions?.[top], index).filter((a) => index.get(a).type === type);
}

export function subnetsOf(resource, index) {
  const p = placementOf(resource);
  const direct = (p.subnets ?? []).flatMap((path) => refsUnder(resource.expressions, path, index, 'aws_subnet'));
  const viaGroup = p.subnetGroup
    ? refsOf(resource.expressions[p.subnetGroup[0]], index)
        .filter((g) => index.get(g).type === p.subnetGroup[1])
        .flatMap((g) => refsOf(index.get(g).expressions.subnet_ids, index))
    : [];
  const viaAttachments = p.attachments
    ? resourcesOfType(index, p.attachments[0])
        .filter((a) => refsOf(a.expressions[p.attachments[1]], index).includes(resource.address))
        .flatMap((a) => refsOf(a.expressions.subnet_id, index))
    : [];
  return [...new Set([...direct, ...viaGroup, ...viaAttachments])].filter((a) => index.get(a).type === 'aws_subnet');
}

export function securityGroupsOf(resource, index) {
  const p = placementOf(resource);
  const direct = (p.sgs ?? []).flatMap((path) => refsUnder(resource.expressions, path, index, 'aws_security_group'));
  const viaAttachments = p.attachments
    ? resourcesOfType(index, p.attachments[0])
        .filter((a) => refsOf(a.expressions[p.attachments[1]], index).includes(resource.address))
        .flatMap((a) => refsOf(a.expressions.security_groups, index))
    : [];
  return [...new Set([...direct, ...viaAttachments])].filter((a) => index.get(a).type === 'aws_security_group');
}

/** サブネットを Tier タグでまとめたグループ（タグが無ければサブネット単体） */
// サブネットの名前の末尾の AZ（private_1a、public-c、app_az1 など）。同じ役割の AZ 違いを1つの層にまとめるのに使う
const AZ_SUFFIX = /[_-](?:\d?[a-f]|az\d+)$/i;

function subnetGroupId(subnet, index) {
  const vpc = refsOfType(subnet.expressions.vpc_id, index, 'aws_vpc')[0] ?? 'novpc';
  const tier = subnet.values.tags?.Tier ?? subnet.name.replace(AZ_SUFFIX, '');
  return { id: `tier:${vpc}:${tier}`, vpc, tier };
}

/** IGW へのルートを持つルートテーブルに関連付いたサブネット = パブリックサブネット */
/**
 * サブネットが使うルートテーブル。
 *   1. 関連付けがルートテーブルを指していればそれ
 *   2. 関連付けが VPC（main_route_table_id）を指していれば、その VPC のデフォルトのルートテーブル
 *   3. 関連付けが無ければ、VPC のメインルートテーブル（aws_default_route_table）
 * @returns {Map<string, { table: string, via: string|null }>} サブネット → ルートテーブルと関連付け
 */
function subnetTables(index) {
  const defaultTableOf = new Map(
    resourcesOfType(index, 'aws_route_table')
      .flatMap((rt) => refsOfType(rt.expressions.default_route_table_id, index, 'aws_vpc').map((vpc) => [vpc, rt.address])),
  );
  const explicit = resourcesOfType(index, 'aws_route_table_association').flatMap((assoc) => {
    const table = refsOfType(assoc.expressions.route_table_id, index, 'aws_route_table')[0]
      ?? defaultTableOf.get(refsOfType(assoc.expressions.route_table_id, index, 'aws_vpc')[0]);
    return table ? refsOfType(assoc.expressions.subnet_id, index, 'aws_subnet').map((subnet) => [subnet, { table, via: assoc.address }]) : [];
  });
  const associated = new Set(explicit.map(([subnet]) => subnet));
  const implicit = resourcesOfType(index, 'aws_subnet')
    .filter((sn) => !associated.has(sn.address))
    .flatMap((sn) => {
      const table = defaultTableOf.get(refsOfType(sn.expressions.vpc_id, index, 'aws_vpc')[0]);
      return table ? [[sn.address, { table, via: null }]] : [];
    });
  return new Map([...explicit, ...implicit]);
}

/** IGW へのルートを持つルートテーブルを使うサブネット = パブリックサブネット */
function publicSubnets(index) {
  const routesToIgw = (table) => routesOf(index.get(table), index).some((route) => route.targets.some((t) => index.get(t).type === 'aws_internet_gateway'));
  return new Set([...subnetTables(index).entries()].filter(([, { table }]) => routesToIgw(table)).map(([subnet]) => subnet));
}

function buildGroups(index) {
  const subnets = resourcesOfType(index, 'aws_subnet');
  const isPublic = publicSubnets(index);
  const groups = subnets.reduce((acc, s) => {
    const { id, vpc, tier } = subnetGroupId(s, index);
    const info = {
      address: s.address,
      name: s.values.tags?.Name ?? s.name,
      cidr: s.values.cidr_block,
      az: s.values.availability_zone,
    };
    const prev = acc.get(id) ?? { id, vpc, tier, subnets: [], isPublic: false };
    return new Map(acc).set(id, { ...prev, isPublic: prev.isPublic || isPublic.has(s.address), subnets: [...prev.subnets, info] });
  }, new Map());
  const groupOfSubnet = new Map(subnets.map((s) => [s.address, subnetGroupId(s, index).id]));
  return { groups: [...groups.values()], groupOfSubnet };
}

function portLabel(protocol, from, to) {
  if (protocol === '-1' || protocol === 'all') return 'all';
  return from === to ? `${protocol}/${from}` : `${protocol}/${from}-${to}`;
}

/**
 * SG ルールが「SG からの許可」かどうか。モジュールでは CIDR のルールでも参照先に SG が出てくることがあるので、
 * plan の値が null と確定していれば SG からの許可ではないとみなす（未確定か、値があるときだけ SG を使う）
 */
function usesSgSource(rule, attr) {
  return rule.unknown?.[attr] === true || typeof rule.values[attr] === 'string';
}

/** SG ルールを { target SG, source SG | cidr, ポート } の形にそろえる */
function normalizeSgRules(index) {
  const ingressRules = resourcesOfType(index, 'aws_vpc_security_group_ingress_rule').map((r) => ({
    address: r.address,
    target: refsOfType(r.expressions.security_group_id, index, 'aws_security_group')[0],
    sourceSgs: usesSgSource(r, 'referenced_security_group_id') ? refsOfType(r.expressions.referenced_security_group_id, index, 'aws_security_group') : [],
    // for_each の each.value で書かれていると configuration に定数が無いので、plan の値を読む
    cidrs: [constOf(r.expressions.cidr_ipv4) ?? r.values.cidr_ipv4].filter((c) => typeof c === 'string'),
    port: portLabel(r.values.ip_protocol, r.values.from_port, r.values.to_port),
  }));
  const legacyRules = resourcesOfType(index, 'aws_security_group_rule')
    .filter((r) => r.values.type === 'ingress')
    .map((r) => ({
      address: r.address,
      target: refsOfType(r.expressions.security_group_id, index, 'aws_security_group')[0],
      sourceSgs: usesSgSource(r, 'source_security_group_id') ? refsOfType(r.expressions.source_security_group_id, index, 'aws_security_group') : [],
      cidrs: constOf(r.expressions.cidr_blocks) ?? (Array.isArray(r.values.cidr_blocks) ? r.values.cidr_blocks : []),
      port: portLabel(r.values.protocol, r.values.from_port, r.values.to_port),
    }));
  return [...ingressRules, ...legacyRules, ...inlineRules(index)].filter((r) => r.target);
}

/**
 * aws_security_group の中に書く ingress ブロック。plan の値に1件ずつ入るが、参照する SG の ID は unknown なので、
 * 「SG を参照しているエントリ」には ingress 全体が参照している SG を当てる。
 */
function inlineRules(index) {
  return resourcesOfType(index, 'aws_security_group').flatMap((sg) => {
    const entries = Array.isArray(sg.values.ingress) ? sg.values.ingress : [];
    const referenced = refsOfType(sg.expressions.ingress, index, 'aws_security_group').filter((a) => a !== sg.address);
    return entries.map((entry, i) => {
      const usesSg = sg.unknown.ingress?.[i]?.security_groups === true || (entry.security_groups ?? []).length > 0;
      return {
        address: sg.address,
        target: sg.address,
        sourceSgs: usesSg ? referenced : [],
        cidrs: (entry.cidr_blocks ?? []).filter((c) => typeof c === 'string'),
        port: portLabel(entry.protocol, entry.from_port, entry.to_port),
      };
    });
  });
}

/** "10.0.0.0/16" → [開始, 終了]（IPv4 のみ） */
function cidrRange(cidr) {
  const m = typeof cidr === 'string' && cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return null;
  const base = m.slice(1, 5).reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(m[5]));
  const start = base - (base % size);
  return [start, start + size - 1];
}

function contains(outer, inner) {
  const a = cidrRange(outer);
  const b = cidrRange(inner);
  return Boolean(a && b && a[0] <= b[0] && b[1] <= a[1]);
}

/**
 * SG ルールの CIDR を、図のどこからの通信かに置き換える。
 *   VPC の CIDR そのもの → VPC、サブネットの CIDR を含む → そのサブネット層、それ以外 → CIDR のノード
 */
function cidrSources(cidr, groups, index) {
  const vpcs = resourcesOfType(index, 'aws_vpc').filter((v) => v.values.cidr_block === cidr).map((v) => v.address);
  if (vpcs.length) return vpcs;
  const tiers = groups.filter((g) => g.subnets.some((s) => contains(cidr, s.cidr))).map((g) => g.id);
  return tiers.length ? tiers : [`cidr:${cidr}`];
}

/** VPC ごとの Internet Gateway（インターネットからの通信の入口） */
function igwOfVpc(index) {
  return new Map(resourcesOfType(index, 'aws_internet_gateway').map((igw) => [refsOfType(igw.expressions.vpc_id, index, 'aws_vpc')[0], igw.address]));
}

function sgEdges(index, nodeIds, entryOf, groups) {
  const members = [...nodeIds]
    .map((id) => index.get(id))
    .filter(Boolean)
    .flatMap((r) => securityGroupsOf(r, index).map((sg) => [sg, r.address]))
    .reduce((acc, [sg, addr]) => new Map(acc).set(sg, [...(acc.get(sg) ?? []), addr]), new Map());

  return normalizeSgRules(index).flatMap((rule) => {
    const evidence = [{ text: `SG ルール ${rule.port} を許可`, address: rule.address }];
    return (members.get(rule.target) ?? []).flatMap((target) => {
      // 0.0.0.0/0 からの許可は、実際の経路どおり Internet Gateway から入ってくる線にする
      const internet = entryOf(target) ?? INTERNET_ID;
      // モジュールでは「"self" なら自分の SG、そうでなければ指定の SG」と書かれ、参照先に自分も出てくるので、
      // 自分以外の候補があるときは自分を除く
      const others = rule.sourceSgs.filter((sg) => sg !== rule.target);
      const sourceSgs = others.length ? others : rule.sourceSgs;
      const fromSg = sourceSgs.flatMap((sg) => members.get(sg) ?? []).map((source) => ({ source, label: rule.port }));
      const fromCidr = rule.cidrs.flatMap((c) =>
        (c === '0.0.0.0/0' ? [internet] : cidrSources(c, groups, index)).map((source) => ({ source, label: rule.port })),
      );
      return [...fromSg, ...fromCidr]
        .filter(({ source }) => source !== target)
        .map(({ source, label }) => edge({ source, target, kind: 'sg', labels: [label], evidence }));
    });
  });
}

// network_interface_id は NAT インスタンス（EC2）の ENI。参照は aws_instance の primary_network_interface_id になる
const ROUTE_TARGET_KEYS = ['gateway_id', 'nat_gateway_id', 'transit_gateway_id', 'vpc_endpoint_id', 'egress_only_gateway_id', 'network_interface_id'];
const ROUTE_TARGET_TYPES = new Set(['aws_internet_gateway', 'aws_nat_gateway', 'aws_ec2_transit_gateway', 'aws_vpc_endpoint', 'aws_egress_only_internet_gateway', 'aws_instance', 'aws_network_interface']);

/**
 * ルートテーブルの経路。書き方が3通りあるのでそろえる。
 *   1. route ブロック（configuration で各 route がばらされている場合）
 *   2. route ブロック（「ブロックに見える属性」で、参照がまとめて1つの式になっている場合 → CIDR は planned_values から）
 *   3. 独立した aws_route リソース（terraform-aws-modules/vpc などはこちら）
 */
function routesOf(rt, index) {
  const expr = rt.expressions.route;
  const isTarget = (a) => ROUTE_TARGET_TYPES.has(index.get(a).type);
  const inline = Array.isArray(expr)
    ? expr.map((route) => ({ cidr: constOf(route.cidr_block), targets: ROUTE_TARGET_KEYS.flatMap((k) => refsOf(route[k], index)), via: rt.address }))
    : (() => {
        const cidrs = (rt.values.route ?? []).map((r) => r.cidr_block).filter(Boolean);
        const targets = refsOf(expr, index).filter(isTarget);
        return targets.length ? [{ cidr: cidrs.join(', ') || null, targets, via: rt.address }] : [];
      })();
  const standalone = resourcesOfType(index, 'aws_route')
    .filter((r) => refsOf(r.expressions.route_table_id, index).includes(rt.address))
    .map((r) => ({
      cidr: r.values.destination_cidr_block ?? r.values.destination_ipv6_cidr_block ?? null,
      targets: ROUTE_TARGET_KEYS.flatMap((k) => refsOf(r.expressions[k], index)).filter(isTarget),
      via: r.address,
    }));
  return [...inline, ...standalone].filter((route) => route.targets.length);
}

function routeEdges(index, groupOfSubnet, groupById) {
  const routesOfTable = new Map(resourcesOfType(index, 'aws_route_table').map((rt) => [rt.address, routesOf(rt, index)]));
  // NAT Gateway と、NAT インスタンス（送信元/送信先チェックを外した EC2）
  const nats = [...resourcesOfType(index, 'aws_nat_gateway'), ...resourcesOfType(index, 'aws_instance').filter((i) => i.values.source_dest_check === false)];
  const natsIn = (group) =>
    nats.filter((nat) => refsOf(nat.expressions.subnet_id, index).some((s) => groupOfSubnet.get(s) === group)).map((nat) => nat.address);
  const fromSubnets = [...subnetTables(index).entries()].flatMap(([subnet, { table, via }]) => {
    const group = groupOfSubnet.get(subnet);
    if (!group) return [];
    return (routesOfTable.get(table) ?? []).flatMap((route) =>
      route.targets.flatMap((target) => {
        // パブリックサブネットから IGW へ外向きに出ていくのは NAT Gateway なので、NAT → IGW として描く
        const isIgw = index.get(target).type === 'aws_internet_gateway';
        const sources = isIgw && groupById.get(group)?.isPublic ? natsIn(group) : [group];
        return sources.map((source) =>
          edge({
            source,
            target,
            kind: 'route',
            labels: [route.cidr ?? 'route'],
            evidence: [
              { text: `${route.cidr} の経路`, address: route.via },
              ...(route.via !== table ? [{ text: 'ルートテーブル', address: table }] : []),
              via ? { text: 'サブネットに関連付け', address: via } : { text: '関連付けが無いので VPC のメインルートテーブル', address: table },
            ],
          }),
        );
      }),
    );
  });
  const igwToInternet = resourcesOfType(index, 'aws_internet_gateway').map((igw) =>
    edge({ source: INTERNET_ID, target: igw.address, kind: 'route', labels: [], bidirectional: true, evidence: [{ text: 'Internet Gateway', address: igw.address }] }),
  );
  return [...fromSubnets, ...igwToInternet];
}

/**
 * @param {Map<string, object>} index
 * @param {Set<string>} nodeIds 図に出すリソースのアドレス
 */
export function buildNetworkView(index, nodeIds, regionId) {
  const { groups, groupOfSubnet } = buildGroups(index);
  const igws = igwOfVpc(index);
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const placed = [...nodeIds]
    .map((id) => index.get(id))
    .map((r) => {
      const groupIds = [...new Set(subnetsOf(r, index).map((s) => groupOfSubnet.get(s)))].filter(Boolean);
      if (groupIds.length === 1) return [r.address, groupIds[0]];
      if (groupIds.length > 1) return [r.address, groups.find((g) => g.id === groupIds[0]).vpc];
      // サブネットを持たないが VPC に属するもの（IGW、ゲートウェイ型の VPC エンドポイントなど）は VPC の枠に入れる。
      // サブネットの指定は無いが SG は付いているものは、SG が属する VPC に入れる
      if (r.type === 'aws_vpc') return [r.address, null];
      const vpcOf = (x) => refsOfType(x.expressions.vpc_id, index, 'aws_vpc')[0];
      const vpc = vpcOf(r) ?? securityGroupsOf(r, index).map((sg) => vpcOf(index.get(sg))).find(Boolean);
      return [r.address, vpc ?? null];
    })
    .filter(([, parent]) => parent !== null);

  const vpcIds = [...nodeIds].filter((id) => index.get(id)?.type === 'aws_vpc');
  const parents = Object.fromEntries([...placed, ...groups.map((g) => [g.id, g.vpc]), ...vpcIds.map((v) => [v, regionId])]);
  const inView = new Set([regionId, ...vpcIds, ...groups.map((g) => g.id), ...placed.map(([id]) => id)]);

  const placedIn = new Map(placed);
  const entryOf = (target) => {
    const group = groupById.get(placedIn.get(target));
    return group?.isPublic ? igws.get(group.vpc) : undefined;
  };
  const allEdges = mergeEdges([...sgEdges(index, inView, entryOf, groups), ...routeEdges(index, groupOfSubnet, groupById)]);
  // 「VPC 全体から許可」のように、枠（VPC・サブネット層）から自分の中のリソースへの線は図にすると読めないので、
  // 線にはせずリソースの注記（受け付ける通信）にする
  const isAncestor = (a, b) => {
    for (let cur = parents[b]; cur; cur = parents[cur]) if (cur === a) return true;
    return false;
  };
  const edges = allEdges.filter((e) => !(e.kind === 'sg' && isAncestor(e.source, e.target)));
  const notes = allEdges
    .filter((e) => e.kind === 'sg' && isAncestor(e.source, e.target))
    .reduce((acc, e) => ({ ...acc, [e.target]: [...(acc[e.target] ?? []), { from: e.source, label: e.label }] }), {});
  const endpoints = edges.flatMap((e) => [e.source, e.target]);
  const extraNodes = endpoints.filter((id) => !inView.has(id));

  const groupNodes = groups.map((g) => ({
    id: g.id,
    type: g.isPublic ? 'public-subnet' : 'private-subnet',
    kind: g.isPublic ? 'Public subnet' : 'Private subnet',
    name: g.tier,
    category: 'group',
    summary: g.subnets.map((s) => s.az?.slice(-2)).join(' / '),
    attrs: { subnets: g.subnets },
    settings: [],
    address: null,
  }));

  return {
    groupNodes,
    notes,
    view: {
      nodes: [...new Set([...inView, ...extraNodes])],
      parents,
      edges,
    },
  };
}
