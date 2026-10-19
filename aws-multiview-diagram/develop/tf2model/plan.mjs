// terraform show -json の結果を、リソースのアドレスで引ける形に整える。
//
// plan 時点では ARN や ID は未確定（unknown）なので、リソース同士の関係は planned_values ではなく
// configuration 側の references から辿る。references はモジュールの中では相対的な書き方
// （var.x / module.m.out / local.x）なので、次のように辿って「最終的にどのリソースか」まで解決する。
//   var.x        → 呼び出し元の module ブロックに渡された式
//   module.m.out → 子モジュールの output の式
//   local.x      → .tf の locals ブロック（configuration に中身が無いのでソースから読む）
// count / for_each で増えたリソースは、planned_values のインスタンス（aws_subnet.private[0] など）を1つずつ扱う。

/**
 * @typedef {{ address: string, blockKey: string, modulePath: string, type: string, name: string, mode: string,
 *   expressions: object, values: object, unknown: object }} Resource
 */

const SENSITIVE = '(sensitive)';

// 旧名・同じ形の別リソースは、同じ種類として扱う（aws_alb は aws_lb の旧名、デフォルトのルートテーブルも route の形は同じ）
export const TYPE_ALIASES = Object.freeze({
  aws_alb: 'aws_lb',
  aws_alb_listener: 'aws_lb_listener',
  aws_alb_listener_rule: 'aws_lb_listener_rule',
  aws_alb_target_group: 'aws_lb_target_group',
  aws_alb_target_group_attachment: 'aws_lb_target_group_attachment',
  aws_default_route_table: 'aws_route_table',
});
const NON_RESOURCE_ROOTS = new Set(['each', 'count', 'path', 'self', 'terraform']);

/** インスタンスのアドレスから、count / for_each のキーを落としたブロックのアドレス */
export function stripIndex(address) {
  return address.replace(/\[[^\]]*\]/g, '');
}

function sensitiveLeaves(values, mask) {
  if (mask === true) return typeof values === 'string' ? [values] : [];
  if (mask == null || typeof mask !== 'object' || values == null || typeof values !== 'object') return [];
  return Object.keys(mask).flatMap((k) => sensitiveLeaves(values[k], mask[k]));
}

function walkResources(mod) {
  return mod ? [...(mod.resources ?? []), ...(mod.child_modules ?? []).flatMap(walkResources)] : [];
}

/** plan で sensitive になっている文字列（コード片に直書きされていたら伏せるため） */
export function sensitiveStrings(plan) {
  const fromPlanned = walkResources(plan.planned_values?.root_module).flatMap((r) => sensitiveLeaves(r.values, r.sensitive_values));
  const fromChanges = (plan.resource_changes ?? []).flatMap((c) => sensitiveLeaves(c.change?.after, c.change?.after_sensitive));
  return [...new Set([...fromPlanned, ...fromChanges])].filter(Boolean);
}

/** sensitive_values / after_sensitive で true になっている値を伏せる */
function redact(values, mask) {
  if (mask === true) return SENSITIVE;
  if (mask == null || mask === false || values == null || typeof values !== 'object') return values;
  if (Array.isArray(values)) return values.map((v, i) => redact(v, Array.isArray(mask) ? mask[i] : undefined));
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, redact(v, mask[k])]));
}

function* walkModule(module) {
  if (!module) return;
  yield* module.resources ?? [];
  for (const child of module.child_modules ?? []) yield* walkModule(child);
}

/** 式の中の references をすべて集める（ネストしたブロックを含む） */
function referencesIn(expr) {
  if (expr == null || typeof expr !== 'object') return [];
  const own = Array.isArray(expr.references) ? expr.references : [];
  const nested = Object.entries(expr)
    .filter(([k]) => k !== 'references' && k !== 'constant_value')
    .flatMap(([, v]) => referencesIn(v));
  return [...own, ...nested];
}

/** ["module.vpc.private_subnets", "module.vpc"] のように、より詳しい参照があるときは粗い方を捨てる */
function specificRefs(refs) {
  const unique = [...new Set(refs)];
  return unique.filter((r) => !unique.some((o) => o !== r && (o.startsWith(`${r}.`) || o.startsWith(`${r}[`))));
}

function buildScopes(rootConfig) {
  const scopes = [];
  const visit = (config, path, parent, call) => {
    const scope = { path, config, parent, call, children: new Map() };
    scopes.push(scope);
    Object.entries(config.module_calls ?? {}).forEach(([name, mc]) => {
      const child = visit(mc.module ?? {}, path ? `${path}.module.${name}` : `module.${name}`, scope, mc);
      scope.children.set(name, child);
    });
    return scope;
  };
  visit(rootConfig, '', null, null);
  return scopes;
}

function createResolver(scopes, blockKeys, locals, moduleMapArgs = {}) {
  const memo = new Map();

  function resolveRef(ref, scope, seen) {
    const memoKey = `${scope.path}|${ref}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    if (seen.has(memoKey)) return [];
    const nextSeen = new Set(seen).add(memoKey);
    const t = stripIndex(ref).split('.');
    const prefix = scope.path ? `${scope.path}.` : '';
    const viaRefs = (refs, inScope) => specificRefs(refs).flatMap((r) => resolveRef(r, inScope, nextSeen));

    let result = [];
    if (t[0] === 'var') {
      // var.x.key は、呼び出し元で x = { key = ... } と書かれていれば、そのキーの参照だけを使う
      // （plan JSON ではオブジェクトの参照がキーごとに分かれず、全部まとめて並ぶため）
      const keyed = t[2] ? moduleMapArgs[scope.path]?.[t[1]]?.[t[2]] : undefined;
      result = scope.call ? viaRefs(keyed ?? referencesIn(scope.call.expressions?.[t[1]]), scope.parent) : [];
    } else if (t[0] === 'local') {
      result = viaRefs(locals[scope.path]?.[t[1]] ?? [], scope);
    } else if (t[0] === 'module') {
      const child = scope.children.get(t[1]);
      const outputs = child?.config.outputs ?? {};
      const names = t[2] ? [t[2]] : Object.keys(outputs);
      result = child ? names.flatMap((n) => viaRefs(referencesIn(outputs[n]?.expression), child)) : [];
    } else if (t[0] === 'data' && t.length >= 3) {
      result = [`${prefix}data.${t[1]}.${t[2]}`].filter((k) => blockKeys.has(k));
    } else if (!NON_RESOURCE_ROOTS.has(t[0]) && t.length >= 2) {
      result = [`${prefix}${t[0]}.${t[1]}`].filter((k) => blockKeys.has(k));
    }
    const unique = [...new Set(result)];
    memo.set(memoKey, unique);
    return unique;
  }

  return (refs, scope) => [...new Set(specificRefs(refs).flatMap((r) => resolveRef(r, scope, new Set())))];
}

/**
 * 式の木をたどり、references がある所に resolved（解決済みのブロックのアドレス）を付ける。
 * for_each で作るリソースの each.value / each.key は、for_each に渡した式の参照を引き継ぐ
 * （モジュールの SG ルールなどは for_each = var.rules と each.value.xxx で書かれていることが多い）。
 */
function annotate(expr, scope, resolve, eachBlocks = []) {
  if (Array.isArray(expr)) return expr.map((e) => annotate(e, scope, resolve, eachBlocks));
  if (expr == null || typeof expr !== 'object') return expr;
  const entries = Object.entries(expr).map(([k, v]) => [k, k === 'references' || k === 'constant_value' ? v : annotate(v, scope, resolve, eachBlocks)]);
  if (!Array.isArray(expr.references)) return Object.fromEntries(entries);
  const usesEach = expr.references.some((r) => r.startsWith('each.'));
  const own = resolve(expr.references, scope);
  return { ...Object.fromEntries(entries), resolvedBlocks: usesEach ? [...new Set([...own, ...eachBlocks])] : own };
}

/** for_each の式から、たどり着く var の名前（local を経由していれば locals の中も見る） */
function varNamesOf(refs, scope, locals, seen = new Set()) {
  return refs.flatMap((r) => {
    const [root, name] = stripIndex(r).split('.');
    if (root === 'var') return [name];
    if (root !== 'local' || seen.has(name)) return [];
    return varNamesOf(locals[scope.path]?.[name] ?? [], scope, locals, new Set(seen).add(name));
  });
}

/** インスタンスのアドレスの末尾のキー（aws_x.y["rds"] → "rds"） */
function instanceKey(address) {
  const m = address.match(/\[(?:"([^"]+)"|(\d+))\]$/);
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * each.value が指すリソース。モジュールに「キーごとの設定を並べた map」が渡されていて、
 * そのキーの分の参照が分かれば、それだけを使う（分からなければ for_each の式全体の参照）。
 */
function eachBlocksFor(cfg, scope, key, resolve, locals, moduleMapArgs) {
  const forEachRefs = referencesIn(cfg.for_each_expression);
  if (forEachRefs.length === 0) return [];
  const args = moduleMapArgs[scope.path] ?? {};
  const entryRefs = key == null ? [] : [...new Set(varNamesOf(forEachRefs, scope, locals))].flatMap((v) => args[v]?.[key] ?? []);
  return entryRefs.length && scope.parent ? resolve(entryRefs, scope.parent) : resolve(forEachRefs, scope);
}

/**
 * @param {object} plan terraform show -json の出力
 * @param {{ locals?: Record<string, Record<string, string[]>>, dynamics?: Record<string, object>, moduleMapArgs?: object }} [options]
 *   scanStack() で読んだ locals、dynamic ブロックの参照、モジュールに渡した map のキーごとの参照
 * @returns {Map<string, Resource>}
 */
export function indexPlan(plan, { locals = {}, dynamics = {}, moduleMapArgs = {} } = {}) {
  const rootConfig = plan?.configuration?.root_module;
  if (!rootConfig || typeof rootConfig !== 'object') {
    throw new Error('configuration.root_module が見つかりません。terraform show -json の出力を渡してください');
  }

  const changes = new Map((plan.resource_changes ?? []).map((r) => [r.address, r]));
  const fromValues = [...walkModule(plan.prior_state?.values?.root_module), ...walkModule(plan.planned_values?.root_module)];
  const fromChanges = [...changes.values()].map((c) => ({ ...c, values: c.change?.after ?? {}, sensitive_values: c.change?.after_sensitive }));
  // 同じアドレスは planned_values を優先する（後勝ち）。plan で読めたデータソースは prior_state にだけある
  const instances = new Map([...fromChanges, ...fromValues].filter((r) => r.address && r.type).map((r) => [r.address, r]));

  const scopes = buildScopes(rootConfig);
  const blocks = new Map(
    scopes.flatMap((scope) => (scope.config.resources ?? []).map((cfg) => [scope.path ? `${scope.path}.${cfg.address}` : cfg.address, { cfg, scope }])),
  );
  const instancesByBlock = [...instances.keys()].reduce(
    (acc, addr) => acc.set(stripIndex(addr), [...(acc.get(stripIndex(addr)) ?? []), addr]),
    new Map(),
  );
  const resolve = createResolver(scopes, new Set(instancesByBlock.keys()), locals, moduleMapArgs);
  const toInstances = (blockKeys) => blockKeys.flatMap((k) => instancesByBlock.get(k) ?? []);

  // 式の解決はブロック単位。ただし for_each のインスタンスはキーごとに each.value の指す先が違うので分ける
  const annotatedCache = new Map();
  const annotatedFor = (blockKey, key) => {
    const cacheKey = `${blockKey}|${key ?? ''}`;
    if (annotatedCache.has(cacheKey)) return annotatedCache.get(cacheKey);
    const block = blocks.get(blockKey);
    if (!block) return null;
    const { cfg, scope } = block;
    const eachBlocks = eachBlocksFor(cfg, scope, key, resolve, locals, moduleMapArgs);
    const expressions = withDynamics(cfg.expressions ?? {}, dynamics[blockKey]);
    const result = { scope, expressions: withInstances(annotate(expressions, scope, resolve, eachBlocks), toInstances) };
    annotatedCache.set(cacheKey, result);
    return result;
  };

  const index = new Map(
    [...instances.values()].map((r) => {
      const blockKey = stripIndex(r.address);
      const block = annotatedFor(blockKey, blocks.get(blockKey)?.cfg.for_each_expression ? instanceKey(r.address) : null);
      const sensitiveMask = r.sensitive_values ?? changes.get(r.address)?.change?.after_sensitive;
      return [
        r.address,
        Object.freeze({
          address: r.address,
          blockKey,
          modulePath: block?.scope.path ?? (r.module_address ?? ''),
          type: TYPE_ALIASES[r.type] ?? r.type,
          name: r.name,
          mode: r.mode,
          expressions: block?.expressions ?? {},
          values: redact(r.values ?? {}, sensitiveMask),
          unknown: changes.get(r.address)?.change?.after_unknown ?? {},
        }),
      ];
    }),
  );
  return withServiceUsage(index);
}

/**
 * ECS のタスク定義に「サービスが使っているか」を付ける。サービスが使うものはサービスの中身として扱い、
 * 使われていないもの（バッチ、マイグレーションなど Scheduler や Step Functions から単発で起動するタスク）だけを図のノードにする
 */
function withServiceUsage(index) {
  const used = new Set(
    resourcesOfType(index, 'aws_ecs_service').flatMap((svc) => withManagedTwins(refsOfType(svc.expressions.task_definition, index, 'aws_ecs_task_definition'), index)),
  );
  return new Map(
    [...index.entries()].map(([address, r]) =>
      r.type === 'aws_ecs_task_definition' && r.mode === 'managed' ? [address, Object.freeze({ ...r, usedByService: used.has(address) })] : [address, r],
    ),
  );
}

/**
 * dynamic ブロックは configuration に中身が出ないので、ソースから読んだ参照を同じ名前のブロックとして足す。
 * 中の属性名までは分からないので { dynamic: { references } } の形で入れる（allRefsOf で拾える）。
 */
function withDynamics(expressions, dynamicRefs = {}) {
  const extra = Object.entries(dynamicRefs)
    .filter(([name, refs]) => refs.length && expressions[name] === undefined)
    .map(([name, refs]) => [name, [{ dynamic: { references: refs } }]]);
  return extra.length ? { ...expressions, ...Object.fromEntries(extra) } : expressions;
}

/** resolvedBlocks（ブロック単位）を、インスタンスのアドレスの resolved に変換する */
function withInstances(expr, toInstances) {
  if (Array.isArray(expr)) return expr.map((e) => withInstances(e, toInstances));
  if (expr == null || typeof expr !== 'object') return expr;
  const { resolvedBlocks, ...rest } = expr;
  const mapped = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, k === 'references' || k === 'constant_value' ? v : withInstances(v, toInstances)]));
  return resolvedBlocks ? { ...mapped, resolved: toInstances(resolvedBlocks) } : mapped;
}

/** "a.0.b" のようなパスで expressions を辿る（ネストしたブロックは配列になっている） */
export function exprAt(expressions, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), expressions);
}

/** 参照文字列をリソースアドレスに正規化する（属性やインデックスを落とす）。resolved が無い式のための互換処理 */
export function toAddress(ref) {
  const parts = stripIndex(ref).split('.');
  return parts[0] === 'data' ? parts.slice(0, 3).join('.') : parts.slice(0, 2).join('.');
}

/** 式が参照しているリソースのうち、指定した種類のもの（output が複数のリソースを指すことがあるので種類で絞る） */
export function refsOfType(expr, index, ...types) {
  return refsOf(expr, index).filter((a) => types.includes(index.get(a).type));
}

/** 1つの式が参照している、index に存在するリソースのアドレス一覧 */
export function refsOf(expr, index) {
  if (Array.isArray(expr?.resolved)) return expr.resolved.filter((a) => index.has(a));
  const refs = expr?.references ?? [];
  return [...new Set(refs.map(toAddress))].filter((a) => index.has(a));
}

/** 式の中（ネストしたブロックを含む）にある参照をすべて集める */
export function allRefsOf(expr, index) {
  if (expr == null || typeof expr !== 'object') return [];
  const own = Array.isArray(expr.resolved) || Array.isArray(expr.references) ? refsOf(expr, index) : [];
  const nested = Object.entries(expr)
    .filter(([key]) => !['references', 'constant_value', 'resolved'].includes(key))
    .flatMap(([, value]) => allRefsOf(value, index));
  return [...new Set([...own, ...nested])];
}

export function constOf(expr) {
  return expr?.constant_value;
}

// データソースで「同じスタックで作っているリソースの最新版」を引く書き方（GitHub Actions でデプロイするタスク定義など）。
// データソースの検索キー → 本体のリソースの名前の属性
const DATA_LOOKUP = Object.freeze({
  aws_ecs_task_definition: ['task_definition', 'family'],
  aws_batch_job_definition: ['name', 'name'],
});

/** アドレスのうち、データソースを同じ名前の本体のリソースに置き換える（見つからなければそのまま） */
export function withManagedTwins(addresses, index) {
  return [...new Set(addresses.flatMap((a) => {
    const r = index.get(a);
    const lookup = r?.mode === 'data' ? DATA_LOOKUP[r.type] : null;
    if (!lookup) return [a];
    const key = r.values?.[lookup[0]];
    const twins = resourcesOfType(index, r.type).filter((m) => typeof key === 'string' && m.values?.[lookup[1]] === key).map((m) => m.address);
    return twins.length ? twins : [a];
  }))];
}

export function resourcesOfType(index, type, mode = 'managed') {
  return [...index.values()].filter((r) => r.type === type && r.mode === mode);
}

/** address を参照している、指定した種類のリソース（バケットに付いている暗号化設定など） */
export function referencing(index, address, type) {
  return resourcesOfType(index, type).filter((r) => allRefsOf(r.expressions, index).includes(address));
}

export const UNKNOWN = Symbol('unknown');

/** planned_values から値を取る。apply まで決まらない値は UNKNOWN を返す */
export function valueAt(resource, path) {
  const keys = path.split('.');
  const pick = (obj) => keys.reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
  if (pick(resource.unknown) === true) return UNKNOWN;
  return pick(resource.values);
}
