// IAM 視点: 「誰が（どのロールで）何に対して何をできるか」
//   - リソース → ロール     : Lambda の role、ECS タスク定義の task_role_arn など（ロールを使う側）
//   - ロール → リソース     : ロールに付いたポリシー（インライン、アタッチ、inline_policy、AWS 管理ポリシー）
//   - リソースベースポリシー : Lambda の実行許可、SQS / SNS / S3 のポリシー（誰から呼ばれてよいか）
import { refsOf, refsOfType, resourcesOfType, valueAt, withManagedTwins, UNKNOWN } from './plan.mjs';
import { edge, mergeEdges, actionLabel, isNodeResource } from './catalog.mjs';
import { statementsOf, inlinePoliciesOf, managedPolicyName, policyContext } from './policy.mjs';
import { resourcesForArn } from './arn.mjs';

// ロールを使う側の属性。キーは属性名、値は詳細パネルでの呼び方
const ROLE_ATTRIBUTES = Object.freeze({
  role: '実行ロール',
  role_arn: 'サービスロール',
  service_role: 'サービスロール',
  iam_role_arn: 'サービスロール',
  execution_role_arn: '実行ロール',
});

// Resource: "*" でも図に出す意味が薄い操作（ログ出力や ENI の作成など、どの関数にも付くもの）
const NOISE_ACTION = /^(logs|xray|cloudwatch|ec2|sts):|^ecr:GetAuthorizationToken$/;

/** @returns {Array<{ compute: string, role: string, as: string, evidence: string }>} */
export function roleBindings(index) {
  const direct = [...index.values()].filter(isNodeResource).flatMap((r) =>
    Object.entries(ROLE_ATTRIBUTES).flatMap(([attr, as]) =>
      refsOfType(r.expressions[attr], index, 'aws_iam_role').map((role) => ({ compute: r.address, role, as, evidence: r.address })),
    ),
  );
  const ecs = resourcesOfType(index, 'aws_ecs_service').flatMap((svc) =>
    withManagedTwins(refsOfType(svc.expressions.task_definition, index, 'aws_ecs_task_definition'), index).flatMap((td) => {
      const def = index.get(td).expressions;
      return [
        ...refsOfType(def.task_role_arn, index, 'aws_iam_role').map((role) => ({ compute: svc.address, role, as: 'タスクロール', evidence: td })),
        ...refsOfType(def.execution_role_arn, index, 'aws_iam_role').map((role) => ({ compute: svc.address, role, as: 'タスク実行ロール', evidence: td })),
      ];
    }),
  );
  const ec2 = resourcesOfType(index, 'aws_instance').flatMap((inst) =>
    refsOfType(inst.expressions.iam_instance_profile, index, 'aws_iam_instance_profile').flatMap((ip) =>
      refsOfType(index.get(ip).expressions.role, index, 'aws_iam_role').map((role) => ({ compute: inst.address, role, as: 'インスタンスプロファイル', evidence: ip })),
    ),
  );
  // Scheduler はターゲットごとにロールを持つ（target.role_arn）
  const scheduler = resourcesOfType(index, 'aws_scheduler_schedule').flatMap((s) =>
    refsOfType(s.expressions.target?.[0]?.role_arn, index, 'aws_iam_role').map((role) => ({ compute: s.address, role, as: 'サービスロール', evidence: s.address })),
  );
  return [...direct, ...ecs, ...ec2, ...scheduler];
}

/** ロールに付いているポリシーを、出どころ（根拠）付きで集める */
function policiesOfRole(role, index, ctx) {
  const attachedTo = (type, attr) => resourcesOfType(index, type).filter((x) => refsOfType(x.expressions[attr], index, 'aws_iam_role').includes(role.address));
  const inline = attachedTo('aws_iam_role_policy', 'role').map((rp) => ({ statements: statementsOf(rp, 'policy', ctx), evidence: { text: 'インラインポリシー', address: rp.address } }));
  const attached = [...attachedTo('aws_iam_role_policy_attachment', 'role'), ...attachedTo('aws_iam_policy_attachment', 'roles')].flatMap((att) => {
    const custom = refsOfType(att.expressions.policy_arn, index, 'aws_iam_policy').map((p) => ({
      statements: statementsOf(index.get(p), 'policy', ctx),
      evidence: { text: 'アタッチしたポリシー', address: p },
    }));
    const managedByData = refsOfType(att.expressions.policy_arn, index, 'aws_iam_policy').length ? [] : refsOf(att.expressions.policy_arn, index).map((d) => index.get(d)).filter((d) => d.mode === 'data');
    const managedArn = valueAt(att, 'policy_arn');
    const managedNames = [
      ...managedByData.map((d) => d.values.name ?? managedPolicyName(d.values.arn)),
      ...(managedArn !== UNKNOWN ? [managedPolicyName(managedArn)] : []),
    ].filter(Boolean);
    return [...custom, ...managedNames.map((name) => ({ managed: name, evidence: { text: 'AWS 管理ポリシーをアタッチ', address: att.address } }))];
  });
  const roleInline = { statements: inlinePoliciesOf(role, ctx), evidence: { text: 'ロールの inline_policy', address: role.address } };
  const roleManaged = (role.values.managed_policy_arns ?? []).map(managedPolicyName).filter(Boolean).map((name) => ({ managed: name, evidence: { text: 'managed_policy_arns', address: role.address } }));
  return [...inline, ...attached, roleInline, ...roleManaged];
}

/**
 * ロールに付いている権限を「ロール → 対象」の単位に並べる
 * @returns {Array<{ role: string, target: string, actions: string[], evidence: object[], estimated?: boolean }>}
 */
export function rolePermissions(index, ctx = policyContext(index)) {
  return resourcesOfType(index, 'aws_iam_role').flatMap((role) =>
    policiesOfRole(role, index, ctx).flatMap((p) => {
      if (p.managed) return [{ role: role.address, target: `managed:${p.managed}`, actions: [], evidence: [p.evidence] }];
      return p.statements.flatMap((st) => {
        const evidence = [p.evidence, ...(st.source !== p.evidence.address ? [{ text: 'ポリシーの中身', address: st.source }] : [])];
        const meaningfulWildcard = st.wildcard && st.actions.some((a) => !NOISE_ACTION.test(a));
        const targets = [...st.resources, ...(meaningfulWildcard ? ['any:*'] : [])];
        return targets.map((target) => ({ role: role.address, target, actions: st.actions, evidence, estimated: st.estimated }));
      });
    }),
  );
}

/**
 * リソースベースポリシー: 誰（caller）が、どのリソース（owner）を呼んでよいか
 * @returns {Array<{ owner: string, callers: string[], actions: string[], principals: string[], evidence: object[] }>}
 */
export function resourcePolicies(index, ctx = policyContext(index)) {
  const lambdaPermissions = resourcesOfType(index, 'aws_lambda_permission').flatMap((perm) => {
    const owner = refsOfType(perm.expressions.function_name, index, 'aws_lambda_function')[0];
    if (!owner) return [];
    const sourceArn = valueAt(perm, 'source_arn');
    const callers = [
      ...refsOf(perm.expressions.source_arn, index).filter((a) => isNodeResource(index.get(a))),
      ...(typeof sourceArn === 'string' ? resourcesForArn(sourceArn, ctx.candidates) : []),
    ];
    return [{ owner, callers: [...new Set(callers)], actions: [perm.values.action ?? 'lambda:InvokeFunction'], principals: [perm.values.principal].filter(Boolean), evidence: [{ text: 'Lambda の実行許可', address: perm.address }] }];
  });
  const policyResources = [
    ['aws_sqs_queue_policy', 'queue_url', 'aws_sqs_queue'],
    ['aws_sns_topic_policy', 'arn', 'aws_sns_topic'],
    ['aws_s3_bucket_policy', 'bucket', 'aws_s3_bucket'],
  ].flatMap(([type, ownerAttr, ownerType]) =>
    resourcesOfType(index, type).flatMap((p) => {
      const owner = refsOfType(p.expressions[ownerAttr], index, ownerType)[0];
      if (!owner) return [];
      return statementsOf(p, 'policy', ctx).map((st) => ({
        owner,
        // 値が確定しない JSON の場合は、ポリシーが参照している自分以外のリソースを呼び出し元とみなす
        callers: st.sourceArns.length ? st.sourceArns : st.estimated ? st.resources.filter((a) => a !== owner) : [],
        actions: st.actions,
        principals: st.principals,
        evidence: [{ text: 'リソースベースポリシー', address: p.address }, ...(st.source !== p.address ? [{ text: 'ポリシーの中身', address: st.source }] : [])],
      }));
    }),
  );
  return [...lambdaPermissions, ...policyResources];
}

/** ロールごとの Resource: "*" に対する操作（図では線にせず、ロールの警告として出す） */
export function wildcardActionsByRole(index, ctx = policyContext(index)) {
  return rolePermissions(index, ctx)
    .filter((p) => p.target === 'any:*')
    .reduce((acc, p) => acc.set(p.role, [...new Set([...(acc.get(p.role) ?? []), ...p.actions])]), new Map());
}

/** ロールを信頼している（AssumeRole できる）サービス */
export function trustedBy(role, index, ctx = policyContext(index)) {
  return [...new Set(statementsOf(role, 'assume_role_policy', ctx).flatMap((st) => st.principals))];
}

export function buildIamView(index, nodeIds, ctx = policyContext(index)) {
  const bindings = roleBindings(index).map((b) =>
    edge({ source: b.compute, target: b.role, kind: 'assume', labels: [b.as], evidence: [{ text: `${b.as}として指定`, address: b.evidence }] }),
  );
  const permissions = rolePermissions(index, ctx)
    .filter((p) => nodeIds.has(p.target) || p.target.startsWith('managed:'))
    .map((p) =>
      edge({
        source: p.role,
        target: p.target,
        kind: p.target.startsWith('managed:') ? 'managed' : 'allow',
        labels: [p.target.startsWith('managed:') ? 'AWS 管理ポリシー' : p.actions.length ? actionLabel(p.actions) : '（actions 不明）'],
        actions: p.actions,
        evidence: p.evidence,
        inferred: Boolean(p.estimated),
      }),
    );
  const resourcePolicyEdges = resourcePolicies(index, ctx).flatMap((rp) => {
    const callers = rp.callers.length ? rp.callers : rp.principals.filter((pr) => pr !== '*').map((pr) => `principal:${pr}`);
    return callers.map((caller) =>
      edge({ source: caller, target: rp.owner, kind: 'resource-policy', labels: [actionLabel(rp.actions)], actions: rp.actions, evidence: rp.evidence }),
    );
  });
  const edges = mergeEdges([...bindings, ...permissions, ...resourcePolicyEdges]);
  return {
    nodes: [...new Set(edges.flatMap((e) => [e.source, e.target]))],
    parents: {},
    edges,
  };
}
