// plan と生成したモデルを比べて、網羅率を出す。
//   explained : ノードとして出た、またはノードの関連リソース・エッジの根拠として説明に使われたリソース
//   leaks     : plan で sensitive 指定されていた値が、モデルの中にそのまま入っていないか
const MIN_SECRET_LENGTH = 6;

function* walkModule(module) {
  if (!module) return;
  yield* module.resources ?? [];
  for (const child of module.child_modules ?? []) yield* walkModule(child);
}

/** JSON の値（キー名は除く）の文字列をすべて集める */
function jsonValues(node) {
  if (typeof node === 'string') return [node];
  if (node == null || typeof node !== 'object') return [];
  return Object.values(node).flatMap(jsonValues);
}

/** シークレットの値は JSON 文字列のことが多いので、中の値も1つずつ検査対象にする */
function stringLeaves(value) {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return [value, ...jsonValues(parsed)];
  } catch {
    // JSON でなければ文字列そのものだけ
  }
  return [value];
}

function sensitiveLeaves(values, mask) {
  if (mask === true) {
    if (typeof values === 'string') return stringLeaves(values);
    if (values != null && typeof values === 'object') return (JSON.stringify(values).match(/"[^"]{6,}"/g) ?? []).map((s) => s.slice(1, -1));
    return [];
  }
  if (mask == null || typeof mask !== 'object' || values == null || typeof values !== 'object') return [];
  return Object.keys(mask).flatMap((k) => sensitiveLeaves(values[k], mask[k]));
}

function secretsIn(plan) {
  // データソースで読んだシークレットなどは prior_state に入るので、そちらも見る
  const resources = [...walkModule(plan.planned_values?.root_module), ...walkModule(plan.prior_state?.values?.root_module)];
  const fromResources = resources.flatMap((r) => sensitiveLeaves(r.values, r.sensitive_values));
  const sensitiveVars = Object.entries(plan.configuration?.root_module?.variables ?? {}).filter(([, v]) => v.sensitive).map(([k]) => k);
  const fromVars = sensitiveVars.map((k) => plan.variables?.[k]?.value).filter((v) => typeof v === 'string');
  return [...new Set([...fromResources, ...fromVars])].filter((s) => s.length >= MIN_SECRET_LENGTH);
}

export function coverageOf(plan, model, modelText = JSON.stringify(model)) {
  const managed = [...walkModule(plan.planned_values?.root_module)].filter((r) => r.mode === 'managed');
  const nodeIds = new Set(model.nodes.map((n) => n.id));
  const views = Object.values(model.views);
  const explained = new Set([
    ...nodeIds,
    ...model.nodes.flatMap((n) => n.related ?? []),
    ...views.flatMap((v) => v.edges.flatMap((e) => (e.evidence ?? []).map((ev) => ev.address))),
  ]);
  const unexplained = managed
    .filter((r) => !explained.has(r.address))
    .reduce((acc, r) => acc.set(r.type, (acc.get(r.type) ?? 0) + 1), new Map());

  return {
    total: managed.length,
    nodes: managed.filter((r) => nodeIds.has(r.address)).length,
    explained: managed.filter((r) => explained.has(r.address)).length,
    unexplained: [...unexplained.entries()].sort((a, b) => b[1] - a[1]),
    edges: Object.fromEntries(Object.entries(model.views).map(([k, v]) => [k, v.edges.length])),
    inferred: model.views.data.edges.filter((e) => e.inferred).length,
    // 漏れていた値そのものは出さず、先頭3文字だけにする
    leaks: secretsIn(plan).filter((s) => modelText.includes(s)).map((s) => `${s.slice(0, 3)}…`),
  };
}

/** 正解の線（"A -> B" / "A <-> B"）とノードが、その視点に出ているか */
export function recallOf(model, expectations = {}) {
  return Object.entries(expectations).map(([view, { edges = [], nodes = [], absent = [] }]) => {
    const v = model.views[view] ?? { edges: [], nodes: [] };
    const has = (a, b) => v.edges.some((e) => e.source === a && e.target === b);
    const edgeChecks = edges.map((spec) => {
      const both = spec.includes('<->');
      const [a, b] = spec.split(both ? '<->' : '->').map((x) => x.trim());
      return { spec, ok: has(a, b) || (both && has(b, a)) };
    });
    const nodeChecks = nodes.map((id) => ({ spec: `node ${id}`, ok: v.nodes.includes(id) }));
    // 出てはいけない線（共有ロールによる掛け算の線など）
    const absentChecks = absent.map((spec) => {
      const [a, b] = spec.split('->').map((x) => x.trim());
      return { spec: `余計: ${spec}`, ok: !has(a, b) };
    });
    const checks = [...edgeChecks, ...nodeChecks, ...absentChecks];
    return { view, hit: checks.filter((c) => c.ok).length, total: checks.length, missing: checks.filter((c) => !c.ok).map((c) => c.spec) };
  });
}
