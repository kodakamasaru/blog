// データフロー視点: 「データがどこからどこへ流れるか」
//
// IaC にはアプリのコードが書かれていないので、データフローは完全には分からない。そこで2段構えにする。
//   1. 明示的な流れ : IaC に配線が書かれているもの（wiring.mjs）
//   2. 推定した流れ : 「IAM で特定のリソースへの読み書きが許可されている」もの
//                     （許可されていてアクセスできる状態なら、データは流れうるとみなす）
//                     加えて「接続先を知っている（環境変数などで参照している）」かつ「SG で通信が許可されている」もの
//      向きは IAM の action の動詞（Get / Put など）から決める。
//      根拠の強さは「接続先を参照している（参照あり）」か「IAM の許可だけ（IAM のみ）」かで区別する。
import { refsOf, refsOfType, resourcesOfType, allRefsOf, valueAt, UNKNOWN } from './plan.mjs';
import { INTERNET_ID, edge, mergeEdges, actionLabel } from './catalog.mjs';
import { roleBindings, rolePermissions } from './iam.mjs';
import { explicitFlows } from './wiring.mjs';
import { resourcesForValue, iamServiceOf } from './arn.mjs';
import { policyContext } from './policy.mjs';

// メタデータの取得（中身は読まない）。IAM 視点には出すが、データの流れにはしない
const METADATA_OP = /^(GetQueueAttributes|GetQueueUrl|GetBucketLocation|GetBucketAcl|GetBucketPolicy|GetBucketVersioning|GetEncryptionConfiguration|GetAuthorizationToken|Describe|List)/;
// 受信側の後処理（受け取ったメッセージの削除・可視性の延長）は、受け取る側の操作として扱う
const CONSUMER_OP = /^(ReceiveMessage|DeleteMessage|DeleteMessageBatch|ChangeMessageVisibility)/;
const READ_VERB = /^(Get|Query|Scan|BatchGet|Select|Read|Consume|Pull)/;
const WRITE_VERB = /^(Put|Update|Write|Send|Delete|BatchWrite|Create|Publish|Invoke|Start|Run|Execute|Upload|Push)/;

/** IAM の action を、データの「読み取り（相手 → 自分）」と「書き込み（自分 → 相手）」に分ける */
export function classifyActions(actions) {
  const ops = actions.map((a) => ({ action: a, op: a.split(':')[1] ?? '' }));
  const isAll = (op) => op === '*';
  const reads = ops.filter(({ op }) => isAll(op) || CONSUMER_OP.test(op) || (READ_VERB.test(op) && !METADATA_OP.test(op)));
  const writes = ops.filter(({ op }) => isAll(op) || (WRITE_VERB.test(op) && !CONSUMER_OP.test(op)));
  return { reads: reads.map(({ action }) => action), writes: writes.map(({ action }) => action) };
}

// ---------- 接続先を知っているか ----------

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 環境変数の「値」を集める（参照では繋がっていなくても、名前や ARN の文字列で突き合わせられる） */
function envValuesOf(resource, index) {
  if (resource.type === 'aws_lambda_function') return Object.values(resource.values.environment?.[0]?.variables ?? {});
  const td = index.get(refsOfType(resource.expressions.task_definition, index, 'aws_ecs_task_definition')[0]);
  const defs = td ? valueAt(td, 'container_definitions') : null;
  const parsed = typeof defs === 'string' ? parseJson(defs) ?? [] : [];
  return parsed.flatMap((c) => [...(c.environment ?? []).map((e) => e.value), ...(c.secrets ?? []).map((s) => s.valueFrom)]);
}

/** CodeBuild の環境変数は environment.environment_variable に1件ずつ入る */
function codeBuildEnvValues(resource) {
  return (resource.values.environment?.[0]?.environment_variable ?? []).map((e) => e.value);
}

/** コンピュートが設定として「知っている」リソース（環境変数やコンテナ定義、パイプラインのステージで参照・記載しているもの） */
export function knownTargets(index, ctx = policyContext(index)) {
  const fromValues = (values) => values.flatMap((v) => resourcesForValue(v, ctx.candidates));
  const lambdas = resourcesOfType(index, 'aws_lambda_function').map((c) => ({
    compute: c.address,
    targets: [...allRefsOf(c.expressions.environment, index), ...fromValues(envValuesOf(c, index))],
    evidence: c.address,
  }));
  const ecs = resourcesOfType(index, 'aws_ecs_service').map((c) => {
    const td = refsOfType(c.expressions.task_definition, index, 'aws_ecs_task_definition')[0];
    return { compute: c.address, targets: [...(td ? refsOf(index.get(td).expressions.container_definitions, index) : []), ...fromValues(envValuesOf(c, index))], evidence: td ?? c.address };
  });
  const codebuild = resourcesOfType(index, 'aws_codebuild_project').map((c) => ({
    compute: c.address,
    targets: [...allRefsOf(c.expressions.environment, index), ...fromValues(codeBuildEnvValues(c))],
    evidence: c.address,
  }));
  const pipelines = resourcesOfType(index, 'aws_codepipeline').map((c) => ({
    compute: c.address,
    targets: allRefsOf(c.expressions, index),
    evidence: c.address,
  }));
  return [...lambdas, ...ecs, ...codebuild, ...pipelines].map((k) => ({ ...k, targets: [...new Set(k.targets)].filter((a) => a !== k.compute) }));
}

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

// ---------- 推定 ----------

// データの置き場所。共有ロールでも、ここへの読み書きは「アクセスできる状態」として線にする
const DATA_STORES = new Set([
  'aws_s3_bucket', 'aws_dynamodb_table', 'aws_sqs_queue', 'aws_sns_topic', 'aws_kinesis_stream', 'aws_kinesis_firehose_delivery_stream',
  'aws_secretsmanager_secret', 'aws_db_instance', 'aws_rds_cluster', 'aws_efs_file_system', 'aws_elasticache_replication_group', 'aws_elasticache_cluster',
]);

/**
 * ロールを複数のリソースで共有していると、どの権限をどれが使うのか IAM からは分からない。
 * その場合、相手がデータの置き場所なら「共有ロール」として線にし、それ以外（ビルドやコンピュート）は
 * 「接続先として参照している」根拠があるものだけを線にする（CodeBuild 同士のような掛け算の線を防ぐ）。
 */
/**
 * Resource: "*" の許可は単独では線にしないが、コンピュートが接続先として参照している相手のうち、
 * 許可された操作のサービスが合うもの（states:StartExecution と Step Functions など）には、その許可で届くとみなす
 */
function wildcardToKnown(p, known, index) {
  return [...(known.get(p.compute) ?? [])].flatMap((target) => {
    const service = iamServiceOf(index.get(target)?.type);
    const actions = p.actions.filter((a) => a === '*' || a.split(':')[0] === service);
    return service && actions.length ? [{ ...p, target, actions, evidence: p.evidence.map((ev) => ({ ...ev, text: `${ev.text}（Resource: *）` })) }] : [];
  });
}

function iamFlows(index, nodeIds, ctx, known, explicitPairs) {
  const roleOwners = roleBindings(index).reduce((acc, b) => acc.set(b.role, [...(acc.get(b.role) ?? []), b]), new Map());
  const sharedRoles = new Set([...roleOwners.entries()].filter(([, owners]) => new Set(owners.map((o) => o.compute)).size > 1).map(([role]) => role));
  return rolePermissions(index, ctx)
    .flatMap((p) => (roleOwners.get(p.role) ?? []).map((b) => ({ ...p, compute: b.compute, as: b.as })))
    .flatMap((p) => (p.target === 'any:*' ? wildcardToKnown(p, known, index) : [p]))
    .filter((p) => nodeIds.has(p.target))
    .filter((p) => p.compute !== p.target && !explicitPairs.has(pairKey(p.compute, p.target)))
    .flatMap((p) => {
      const { reads, writes } = classifyActions(p.actions);
      const knows = known.get(p.compute)?.has(p.target) ?? false;
      const shared = sharedRoles.has(p.role);
      if (!knows && shared && !DATA_STORES.has(index.get(p.target).type)) return [];
      const reference = knows ? [{ text: '環境変数などで接続先として参照', address: known.get(p.compute).evidence }] : [];
      const evidence = [...reference, ...p.evidence.map((ev) => ({ ...ev, text: `${p.as}の${ev.text}` }))];
      const strength = knows ? 'referenced' : shared ? 'shared-role' : 'iam-only';
      const common = { kind: 'flow', inferred: true, evidence, strength };
      return [
        ...(writes.length ? [edge({ ...common, source: p.compute, target: p.target, labels: [actionLabel(writes)], actions: writes })] : []),
        ...(reads.length ? [edge({ ...common, source: p.target, target: p.compute, labels: [actionLabel(reads)], actions: reads })] : []),
      ];
    });
}

/** IAM が無い相手（RDS など）は、「参照している」かつ「SG で通信が許可されている」なら双方向の流れにする */
function networkFlows(networkEdges, known, explicitPairs) {
  return networkEdges
    .filter((e) => e.kind === 'sg' && known.get(e.source)?.has(e.target) && !explicitPairs.has(pairKey(e.source, e.target)))
    .map((e) =>
      edge({
        kind: 'flow',
        inferred: true,
        strength: 'referenced',
        source: e.source,
        target: e.target,
        labels: [e.label],
        bidirectional: true,
        evidence: [{ text: '環境変数などで接続先として参照', address: known.get(e.source).evidence }, ...e.evidence],
      }),
    );
}

export function buildDataView(index, nodeIds, networkEdges, ctx = policyContext(index)) {
  const explicit = explicitFlows(index, ctx.sources).filter((e) => e.source !== e.target);
  const explicitPairs = new Set(explicit.map((e) => pairKey(e.source, e.target)));
  const known = new Map(
    knownTargets(index, ctx).map((k) => [k.compute, Object.assign(new Set(k.targets), { evidence: k.evidence })]),
  );
  const edges = mergeEdges([...explicit, ...iamFlows(index, nodeIds, ctx, known, explicitPairs), ...networkFlows(networkEdges, known, explicitPairs)]);
  return {
    nodes: [...new Set(edges.flatMap((e) => [e.source, e.target]))].filter((id) => id === INTERNET_ID || nodeIds.has(id)),
    parents: {},
    edges: edges.filter((e) => (e.source === INTERNET_ID || nodeIds.has(e.source)) && nodeIds.has(e.target)),
  };
}
