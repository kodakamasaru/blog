// ノードの種類 → AWS Architecture Icons のファイル（viewer/public/icons/）
const BY_TYPE = Object.freeze({
  region: 'region',
  aws_vpc: 'vpc',
  'public-subnet': 'public-subnet',
  'private-subnet': 'private-subnet',
  aws_internet_gateway: 'internet-gateway',
  aws_nat_gateway: 'nat-gateway',
  aws_vpc_endpoint: 'vpc-endpoint',
  'aws_lb.application': 'alb',
  'aws_lb.network': 'nlb',
  aws_cloudfront_distribution: 'cloudfront',
  aws_instance: 'ec2',
  aws_ecs_service: 'ecs',
  aws_ecs_task_definition: 'ecs',
  aws_ecr_repository: 'ecr',
  aws_batch_job_queue: 'batch',
  aws_batch_compute_environment: 'batch',
  aws_lambda_function: 'lambda',
  aws_db_instance: 'rds',
  aws_rds_cluster: 'aurora',
  aws_db_proxy: 'rds-proxy',
  aws_dynamodb_table: 'dynamodb',
  aws_elasticache_replication_group: 'elasticache',
  aws_elasticache_cluster: 'elasticache',
  aws_s3_bucket: 's3',
  aws_efs_file_system: 'efs',
  aws_sqs_queue: 'sqs',
  aws_sns_topic: 'sns',
  aws_apigatewayv2_api: 'api-gateway',
  aws_api_gateway_rest_api: 'api-gateway',
  aws_cloudwatch_event_bus: 'eventbridge-bus',
  aws_cloudwatch_event_rule: 'eventbridge-rule',
  aws_scheduler_schedule: 'eventbridge-scheduler',
  aws_pipes_pipe: 'eventbridge-pipes',
  aws_sfn_state_machine: 'step-functions',
  aws_kinesis_stream: 'kinesis',
  aws_kinesis_firehose_delivery_stream: 'firehose',
  aws_codebuild_project: 'codebuild',
  aws_codepipeline: 'codepipeline',
  aws_secretsmanager_secret: 'secrets-manager',
  aws_kms_key: 'kms',
  aws_wafv2_web_acl: 'waf',
  aws_cognito_user_pool: 'cognito',
  aws_iam_role: 'iam-role',
  'managed-policy': 'iam-permissions',
  internet: 'internet',
  wildcard: 'iam-permissions',
});

// サービスプリンシパル（s3.amazonaws.com など）はそのサービスのアイコンにする
const BY_PRINCIPAL = Object.freeze({
  s3: 's3', lambda: 'lambda', 'ecs-tasks': 'ecs', sns: 'sns', sqs: 'sqs', apigateway: 'api-gateway', events: 'eventbridge-rule',
  scheduler: 'eventbridge-scheduler', states: 'step-functions', ec2: 'ec2', rds: 'rds', codebuild: 'codebuild', codepipeline: 'codepipeline',
  cloudfront: 'cloudfront', pipes: 'eventbridge-pipes', firehose: 'firehose', logs: 'iam',
});

const BASE = import.meta.env?.BASE_URL ?? './';

export function iconOf(node) {
  if (node.type === 'principal') return `${BASE}icons/${BY_PRINCIPAL[node.name.split('.')[0]] ?? 'iam'}.svg`;
  const file = BY_TYPE[node.type];
  return file ? `${BASE}icons/${file}.svg` : null;
}
