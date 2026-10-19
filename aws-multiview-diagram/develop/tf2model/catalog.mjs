// 図にノードとして出すリソースの種類。ここに無い種類（SG ルールやポリシーなど）は
// ノードにはせず、エッジの「根拠」や詳細パネルの「関連リソース」として出す。
//
// placement は NW 視点で「どのサブネット・SG に属するか」を読む場所:
//   subnets      : サブネットを直接参照している属性
//   subnetGroup  : サブネットグループ経由（[属性, グループの種類]。グループの subnet_ids を読む）
//   sgs          : セキュリティグループを参照している属性
//   attachments  : 別リソース経由（[種類, 本体を参照する属性]。EFS のマウントターゲットなど）
export const CATALOG = Object.freeze({
  aws_vpc: { kind: 'VPC', category: 'network' },
  aws_internet_gateway: { kind: 'Internet Gateway', category: 'network' },
  aws_nat_gateway: { kind: 'NAT Gateway', category: 'network', placement: { subnets: ['subnet_id'] } },
  aws_vpc_endpoint: { kind: 'VPC Endpoint', category: 'network', placement: { subnets: ['subnet_ids'], sgs: ['security_group_ids'] } },
  aws_lb: { kind: 'ALB', category: 'network', placement: { subnets: ['subnets', 'subnet_mapping.subnet_id'], sgs: ['security_groups'] } },
  aws_cloudfront_distribution: { kind: 'CloudFront', category: 'network' },
  aws_instance: { kind: 'EC2', category: 'compute', placement: { subnets: ['subnet_id'], sgs: ['vpc_security_group_ids', 'security_groups'] } },
  aws_ecs_service: { kind: 'ECS Service', category: 'compute', placement: { subnets: ['network_configuration.0.subnets'], sgs: ['network_configuration.0.security_groups'] } },
  aws_lambda_function: { kind: 'Lambda', category: 'compute', placement: { subnets: ['vpc_config.0.subnet_ids'], sgs: ['vpc_config.0.security_group_ids'] } },
  aws_ecr_repository: { kind: 'ECR', category: 'compute' },
  // サービスが使うタスク定義はサービスの中身なので、単発で起動するものだけをノードにする（nodeIf）
  aws_ecs_task_definition: { kind: 'ECS タスク', category: 'compute', nodeIf: (r) => r.usedByService === false },
  aws_batch_job_queue: { kind: 'Batch ジョブキュー', category: 'compute' },
  aws_batch_compute_environment: { kind: 'Batch 実行環境', category: 'compute', placement: { subnets: ['compute_resources.subnets'], sgs: ['compute_resources.security_group_ids'] } },
  aws_db_instance: { kind: 'RDS', category: 'database', placement: { subnetGroup: ['db_subnet_group_name', 'aws_db_subnet_group'], sgs: ['vpc_security_group_ids'] } },
  aws_rds_cluster: { kind: 'Aurora', category: 'database', placement: { subnetGroup: ['db_subnet_group_name', 'aws_db_subnet_group'], sgs: ['vpc_security_group_ids'] } },
  aws_db_proxy: { kind: 'RDS Proxy', category: 'database', placement: { subnets: ['vpc_subnet_ids'], sgs: ['vpc_security_group_ids'] } },
  aws_dynamodb_table: { kind: 'DynamoDB', category: 'database' },
  aws_elasticache_replication_group: { kind: 'ElastiCache', category: 'database', placement: { subnetGroup: ['subnet_group_name', 'aws_elasticache_subnet_group'], sgs: ['security_group_ids'] } },
  aws_elasticache_cluster: { kind: 'ElastiCache', category: 'database', placement: { subnetGroup: ['subnet_group_name', 'aws_elasticache_subnet_group'], sgs: ['security_group_ids'] } },
  aws_s3_bucket: { kind: 'S3', category: 'storage' },
  aws_efs_file_system: { kind: 'EFS', category: 'storage', placement: { attachments: ['aws_efs_mount_target', 'file_system_id'] } },
  aws_sqs_queue: { kind: 'SQS', category: 'messaging' },
  aws_sns_topic: { kind: 'SNS', category: 'messaging' },
  aws_apigatewayv2_api: { kind: 'API Gateway', category: 'messaging' },
  aws_api_gateway_rest_api: { kind: 'API Gateway (REST)', category: 'messaging' },
  aws_cloudwatch_event_bus: { kind: 'EventBridge Bus', category: 'messaging' },
  aws_cloudwatch_event_rule: { kind: 'EventBridge Rule', category: 'messaging' },
  aws_scheduler_schedule: { kind: 'EventBridge Scheduler', category: 'messaging' },
  aws_pipes_pipe: { kind: 'EventBridge Pipes', category: 'messaging' },
  aws_sfn_state_machine: { kind: 'Step Functions', category: 'messaging' },
  aws_kinesis_stream: { kind: 'Kinesis Data Streams', category: 'messaging' },
  aws_kinesis_firehose_delivery_stream: { kind: 'Data Firehose', category: 'messaging' },
  aws_codebuild_project: { kind: 'CodeBuild', category: 'compute' },
  aws_codepipeline: { kind: 'CodePipeline', category: 'compute' },
  aws_secretsmanager_secret: { kind: 'Secrets Manager', category: 'security' },
  aws_kms_key: { kind: 'KMS Key', category: 'security' },
  aws_wafv2_web_acl: { kind: 'WAF', category: 'security' },
  aws_cognito_user_pool: { kind: 'Cognito', category: 'security' },
  aws_iam_role: { kind: 'IAM Role', category: 'security' },
});

export const INTERNET_ID = 'internet';

const NAME_KEYS = ['name', 'bucket', 'function_name', 'identifier', 'family'];

/** モジュールの中のリソースは名前が "this" などになりがちなので、モジュール名を補う */
function fallbackName(resource) {
  const generic = ['this', 'main', 'default', 'this_new'].includes(resource.name);
  const moduleName = resource.modulePath?.split('.').filter((p) => p !== 'module').at(-1);
  const key = resource.address.match(/\[(?:"([^"]+)"|(\d+))\]$/);
  const suffix = key ? `[${key[1] ?? key[2]}]` : '';
  return `${generic && moduleName ? moduleName : resource.name}${suffix}`;
}

export function displayName(resource) {
  const v = resource.values;
  const key = NAME_KEYS.find((k) => typeof v[k] === 'string' && v[k] !== '(sensitive)');
  return key ? v[key] : (v.tags?.Name ?? fallbackName(resource));
}

export function isNodeResource(resource) {
  return resource.mode === 'managed' && resource.type in CATALOG && (CATALOG[resource.type].nodeIf?.(resource) ?? true);
}

/** 名前の大半に共通する "photo-share-" のような接頭辞を落として、図のラベルを短くする */
export function commonPrefix(names) {
  const counts = names
    .flatMap((n) => [...n.matchAll(/-/g)].map((m) => n.slice(0, m.index + 1)))
    .reduce((acc, p) => acc.set(p, (acc.get(p) ?? 0) + 1), new Map());
  const threshold = names.length / 2;
  return [...counts.entries()]
    .filter(([, c]) => c > threshold)
    .map(([p]) => p)
    .sort((a, b) => b.length - a.length)[0] ?? '';
}

/**
 * 同じ向き・同じ種類のエッジを1本にまとめる。ラベルと根拠は結合する。
 * @param {Array<object>} edges
 */
export function mergeEdges(edges) {
  const merged = edges.reduce((acc, e) => {
    const id = `${e.kind}:${e.source}->${e.target}`;
    const prev = acc.get(id);
    const next = prev
      ? {
          ...prev,
          labels: [...new Set([...prev.labels, ...e.labels])],
          evidence: [...prev.evidence, ...e.evidence],
          actions: [...new Set([...prev.actions, ...e.actions])],
          inferred: prev.inferred && e.inferred,
        }
      : { ...e, id };
    return new Map(acc).set(id, next);
  }, new Map());
  return [...merged.values()].map(({ labels, ...e }) => ({ ...e, label: labels.join(', ') }));
}

/** エッジを作る小さなヘルパー（labels は mergeEdges でまとめる前の配列） */
/**
 * strength: 推定した線の根拠の強さ（'referenced' = 接続先を参照している / 'iam-only' = IAM の許可だけ）
 */
export function edge({ source, target, kind, labels = [], inferred = false, evidence = [], actions = [], bidirectional = false, strength = null }) {
  return { source, target, kind, labels, inferred, evidence, actions, bidirectional, strength };
}

const MAX_LABEL_ACTIONS = 3;

/**
 * 図の線に出すラベル。action が多いと図からはみ出すので、先頭の数件と残りの件数にする（全部は詳細パネルに出す）
 * 例: ["ecs:RunTask", "ecs:DescribeTasks", ...12件] -> "ecs:RunTask/DescribeTasks/StopTask ほか 9 件"
 */
export function actionLabel(actions) {
  if (actions.length <= MAX_LABEL_ACTIONS) return compactActions(actions);
  return `${compactActions(actions.slice(0, MAX_LABEL_ACTIONS))} ほか ${actions.length - MAX_LABEL_ACTIONS} 件`;
}

/** ["dynamodb:PutItem", "dynamodb:UpdateItem"] -> "dynamodb:PutItem/UpdateItem" */
export function compactActions(actions) {
  const byService = actions.reduce((acc, a) => {
    const [svc, op = '*'] = a.split(':');
    return new Map(acc).set(svc, [...(acc.get(svc) ?? []), op]);
  }, new Map());
  return [...byService.entries()].map(([svc, ops]) => `${svc}:${ops.join('/')}`).join(', ');
}
