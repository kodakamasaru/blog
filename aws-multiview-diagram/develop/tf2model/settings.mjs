// リソースの種類ごとに「運用で見たい設定値」を集める。
// 本体の属性だけでなく、関連リソース（タスク定義、リスナー、バケットの暗号化設定など）からも拾う。
// plan 時点で値が決まらないもの（jsonencode の中で ARN を参照しているコンテナ定義など）は、ソースの HCL から拾う。
import { refsOf, refsOfType, referencing, valueAt, UNKNOWN, resourcesOfType, stripIndex, withManagedTwins } from './plan.mjs';

const PENDING = 'apply 時に決定';

/** @typedef {{ label: string, value: string, pending?: boolean }} Setting */

function fmt(value, suffix = '') {
  if (value === UNKNOWN) return { value: PENDING, pending: true };
  if (value == null || value === '') return null;
  if (typeof value === 'boolean') return { value: value ? '有効' : '無効' };
  if (Array.isArray(value)) return value.length ? { value: value.join(', ') } : null;
  return { value: `${value}${suffix}` };
}

/** [label, value, suffix] の配列から、値があるものだけ Setting にする */
function rows(entries) {
  return entries
    .map(([label, value, suffix]) => {
      const f = fmt(value, suffix);
      return f ? { label, ...f } : null;
    })
    .filter(Boolean);
}

function seconds(sec) {
  if (sec === UNKNOWN || sec == null) return sec;
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400}日`;
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600}時間`;
  return `${sec}秒`;
}

function nameOf(index, address) {
  const r = index.get(address);
  return r?.values.name ?? r?.values.bucket ?? r?.values.tags?.Name ?? r?.name ?? address;
}

function stripPrefix(name, prefix) {
  return typeof name === 'string' && prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

// ---------- ソースからの補完 ----------

function codeOf(sources, address) {
  return (sources[address] ?? sources[stripIndex(address)])?.code ?? '';
}

/** コンテナ定義の `{ name = "X", value = aws_xxx.yyy.attr }` を拾う（plan では丸ごと unknown になるため） */
export function envFromSource(code) {
  const re = /name\s*=\s*"([A-Z0-9_]+)"\s*,\s*(value|valueFrom)\s*=\s*([\w.\["\]-]+)/g;
  return [...code.matchAll(re)].map(([, name, kind, ref]) => ({ name, ref, secret: kind === 'valueFrom' }));
}

function firstMatch(code, re) {
  return code.match(re)?.[1];
}

// ---------- 種類ごと ----------

function vpc(r) {
  return { summary: r.values.cidr_block, settings: rows([['CIDR', valueAt(r, 'cidr_block')], ['DNS ホスト名', valueAt(r, 'enable_dns_hostnames')], ['DNS 解決', valueAt(r, 'enable_dns_support')]]) };
}

function natGateway(r, ctx) {
  const subnet = refsOfType(r.expressions.subnet_id, ctx.index, 'aws_subnet')[0];
  const sv = ctx.index.get(subnet)?.values ?? {};
  const allNat = resourcesOfType(ctx.index, 'aws_nat_gateway');
  return {
    summary: `${sv.availability_zone ?? ''}${allNat.length === 1 ? '（単一 AZ）' : ''}`,
    settings: rows([
      ['配置サブネット', stripPrefix(sv.tags?.Name, ctx.prefix)],
      ['AZ', sv.availability_zone],
      ['接続タイプ', valueAt(r, 'connectivity_type')],
      ['冗長性', allNat.length === 1 ? 'NAT Gateway は 1 つだけ（AZ 障害時は外向き通信が止まる）' : `${allNat.length} 個`],
    ]),
  };
}

function listenerText(l, index, prefix) {
  const v = l.values;
  const action = (v.default_action ?? [])[0] ?? {};
  const tg = (l.expressions.default_action ?? []).flatMap((a) => refsOf(a.target_group_arn, index))[0];
  if (action.type === 'redirect') {
    const rd = action.redirect?.[0] ?? {};
    return `${v.protocol}:${v.port} → リダイレクト ${rd.protocol}:${rd.port} (${rd.status_code?.replace('HTTP_', '')})`;
  }
  return `${v.protocol}:${v.port} → ${tg ? stripPrefix(nameOf(index, tg), prefix) : action.type}`;
}

function loadBalancer(r, ctx) {
  const listeners = referencing(ctx.index, r.address, 'aws_lb_listener');
  const https = listeners.find((l) => l.values.protocol === 'HTTPS');
  const scheme = r.values.internal ? 'internal' : 'internet-facing';
  return {
    summary: `${scheme} · ${listeners.map((l) => `${l.values.protocol}:${l.values.port}`).join(', ')}`,
    settings: rows([
      ['スキーム', scheme],
      ...listeners.map((l) => ['リスナー', listenerText(l, ctx.index, ctx.prefix)]),
      ['TLS ポリシー', https?.values.ssl_policy],
      ['アイドルタイムアウト', valueAt(r, 'idle_timeout'), '秒'],
      ['不正なヘッダーを破棄', valueAt(r, 'drop_invalid_header_fields')],
      ['削除保護', valueAt(r, 'enable_deletion_protection')],
    ]),
  };
}

function healthCheckText(tg) {
  const hc = tg?.values.health_check?.[0];
  return hc ? `${hc.protocol} ${hc.path} → ${hc.matcher}（${hc.interval}秒ごと、${hc.unhealthy_threshold}回失敗で除外）` : null;
}

/** 要約の各項目。値が欠けている（null / undefined / 空）項目は飛ばして · でつなぐ */
function summaryOf(parts) {
  return parts.filter((p) => p != null && p !== '' && !/\b(null|undefined)\b/.test(String(p))).join(' · ');
}

function ecsLaunchLabel(v) {
  if (v.launch_type === 'FARGATE') return 'Fargate';
  return v.launch_type || (v.capacity_provider_strategy ?? []).map((c) => c.capacity_provider).filter(Boolean).join(' + ') || null;
}

function ecsService(r, ctx) {
  const { index, sources } = ctx;
  // GitHub Actions でデプロイする構成では、サービスはデータソースで最新のタスク定義を引くので、本体まで辿る
  const td = index.get(withManagedTwins(refsOfType(r.expressions.task_definition, index, 'aws_ecs_task_definition'), index)[0]);
  const tdv = td?.values ?? {};
  const code = td ? codeOf(sources, td.address) : '';
  const env = envFromSource(code);
  const tg = index.get((r.expressions.load_balancer ?? []).flatMap((b) => refsOf(b.target_group_arn, index))[0]);
  const vcpu = tdv.cpu ? Number(tdv.cpu) / 1024 : null;
  const memGb = tdv.memory ? Number(tdv.memory) / 1024 : null;
  const arch = tdv.runtime_platform?.[0]?.cpu_architecture;
  const cb = r.values.deployment_circuit_breaker?.[0];
  const logGroup = firstMatch(code, /awslogs-group\s*=\s*(aws_[\w]+\.[\w]+)/);
  return {
    summary: summaryOf([ecsLaunchLabel(r.values), vcpu != null && memGb != null ? `${vcpu} vCPU / ${memGb} GB` : null, r.values.desired_count != null ? `×${r.values.desired_count}` : null]),
    settings: rows([
      ['起動タイプ', ecsLaunchLabel(r.values) && `${ecsLaunchLabel(r.values)}${r.values.platform_version ? ` (${r.values.platform_version})` : ''}`],
      ['タスク数', valueAt(r, 'desired_count')],
      ['CPU / メモリ', vcpu != null ? `${vcpu} vCPU / ${memGb} GB${arch ? `（${arch}）` : ''}` : null],
      ['イメージ', firstMatch(code, /image\s*=\s*"([^"]+)"/) ?? UNKNOWN],
      ['コンテナポート', firstMatch(code, /containerPort\s*=\s*(\d+)/)],
      ['環境変数', env.filter((e) => !e.secret).map((e) => e.name)],
      ['シークレット', env.filter((e) => e.secret).map((e) => e.name)],
      ['ヘルスチェック', healthCheckText(tg)],
      ['猶予期間', valueAt(r, 'health_check_grace_period_seconds'), '秒'],
      ['パブリック IP', r.values.network_configuration?.[0]?.assign_public_ip],
      ['デプロイ失敗時', cb?.enable ? (cb.rollback ? '自動ロールバック' : '停止') : null],
      ['ECS Exec', valueAt(r, 'enable_execute_command')],
      ['ログ', logGroup ? `CloudWatch Logs（${nameOf(index, logGroup)}）` : null],
    ]),
  };
}

function lambdaFunction(r, ctx) {
  const v = r.values;
  const esm = referencing(ctx.index, r.address, 'aws_lambda_event_source_mapping')[0];
  const envNames = Object.keys(v.environment?.[0]?.variables ?? {});
  const envFallback = [...codeOf(ctx.sources, r.address).matchAll(/^\s*([A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);
  const arch = v.architectures?.[0];
  return {
    summary: summaryOf([v.runtime ?? (v.package_type === 'Image' ? 'コンテナイメージ' : null), arch ?? 'x86_64', v.memory_size != null && v.timeout != null ? `${v.memory_size}MB / ${v.timeout}秒` : null]),
    settings: rows([
      ['ランタイム', valueAt(r, 'runtime')],
      ['アーキテクチャ', arch],
      ['メモリ', valueAt(r, 'memory_size'), ' MB'],
      ['タイムアウト', valueAt(r, 'timeout'), '秒'],
      ['X-Ray', v.tracing_config?.[0]?.mode === 'Active' ? '有効' : null],
      ['環境変数', envNames.length ? envNames : envFallback],
      ['トリガー', esm ? `SQS（バッチ ${esm.values.batch_size}件 / 最大 ${esm.values.maximum_batching_window_in_seconds ?? 0}秒待ち）` : null],
      ['同時実行の上限', esm?.values.scaling_config?.[0]?.maximum_concurrency],
      ['部分失敗の報告', esm?.values.function_response_types?.includes('ReportBatchItemFailures') ? '有効' : null],
    ]),
  };
}

function dbInstance(r) {
  const v = r.values;
  const storage = v.max_allocated_storage ? `${v.allocated_storage}〜${v.max_allocated_storage} GB` : `${v.allocated_storage} GB`;
  return {
    summary: `${v.engine} ${v.engine_version ?? ''} · ${v.instance_class}${v.multi_az ? ' · Multi-AZ' : ''}`,
    settings: rows([
      ['エンジン', `${v.engine} ${v.engine_version ?? ''}`.trim()],
      ['インスタンスクラス', valueAt(r, 'instance_class')],
      ['ストレージ', `${v.storage_type ?? ''} ${storage}`.trim()],
      ['Multi-AZ', valueAt(r, 'multi_az')],
      ['暗号化', valueAt(r, 'storage_encrypted')],
      ['バックアップ保持', valueAt(r, 'backup_retention_period'), '日'],
      ['削除保護', valueAt(r, 'deletion_protection')],
      ['Performance Insights', valueAt(r, 'performance_insights_enabled')],
      ['マスターパスワード', v.manage_master_user_password ? 'Secrets Manager で管理' : null],
      ['エンドポイント', valueAt(r, 'address')],
    ]),
  };
}

function dynamoTable(r) {
  const v = r.values;
  const keys = [v.hash_key && `PK: ${v.hash_key}`, v.range_key && `SK: ${v.range_key}`].filter(Boolean).join(' / ');
  return {
    summary: `${v.billing_mode === 'PAY_PER_REQUEST' ? 'オンデマンド' : 'プロビジョンド'} · ${keys}`,
    settings: rows([
      ['キャパシティ', v.billing_mode === 'PAY_PER_REQUEST' ? 'オンデマンド' : `プロビジョンド（R ${v.read_capacity} / W ${v.write_capacity}）`],
      ['キー', keys],
      ['PITR', v.point_in_time_recovery?.[0]?.enabled],
      ['暗号化', v.server_side_encryption?.[0]?.enabled ? 'KMS' : 'AWS 所有キー'],
      ['削除保護', valueAt(r, 'deletion_protection_enabled')],
    ]),
  };
}

function s3Bucket(r, ctx) {
  const { index } = ctx;
  const versioning = referencing(index, r.address, 'aws_s3_bucket_versioning')[0]?.values.versioning_configuration?.[0]?.status;
  const sse = referencing(index, r.address, 'aws_s3_bucket_server_side_encryption_configuration')[0]?.values.rule?.[0]?.apply_server_side_encryption_by_default?.[0]?.sse_algorithm;
  const pab = referencing(index, r.address, 'aws_s3_bucket_public_access_block')[0]?.values;
  const allBlocked = pab && ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets'].every((k) => pab[k]);
  const lifecycle = referencing(index, r.address, 'aws_s3_bucket_lifecycle_configuration')[0]?.values.rule ?? [];
  const notify = referencing(index, r.address, 'aws_s3_bucket_notification')[0]?.values;
  const sseLabel = { 'aws:kms': 'SSE-KMS', AES256: 'SSE-S3' }[sse] ?? sse ?? 'SSE-S3（既定）';
  return {
    summary: [sseLabel, versioning === 'Enabled' ? 'バージョニング' : null, allBlocked ? '公開ブロック' : '⚠ 公開ブロックなし'].filter(Boolean).join(' · '),
    settings: rows([
      ['暗号化', sseLabel],
      ['バージョニング', versioning === 'Enabled' ? '有効' : '無効'],
      ['パブリックアクセス', allBlocked ? 'すべてブロック' : 'ブロック設定なし（要確認）'],
      ['ライフサイクル', lifecycle.map((l) => l.id)],
      ['イベント通知', (notify?.queue ?? []).map((q) => `${q.events.join(', ')}${q.filter_prefix ? `（${q.filter_prefix}）` : ''} → SQS`)],
    ]),
  };
}

function sqsQueue(r, ctx) {
  const v = r.values;
  const dlq = refsOfType(r.expressions.redrive_policy, ctx.index, 'aws_sqs_queue')[0];
  const maxReceive = firstMatch(codeOf(ctx.sources, r.address), /maxReceiveCount\s*=\s*(\d+)/);
  const isDlqOf = resourcesOfType(ctx.index, 'aws_sqs_queue').find((q) => refsOf(q.expressions.redrive_policy, ctx.index).includes(r.address));
  return {
    summary: [`可視性 ${seconds(v.visibility_timeout_seconds)}`, `保持 ${seconds(v.message_retention_seconds)}`, dlq ? 'DLQ あり' : isDlqOf ? 'DLQ' : null].filter(Boolean).join(' · '),
    settings: rows([
      ['種類', v.fifo_queue ? 'FIFO' : '標準'],
      ['可視性タイムアウト', seconds(valueAt(r, 'visibility_timeout_seconds'))],
      ['メッセージ保持', seconds(valueAt(r, 'message_retention_seconds'))],
      ['ロングポーリング', v.receive_wait_time_seconds ? `${v.receive_wait_time_seconds}秒` : '無効'],
      ['暗号化', v.sqs_managed_sse_enabled ? 'SQS マネージド SSE' : v.kms_master_key_id ? 'KMS' : null],
      ['DLQ', dlq ? `${stripPrefix(nameOf(ctx.index, dlq), ctx.prefix)}${maxReceive ? `（${maxReceive}回失敗で移動）` : ''}` : null],
      ['用途', isDlqOf ? `${stripPrefix(nameOf(ctx.index, isDlqOf.address), ctx.prefix)} の DLQ` : null],
    ]),
  };
}

function secret(r, ctx) {
  const rotation = referencing(ctx.index, r.address, 'aws_secretsmanager_secret_rotation')[0];
  return {
    summary: rotation ? 'ローテーションあり' : 'ローテーションなし',
    settings: rows([
      ['ローテーション', rotation ? `${rotation.values.rotation_rules?.[0]?.automatically_after_days}日ごと` : '未設定'],
      ['削除までの猶予', valueAt(r, 'recovery_window_in_days'), '日'],
    ]),
  };
}

/** アタッチしたポリシーの表示名。自作ポリシーの ARN は apply まで決まらないので、参照先の名前を使う */
function attachedPolicyName(attachment, index) {
  const arn = attachment.values.policy_arn;
  if (typeof arn === 'string' && arn) return arn;
  const policy = refsOfType(attachment.expressions.policy_arn, index, 'aws_iam_policy')[0];
  return policy ? (index.get(policy).values.name ?? policy) : null;
}

function iamRole(r, ctx) {
  const policies = referencing(ctx.index, r.address, 'aws_iam_role_policy');
  const attachments = referencing(ctx.index, r.address, 'aws_iam_role_policy_attachment');
  return {
    summary: `trust: ${(ctx.trustedBy ?? []).map((t) => t.replace('.amazonaws.com', '')).join(', ')}`,
    settings: rows([
      ['信頼するサービス', ctx.trustedBy ?? []],
      ['インラインポリシー', policies.length ? `${policies.length} 件` : null],
      ['マネージドポリシー', attachments.map((a) => attachedPolicyName(a, ctx.index)).filter(Boolean)],
      ['最大セッション', seconds(valueAt(r, 'max_session_duration'))],
    ]),
  };
}

const EXTRACTORS = Object.freeze({
  aws_vpc: vpc,
  aws_nat_gateway: natGateway,
  aws_lb: loadBalancer,
  aws_ecs_service: ecsService,
  aws_lambda_function: lambdaFunction,
  aws_db_instance: dbInstance,
  aws_dynamodb_table: dynamoTable,
  aws_s3_bucket: s3Bucket,
  aws_sqs_queue: sqsQueue,
  aws_secretsmanager_secret: secret,
  aws_iam_role: iamRole,
});

/**
 * @returns {{ summary: string, settings: Setting[] }}
 */
export function settingsOf(resource, ctx) {
  const extract = EXTRACTORS[resource.type];
  if (!extract) return { summary: '', settings: [] };
  try {
    return extract(resource, ctx);
  } catch (err) {
    // 想定外の形の plan でも図全体は出したいので、そのリソースの設定欄だけ諦める
    return { summary: '', settings: [{ label: '設定の取得に失敗', value: err.message, pending: true }] };
  }
}
