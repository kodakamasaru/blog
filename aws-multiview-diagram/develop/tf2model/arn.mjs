// IAM ポリシーに書かれた ARN（ワイルドカードを含む）が、どのリソースを指しているかを名前で突き合わせる。
//
// 実際のコードでは、ポリシーの Resource をリソースの参照ではなく文字列で書くことが多い
// （"arn:aws:dynamodb:*:*:table/${var.table_name}" など）。参照では繋がらないが、plan の時点で
// テーブル名もポリシーの JSON も確定しているので、ARN の「リソース部分」を名前と比べれば対応が取れる。
import { UNKNOWN, valueAt } from './plan.mjs';

const str = (v) => (typeof v === 'string' && v !== '(sensitive)' ? v : null);

/** リソースの種類ごとに「サービス名」と「ARN のリソース部分の候補」を作る */
const IDENTITY = Object.freeze({
  aws_s3_bucket: (v) => ({ service: 's3', parts: [v.bucket, v.bucket && `${v.bucket}/*`] }),
  aws_dynamodb_table: (v) => ({ service: 'dynamodb', parts: [v.name && `table/${v.name}`] }),
  aws_sqs_queue: (v) => ({ service: 'sqs', parts: [v.name] }),
  aws_sns_topic: (v) => ({ service: 'sns', parts: [v.name] }),
  aws_lambda_function: (v) => ({ service: 'lambda', parts: [v.function_name && `function:${v.function_name}`] }),
  aws_secretsmanager_secret: (v) => ({ service: 'secretsmanager', parts: [v.name && `secret:${v.name}-xxxxxx`] }),
  aws_kinesis_stream: (v) => ({ service: 'kinesis', parts: [v.name && `stream/${v.name}`] }),
  aws_kinesis_firehose_delivery_stream: (v) => ({ service: 'firehose', parts: [v.name && `deliverystream/${v.name}`] }),
  aws_sfn_state_machine: (v) => ({ service: 'states', parts: [v.name && `stateMachine:${v.name}`] }),
  aws_cloudwatch_event_bus: (v) => ({ service: 'events', parts: [v.name && `event-bus/${v.name}`] }),
  aws_cloudwatch_event_rule: (v) => ({ service: 'events', parts: [v.name && `rule/${v.name}`] }),
  aws_ecr_repository: (v) => ({ service: 'ecr', parts: [v.name && `repository/${v.name}`] }),
  aws_codebuild_project: (v) => ({ service: 'codebuild', parts: [v.name && `project/${v.name}`] }),
  aws_db_instance: (v) => ({ service: 'rds', parts: [v.identifier && `db:${v.identifier}`] }),
  aws_rds_cluster: (v) => ({ service: 'rds', parts: [v.cluster_identifier && `cluster:${v.cluster_identifier}`] }),
  aws_ecs_service: (v) => ({ service: 'ecs', parts: [v.name && `service/*/${v.name}`] }),
  // リビジョン付き（task-definition/x:3）も同じタスク定義
  aws_ecs_task_definition: (v) => ({ service: 'ecs', parts: [v.family && `task-definition/${v.family}`, v.family && `task-definition/${v.family}:*`] }),
  aws_ssm_parameter: (v) => ({ service: 'ssm', parts: [v.name && `parameter${v.name.startsWith('/') ? '' : '/'}${v.name}`] }),
});

/** リソースの種類の IAM のサービス名（aws_sfn_state_machine → states）。分からなければ null */
export function iamServiceOf(type) {
  return IDENTITY[type]?.({}).service ?? null;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function parseArn(arn) {
  const parts = typeof arn === 'string' ? arn.split(':') : [];
  if (parts[0] !== 'arn' || parts.length < 6) return null;
  const resource = parts.slice(5).join(':');
  // Lambda の修飾子（:$LATEST、エイリアス、バージョン）付きの ARN も同じ関数を指す
  return { service: parts[2], resource: parts[2] === 'lambda' ? resource.replace(/^(function:[^:]+):.*$/, '$1') : resource };
}

/** ARN の文字列（ワイルドカード可）がリソースを指しているか */
export function arnMatches(arnPattern, resource) {
  const known = str(valueAt(resource, 'arn'));
  if (known && known !== UNKNOWN && globToRegExp(arnPattern).test(known)) return true;
  const parsed = parseArn(arnPattern);
  const identity = IDENTITY[resource.type]?.(resource.values ?? {});
  if (!parsed || !identity || parsed.service !== identity.service) return false;
  const pattern = globToRegExp(parsed.resource);
  // ワイルドカードを含む候補（secret の -xxxxxx、ECS のクラスター名 * など）は、候補側も正規表現にして比べる
  return identity.parts.filter(Boolean).some((part) => pattern.test(part) || globToRegExp(part.replace(/x{6}$/, '*')).test(parsed.resource));
}

/** ARN の文字列に合うノードをすべて返す */
export function resourcesForArn(arnPattern, candidates) {
  if (arnPattern === '*' || !parseArn(arnPattern)) return [];
  return candidates.filter((r) => arnMatches(arnPattern, r)).map((r) => r.address);
}

function namesOf(r) {
  const v = r.values ?? {};
  return [v.name, v.bucket, v.function_name, v.identifier, v.cluster_identifier, v.url, v.id].map(str).filter(Boolean);
}

/** 文字列の値（環境変数など）が、どのリソースの名前・ARN・URL と一致するか */
export function resourcesForValue(value, candidates) {
  if (typeof value !== 'string' || value.length < 3) return [];
  const byArn = value.startsWith('arn:') ? resourcesForArn(value, candidates) : [];
  const byName = candidates
    .filter((r) => namesOf(r).some((n) => n === value || (r.type === 'aws_sqs_queue' && value.endsWith(`/${n}`))))
    .map((r) => r.address);
  return [...new Set([...byArn, ...byName])];
}

// ワイルドカード以外の文字がこれより少ないパターン（"${var.x}" だけの文字列など）は、何にでも合うので使わない
const MIN_PATTERN_LITERAL = 4;

/** ソースの文字列（${...} を * にしたもの）が、どのリソースの名前・ARN に合うか */
export function resourcesForPattern(pattern, candidates) {
  if (typeof pattern !== 'string' || pattern.replaceAll('*', '').length < MIN_PATTERN_LITERAL) return [];
  if (pattern.startsWith('arn:')) return resourcesForArn(pattern, candidates);
  if (!pattern.includes('*')) return resourcesForValue(pattern, candidates);
  const re = globToRegExp(pattern);
  return candidates.filter((r) => namesOf(r).some((n) => re.test(n))).map((r) => r.address);
}
