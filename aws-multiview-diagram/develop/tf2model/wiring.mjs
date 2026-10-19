// IaC に配線が書かれている「明示的な流れ」。データフロー視点の実線になる。
// 実際のコードでは、配線は本体ではなく別のリソース（統合、ターゲット、サブスクリプション…）に書かれることが多い。
import { refsOf, refsOfType, resourcesOfType, allRefsOf, stripIndex, withManagedTwins } from './plan.mjs';
import { INTERNET_ID, edge, isNodeResource } from './catalog.mjs';
import { resourcesForValue, resourcesForPattern } from './arn.mjs';
import { attributeLiterals } from './source.mjs';

const flow = (source, target, label, evidence) => edge({ source, target, kind: 'flow', labels: [label], evidence });
const nodeRefs = (expr, index) => refsOf(expr, index).filter((a) => isNodeResource(index.get(a)));
const allNodeRefs = (expr, index) => allRefsOf(expr, index).filter((a) => isNodeResource(index.get(a)));

// ---------- ロードバランサー ----------

/** ALB に紐づくターゲットグループ（リスナーの既定アクションとリスナールールの両方を見る） */
function targetGroupsOfLb(lb, index) {
  const listeners = resourcesOfType(index, 'aws_lb_listener').filter((l) => refsOfType(l.expressions.load_balancer_arn, index, 'aws_lb').includes(lb));
  const listenerIds = new Set(listeners.map((l) => l.address));
  const rules = resourcesOfType(index, 'aws_lb_listener_rule').filter((r) => refsOfType(r.expressions.listener_arn, index, 'aws_lb_listener').some((l) => listenerIds.has(l)));
  const tgs = [...listeners, ...rules].flatMap((x) => allRefsOf(x.expressions, index).filter((a) => index.get(a).type === 'aws_lb_target_group'));
  return { listeners, tgs: [...new Set(tgs)] };
}

function loadBalancerFlows(index) {
  return resourcesOfType(index, 'aws_lb').flatMap((lb) => {
    const { listeners, tgs } = targetGroupsOfLb(lb.address, index);
    const ports = listeners.map((l) => `${l.values.protocol ?? ''} :${l.values.port ?? ''}`.trim());
    const inbound = lb.values.internal !== true && listeners.length
      ? [flow(INTERNET_ID, lb.address, ports.join(', '), listeners.map((l) => ({ text: 'リスナー', address: l.address })))]
      : [];
    const toServices = resourcesOfType(index, 'aws_ecs_service').flatMap((svc) =>
      allRefsOf(svc.expressions.load_balancer, index)
        .filter((a) => tgs.includes(a))
        .map((tg) => {
          const t = index.get(tg).values;
          return flow(lb.address, svc.address, `${t.protocol ?? ''} :${t.port ?? ''}`.trim(), [{ text: 'ターゲットグループ', address: tg }, { text: 'サービスの load_balancer', address: svc.address }]);
        }),
    );
    const toAttachments = resourcesOfType(index, 'aws_lb_target_group_attachment')
      .filter((att) => refsOfType(att.expressions.target_group_arn, index, 'aws_lb_target_group').some((tg) => tgs.includes(tg)))
      .flatMap((att) => nodeRefs(att.expressions.target_id, index).map((t) => flow(lb.address, t, 'ターゲット', [{ text: 'ターゲットグループへの登録', address: att.address }])));
    return [...inbound, ...toServices, ...toAttachments];
  });
}

// ---------- API Gateway ----------

function apiGatewayFlows(index) {
  const http = resourcesOfType(index, 'aws_apigatewayv2_integration').flatMap((integ) => {
    const api = refsOfType(integ.expressions.api_id, index, 'aws_apigatewayv2_api')[0];
    if (!api) return [];
    const routes = resourcesOfType(index, 'aws_apigatewayv2_route').filter((r) => refsOf(r.expressions.target, index).includes(integ.address));
    const label = routes.map((r) => r.values.route_key).filter(Boolean).join(', ') || integ.values.integration_type || '統合';
    return nodeRefs(integ.expressions.integration_uri, index)
      .filter((t) => t !== api)
      .map((t) => flow(api, t, label, [{ text: 'API の統合', address: integ.address }, ...routes.map((r) => ({ text: 'ルート', address: r.address }))]));
  });
  const rest = resourcesOfType(index, 'aws_api_gateway_integration').flatMap((integ) => {
    const api = refsOfType(integ.expressions.rest_api_id, index, 'aws_api_gateway_rest_api')[0];
    if (!api) return [];
    return allNodeRefs(integ.expressions, index)
      .filter((t) => t !== api && index.get(t).type !== 'aws_iam_role')
      .map((t) => flow(api, t, `${integ.values.http_method ?? ''} ${integ.values.type ?? ''}`.trim(), [{ text: 'API の統合', address: integ.address }]));
  });
  // HTTP API と、エンドポイントの種類が PRIVATE ではない REST API はインターネットから呼ばれる
  const publicApis = [
    ...resourcesOfType(index, 'aws_apigatewayv2_api'),
    ...resourcesOfType(index, 'aws_api_gateway_rest_api').filter((a) => !(a.values.endpoint_configuration?.[0]?.types ?? []).includes('PRIVATE')),
  ];
  const inbound = publicApis.map((api) => flow(INTERNET_ID, api.address, api.values.protocol_type ?? 'HTTPS', [{ text: 'API', address: api.address }]));
  return [...http, ...rest, ...inbound];
}

// ---------- イベント系 ----------

function s3Notifications(index) {
  const buckets = resourcesOfType(index, 'aws_s3_bucket');
  return resourcesOfType(index, 'aws_s3_bucket_notification').flatMap((n) => {
    // bucket は参照のほか、バケット名の文字列（変数経由）で書かれることもある
    const bucket = refsOfType(n.expressions.bucket, index, 'aws_s3_bucket')[0] ?? resourcesForValue(n.values.bucket, buckets)[0];
    const pick = (block, attr, type) =>
      (n.expressions[block] ?? []).map((q, i) => ({ to: refsOfType(q[attr], index, type)[0], events: n.values[block]?.[i]?.events }));
    const targets = [...pick('queue', 'queue_arn', 'aws_sqs_queue'), ...pick('topic', 'topic_arn', 'aws_sns_topic'), ...pick('lambda_function', 'lambda_function_arn', 'aws_lambda_function')];
    return targets.filter((t) => bucket && t.to).map((t) => flow(bucket, t.to, (t.events ?? ['event']).join(', '), [{ text: 'S3 イベント通知', address: n.address }]));
  });
}

function eventSourceMappings(index) {
  return resourcesOfType(index, 'aws_lambda_event_source_mapping').flatMap((m) => {
    const source = refsOfType(m.expressions.event_source_arn, index, 'aws_sqs_queue', 'aws_kinesis_stream', 'aws_dynamodb_table', 'aws_msk_cluster')[0];
    const fn = refsOfType(m.expressions.function_name, index, 'aws_lambda_function')[0];
    if (!source || !fn) return [];
    const batch = m.values.batch_size ? ` (batch ${m.values.batch_size})` : '';
    return [flow(source, fn, `poll${batch}`, [{ text: 'Event Source Mapping', address: m.address }])];
  });
}

function eventBridgeFlows(index, sources) {
  const targets = resourcesOfType(index, 'aws_cloudwatch_event_target').flatMap((t) => {
    const rule = refsOfType(t.expressions.rule, index, 'aws_cloudwatch_event_rule')[0];
    if (!rule) return [];
    // ECS タスクを起動するターゲットは arn がクラスターなので、task_definition_arn からサービスを探す
    const taskDefs = refsOfType(t.expressions.ecs_target?.[0]?.task_definition_arn, index, 'aws_ecs_task_definition');
    const ecsServices = resourcesOfType(index, 'aws_ecs_service').filter((s) => refsOf(s.expressions.task_definition, index).some((td) => taskDefs.includes(td)));
    const label = index.get(rule).values.schedule_expression ?? 'イベント';
    return [...nodeRefs(t.expressions.arn, index).filter((a) => a !== rule), ...ecsServices.map((s) => s.address)].map((to) =>
      flow(rule, to, label, [{ text: 'EventBridge のターゲット', address: t.address }]),
    );
  });
  const busToRule = resourcesOfType(index, 'aws_cloudwatch_event_rule').flatMap((rule) =>
    refsOfType(rule.expressions.event_bus_name, index, 'aws_cloudwatch_event_bus').map((bus) => flow(bus, rule.address, 'ルール', [{ text: 'イベントバス', address: rule.address }])),
  );
  const pipes = resourcesOfType(index, 'aws_pipes_pipe').flatMap((p) => [
    ...nodeRefs(p.expressions.source, index).map((from) => flow(from, p.address, 'source', [{ text: 'Pipes の source', address: p.address }])),
    ...nodeRefs(p.expressions.target, index).map((to) => flow(p.address, to, 'target', [{ text: 'Pipes の target', address: p.address }])),
  ]);
  return [...targets, ...busToRule, ...schedulerFlows(index, sources), ...pipes];
}

const UNIVERSAL_TARGET = 'arn:aws:scheduler:::aws-sdk:';
const ESTIMATED = 'ソースの文字列から推定（plan では値が未確定）';

// ユニバーサルターゲットの API のサービス → 呼び出し先になりうるリソースの種類（同じ名前の別サービスのリソースを拾わないように）
const TARGET_TYPES_OF_SERVICE = Object.freeze({
  ecs: ['aws_ecs_service'],
  rds: ['aws_db_instance', 'aws_rds_cluster'],
  ec2: ['aws_instance'],
  batch: ['aws_batch_job_queue'],
  lambda: ['aws_lambda_function'],
  sqs: ['aws_sqs_queue'],
  sns: ['aws_sns_topic'],
  sfn: ['aws_sfn_state_machine'],
});

function candidatesForAction(action, candidates) {
  const types = TARGET_TYPES_OF_SERVICE[action.split(':')[0]];
  return types ? candidates.filter((r) => types.includes(r.type)) : candidates;
}

/**
 * JSON の属性（ステートマシンの定義、スケジュールの input）に書かれた行き先。
 * plan で値が確定していればその文字列を、jsonencode に未確定の値が混ざっていればソースの文字列リテラルを使う
 * @returns {{ targets: string[], estimated: boolean }}
 */
function targetsInJson(resource, value, attr, sources, candidates, keep = () => true) {
  if (typeof value === 'string') {
    return { targets: jsonStrings(value).filter(keep).flatMap((v) => resourcesForValue(v, candidates)), estimated: false };
  }
  const code = (sources[resource.blockKey] ?? sources[stripIndex(resource.address)])?.code ?? '';
  return { targets: attributeLiterals(code, attr).filter(keep).flatMap((p) => resourcesForPattern(p, candidates)), estimated: true };
}

/** JSON の文字列から、文字列の値をすべて取り出す（ユニバーサルターゲットの input の名前や ID） */
function jsonStrings(text) {
  try {
    const walk = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(walk) : []);
    return walk(JSON.parse(text));
  } catch {
    return [];
  }
}

/**
 * EventBridge Scheduler のターゲット。
 *   通常のターゲット       : target.arn の参照（ECS のタスク起動ならタスク定義を使うサービス）
 *   ユニバーサルターゲット : arn は "aws-sdk:rds:stopDBInstance" のような API で、呼び出し先は input に書かれる。
 *                            input の参照と、input に書かれた名前・ID・ARN をリソースと突き合わせる
 */
function schedulerFlows(index, sources) {
  const candidates = [...index.values()].filter(isNodeResource);
  return resourcesOfType(index, 'aws_scheduler_schedule').flatMap((s) => {
    const expr = s.expressions.target?.[0];
    const target = s.values.target?.[0] ?? {};
    const action = typeof target.arn === 'string' && target.arn.startsWith(UNIVERSAL_TARGET) ? target.arn.slice(UNIVERSAL_TARGET.length) : null;
    // ECS のタスクを起動するターゲット: サービスが使うタスク定義ならサービス、単発のタスクならタスク自体が行き先
    const taskDefs = withManagedTwins(refsOfType(expr?.ecs_parameters?.[0]?.task_definition_arn, index, 'aws_ecs_task_definition'), index);
    const ecsServices = [
      ...resourcesOfType(index, 'aws_ecs_service').filter((svc) => withManagedTwins(refsOf(svc.expressions.task_definition, index), index).some((td) => taskDefs.includes(td))),
      ...taskDefs.map((td) => index.get(td)).filter((td) => isNodeResource(td)),
    ];
    const input = action ? targetsInJson(s, target.input, 'input', sources, candidatesForAction(action, candidates)) : { targets: [], estimated: false };
    const notSelf = (a) => a !== s.address && index.get(a).type !== 'aws_iam_role';
    const schedule = s.values.schedule_expression ?? 'スケジュール';
    const label = action ? `${action} · ${schedule}` : schedule;
    const evidence = [{ text: 'スケジュールのターゲット', address: s.address }];
    const explicit = [...nodeRefs(expr?.arn, index), ...ecsServices.map((svc) => svc.address), ...allNodeRefs(expr?.input, index)].filter(notSelf);
    const fromInput = input.targets.filter((a) => notSelf(a) && !explicit.includes(a));
    return [
      ...[...new Set(explicit)].map((to) => flow(s.address, to, label, evidence)),
      ...[...new Set(fromInput)].map((to) => flow(s.address, to, label, input.estimated ? [...evidence, { text: ESTIMATED, address: s.address }] : evidence)),
    ];
  });
}

function messagingFlows(index) {
  const sns = resourcesOfType(index, 'aws_sns_topic_subscription').flatMap((sub) => {
    const topic = refsOfType(sub.expressions.topic_arn, index, 'aws_sns_topic')[0];
    if (!topic) return [];
    return nodeRefs(sub.expressions.endpoint, index)
      .filter((a) => a !== topic)
      .map((to) => flow(topic, to, sub.values.protocol ?? 'subscribe', [{ text: 'SNS サブスクリプション', address: sub.address }]));
  });
  const redrive = resourcesOfType(index, 'aws_sqs_queue').flatMap((q) =>
    refsOfType(q.expressions.redrive_policy, index, 'aws_sqs_queue')
      .filter((dlq) => dlq !== q.address)
      .map((dlq) => flow(q.address, dlq, '処理失敗時 (redrive)', [{ text: 'redrive_policy で DLQ を指定', address: q.address }])),
  );
  return [...sns, ...redrive];
}

// ---------- データベース・配信・CI ----------

function databaseFlows(index) {
  const proxy = resourcesOfType(index, 'aws_db_proxy_target').flatMap((t) => {
    const p = refsOfType(t.expressions.db_proxy_name, index, 'aws_db_proxy')[0];
    const dbs = [...refsOfType(t.expressions.db_cluster_identifier, index, 'aws_rds_cluster'), ...refsOfType(t.expressions.db_instance_identifier, index, 'aws_db_instance')];
    return p ? dbs.map((db) => flow(p, db, 'proxy', [{ text: 'RDS Proxy のターゲット', address: t.address }])) : [];
  });
  const proxyAuth = resourcesOfType(index, 'aws_db_proxy').flatMap((p) =>
    allRefsOf(p.expressions.auth, index)
      .filter((a) => index.get(a).type === 'aws_secretsmanager_secret')
      .map((s) => flow(s, p.address, '認証情報', [{ text: 'RDS Proxy の auth', address: p.address }])),
  );
  return [...proxy, ...proxyAuth];
}

/** ロググループにログを書くリソース（Lambda は /aws/lambda/<関数名> のロググループに書く） */
function logGroupOwners(sub, index) {
  const group = refsOfType(sub.expressions.log_group_name, index, 'aws_cloudwatch_log_group')[0];
  const name = group ? index.get(group).values.name : sub.values.log_group_name;
  if (typeof name !== 'string') return [];
  return resourcesOfType(index, 'aws_lambda_function').filter((fn) => name === `/aws/lambda/${fn.values.function_name}`).map((fn) => fn.address);
}

// ---------- コンテナイメージ ----------

/** ECR → イメージを使うもの（Lambda の image_uri、ECS のコンテナ定義） */
function imageFlows(index) {
  const reposIn = (expr) => allRefsOf(expr, index).filter((a) => index.get(a).type === 'aws_ecr_repository');
  const image = (repo, to, evidence) => flow(repo, to, 'イメージ', [{ text: 'コンテナイメージ', address: evidence }]);
  const lambdas = resourcesOfType(index, 'aws_lambda_function').flatMap((fn) => reposIn(fn.expressions.image_uri).map((repo) => image(repo, fn.address, fn.address)));
  const services = resourcesOfType(index, 'aws_ecs_service').flatMap((svc) =>
    withManagedTwins(refsOfType(svc.expressions.task_definition, index, 'aws_ecs_task_definition'), index).flatMap((td) =>
      reposIn(index.get(td).expressions.container_definitions).map((repo) => image(repo, svc.address, td)),
    ),
  );
  const tasks = resourcesOfType(index, 'aws_ecs_task_definition')
    .filter(isNodeResource)
    .flatMap((td) => reposIn(td.expressions.container_definitions).map((repo) => image(repo, td.address, td.address)));
  return [...lambdas, ...services, ...tasks];
}

function deliveryFlows(index) {
  const cloudfront = resourcesOfType(index, 'aws_cloudfront_distribution').flatMap((cf) => [
    flow(INTERNET_ID, cf.address, 'HTTPS', [{ text: 'ディストリビューション', address: cf.address }]),
    ...allNodeRefs(cf.expressions.origin, index).map((o) => flow(cf.address, o, 'origin', [{ text: 'オリジン', address: cf.address }])),
  ]);
  const firehose = resourcesOfType(index, 'aws_kinesis_firehose_delivery_stream').flatMap((f) =>
    allRefsOf(f.expressions, index).flatMap((a) => {
      if (index.get(a).type === 'aws_kinesis_stream') return [flow(a, f.address, 'source', [{ text: 'Firehose', address: f.address }])];
      if (index.get(a).type === 'aws_s3_bucket') return [flow(f.address, a, 'delivery', [{ text: 'Firehose', address: f.address }])];
      // processing_configuration の LambdaArn（レコードを変換する Lambda）
      if (index.get(a).type === 'aws_lambda_function') return [flow(f.address, a, '変換', [{ text: 'Firehose の processing_configuration', address: f.address }])];
      return [];
    }),
  );
  const logSubscriptions = resourcesOfType(index, 'aws_cloudwatch_log_subscription_filter').flatMap((sub) => {
    const sources = logGroupOwners(sub, index);
    const label = `ログ (${sub.values.filter_pattern || 'すべて'})`;
    return nodeRefs(sub.expressions.destination_arn, index).flatMap((to) =>
      sources.map((from) => flow(from, to, label, [{ text: 'ロググループのサブスクリプションフィルター', address: sub.address }])),
    );
  });
  const functionUrl = resourcesOfType(index, 'aws_lambda_function_url').flatMap((u) =>
    refsOfType(u.expressions.function_name, index, 'aws_lambda_function').map((fn) => flow(INTERNET_ID, fn, `Function URL (${u.values.authorization_type ?? ''})`, [{ text: 'Function URL', address: u.address }])),
  );
  return [...cloudfront, ...firehose, ...logSubscriptions, ...functionUrl];
}

function orchestrationFlows(index, sources) {
  const pipeline = resourcesOfType(index, 'aws_codepipeline').flatMap((p) => {
    const stageTargets = allNodeRefs(p.expressions.stage, index).filter((a) => index.get(a).type !== 'aws_iam_role');
    const store = allRefsOf(p.expressions.artifact_store, index).filter((a) => index.get(a).type === 'aws_s3_bucket');
    return [
      ...stageTargets.map((t) => flow(p.address, t, 'ステージ', [{ text: 'パイプラインのステージ', address: p.address }])),
      ...store.map((b) => flow(p.address, b, 'アーティファクト', [{ text: 'artifact_store', address: p.address }])),
    ];
  });
  // 定義の中のタスクは、参照のほかに ARN の文字列で書かれることも多い（"arn:aws:lambda:...:function:x:$LATEST"）
  const candidates = [...index.values()].filter(isNodeResource);
  const sfn = resourcesOfType(index, 'aws_sfn_state_machine').flatMap((sm) => {
    const notSelf = (a) => a !== sm.address && index.get(a).type !== 'aws_iam_role';
    const evidence = [{ text: 'ステートマシンの定義', address: sm.address }];
    const explicit = allNodeRefs(sm.expressions.definition, index).filter(notSelf);
    const byArn = targetsInJson(sm, sm.values.definition, 'definition', sources, candidates, (v) => v.startsWith('arn:'));
    const fromArn = byArn.targets.filter((a) => notSelf(a) && !explicit.includes(a));
    return [
      ...explicit.map((t) => flow(sm.address, t, 'タスク', evidence)),
      ...[...new Set(fromArn)].map((t) => flow(sm.address, t, 'タスク', byArn.estimated ? [...evidence, { text: ESTIMATED, address: sm.address }] : evidence)),
    ];
  });
  const batch = resourcesOfType(index, 'aws_batch_job_queue').flatMap((q) =>
    allRefsOf(q.expressions.compute_environment_order, index)
      .filter((a) => index.get(a).type === 'aws_batch_compute_environment')
      .map((ce) => flow(q.address, ce, '実行環境', [{ text: 'ジョブキューの compute_environment_order', address: q.address }])),
  );
  return [...pipeline, ...sfn, ...batch];
}

/** IaC に配線が書かれている流れをすべて集める */
/**
 * @param {Map<string, object>} index
 * @param {Record<string, { code: string }>} [sources] コード片（plan で値が未確定の JSON の中身を推定するのに使う）
 */
export function explicitFlows(index, sources = {}) {
  return [
    ...loadBalancerFlows(index),
    ...apiGatewayFlows(index),
    ...s3Notifications(index),
    ...eventSourceMappings(index),
    ...eventBridgeFlows(index, sources),
    ...messagingFlows(index),
    ...databaseFlows(index),
    ...deliveryFlows(index),
    ...imageFlows(index),
    ...orchestrationFlows(index, sources),
  ];
}
