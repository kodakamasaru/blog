// 実際のコードの書き方（モジュール、for_each、dynamic、文字列の ARN、別リソースでの配線など）への対応を、
// 小さな合成の plan で確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexPlan, refsOf, allRefsOf } from './plan.mjs';
import { arnMatches, resourcesForValue } from './arn.mjs';
import { policyContext, statementsOf } from './policy.mjs';
import { resourcePolicies, rolePermissions, roleBindings } from './iam.mjs';
import { explicitFlows } from './wiring.mjs';
import { isNodeResource } from './catalog.mjs';
import { buildModel } from './model.mjs';
import { parseLocals, parseDynamics, parseModuleMapArgs, maskSecrets } from './source.mjs';

const refs = (...r) => ({ references: r });
const cfg = (address, type, expressions = {}, extra = {}) => ({ address, type, name: address.split('.').at(-1), mode: 'managed', expressions, ...extra });
const val = (address, type, values = {}, extra = {}) => ({ address, type, name: address.replace(/\[.*\]$/, '').split('.').at(-1), mode: 'managed', values, ...extra });

function makePlan({ root, planned, changes = [], variables = {} }) {
  return {
    configuration: { root_module: root, provider_config: { aws: { expressions: { region: { constant_value: 'ap-northeast-1' } } } } },
    planned_values: { root_module: { resources: planned } },
    resource_changes: changes,
    variables,
  };
}

const edgesOf = (edges) => edges.map((e) => `${e.source} -> ${e.target}`);

// ---------- 参照の解決 ----------

test('module の output と var をたどって、モジュールの外と中のリソースを結ぶ', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_s3_bucket_notification.n', 'aws_s3_bucket_notification', { queue: [{ queue_arn: refs('module.q.arn', 'module.q') }] }),
        cfg('aws_s3_bucket.b', 'aws_s3_bucket'),
      ],
      module_calls: {
        q: {
          expressions: { bucket_arn: refs('aws_s3_bucket.b.arn', 'aws_s3_bucket.b') },
          module: {
            resources: [cfg('aws_sqs_queue.this', 'aws_sqs_queue', { policy: refs('var.bucket_arn') })],
            outputs: { arn: { expression: refs('aws_sqs_queue.this[0].arn', 'aws_sqs_queue.this') } },
          },
        },
      },
    },
    planned: [val('aws_s3_bucket_notification.n', 'aws_s3_bucket_notification'), val('module.q.aws_sqs_queue.this[0]', 'aws_sqs_queue'), val('aws_s3_bucket.b', 'aws_s3_bucket')],
  });
  const index = indexPlan(plan);
  assert.deepEqual(refsOf(index.get('aws_s3_bucket_notification.n').expressions.queue[0].queue_arn, index), ['module.q.aws_sqs_queue.this[0]']);
  assert.deepEqual(refsOf(index.get('module.q.aws_sqs_queue.this[0]').expressions.policy, index), ['aws_s3_bucket.b']);
});

test('locals をソースから読んで、local 経由の参照も解決する', () => {
  const plan = makePlan({
    root: { resources: [cfg('aws_lambda_function.f', 'aws_lambda_function', { environment: [{ variables: refs('local.table') }] }), cfg('aws_dynamodb_table.t', 'aws_dynamodb_table')] },
    planned: [val('aws_lambda_function.f', 'aws_lambda_function'), val('aws_dynamodb_table.t', 'aws_dynamodb_table')],
  });
  const index = indexPlan(plan, { locals: { '': { table: ['aws_dynamodb_table.t'] } } });
  assert.deepEqual(allRefsOf(index.get('aws_lambda_function.f').expressions.environment, index), ['aws_dynamodb_table.t']);
});

test('for_each の each.value は、モジュールに渡した map のうち自分のキーの分だけを引き継ぐ', () => {
  const plan = makePlan({
    root: {
      resources: [cfg('aws_security_group.a', 'aws_security_group'), cfg('aws_security_group.b', 'aws_security_group')],
      module_calls: {
        ep: {
          expressions: { endpoints: refs('aws_security_group.a.id', 'aws_security_group.b.id') },
          module: { resources: [cfg('aws_vpc_endpoint.this', 'aws_vpc_endpoint', { security_group_ids: refs('each.value.sgs', 'each.value') }, { for_each_expression: refs('var.endpoints') })] },
        },
      },
    },
    planned: [val('aws_security_group.a', 'aws_security_group'), val('aws_security_group.b', 'aws_security_group'), val('module.ep.aws_vpc_endpoint.this["s3"]', 'aws_vpc_endpoint'), val('module.ep.aws_vpc_endpoint.this["rds"]', 'aws_vpc_endpoint')],
  });
  const moduleMapArgs = { 'module.ep': { endpoints: { s3: ['aws_security_group.a.id'], rds: ['aws_security_group.b.id'] } } };
  const index = indexPlan(plan, { moduleMapArgs });
  assert.deepEqual(refsOf(index.get('module.ep.aws_vpc_endpoint.this["s3"]').expressions.security_group_ids, index), ['aws_security_group.a']);
  assert.deepEqual(refsOf(index.get('module.ep.aws_vpc_endpoint.this["rds"]').expressions.security_group_ids, index), ['aws_security_group.b']);
});

test('var.x.key は、モジュールに渡したオブジェクトのそのキーの参照だけを引き継ぐ', () => {
  const plan = makePlan({
    root: {
      resources: [cfg('aws_api_gateway_rest_api.api', 'aws_api_gateway_rest_api'), cfg('aws_sqs_queue.q', 'aws_sqs_queue')],
      module_calls: {
        fn: {
          // plan JSON ではオブジェクトの参照がキーごとに分かれず、まとめて並ぶ
          expressions: { cfg: refs('aws_api_gateway_rest_api.api.id', 'aws_api_gateway_rest_api.api', 'aws_sqs_queue.q.arn', 'aws_sqs_queue.q') },
          module: { resources: [cfg('aws_lambda_permission.p', 'aws_lambda_permission', { source_arn: refs('var.cfg.api_id', 'var.cfg') })] },
        },
      },
    },
    planned: [val('aws_api_gateway_rest_api.api', 'aws_api_gateway_rest_api'), val('aws_sqs_queue.q', 'aws_sqs_queue'), val('module.fn.aws_lambda_permission.p', 'aws_lambda_permission')],
  });
  const moduleMapArgs = { 'module.fn': { cfg: { api_id: ['aws_api_gateway_rest_api.api.id'], queue_arn: ['aws_sqs_queue.q.arn'] } } };
  const index = indexPlan(plan, { moduleMapArgs });
  assert.deepEqual(refsOf(index.get('module.fn.aws_lambda_permission.p').expressions.source_arn, index), ['aws_api_gateway_rest_api.api']);
});

test('dynamic ブロックの参照（configuration に出ない）をソースから補う', () => {
  const plan = makePlan({
    root: { resources: [cfg('aws_ecs_service.s', 'aws_ecs_service'), cfg('aws_lb_target_group.tg', 'aws_lb_target_group')] },
    planned: [val('aws_ecs_service.s', 'aws_ecs_service'), val('aws_lb_target_group.tg', 'aws_lb_target_group')],
  });
  const index = indexPlan(plan, { dynamics: { 'aws_ecs_service.s': { load_balancer: ['aws_lb_target_group.tg.arn'] } } });
  assert.deepEqual(allRefsOf(index.get('aws_ecs_service.s').expressions.load_balancer, index), ['aws_lb_target_group.tg']);
});

test('sensitive な値はモデルに入れる前に伏せる', () => {
  const plan = makePlan({
    root: { resources: [cfg('aws_db_instance.d', 'aws_db_instance')] },
    planned: [val('aws_db_instance.d', 'aws_db_instance', { identifier: 'db', password: 'p@ssw0rd-secret' }, { sensitive_values: { password: true } })],
  });
  const model = buildModel(plan);
  assert.ok(!JSON.stringify(model).includes('p@ssw0rd-secret'));
});

test('sensitive な値がコード片にリテラルで書かれていても伏せる（属性名が password などでなくても）', () => {
  const code = 'resource "aws_ssm_parameter" "p" {\n  type  = "SecureString"\n  value = "hardcoded-s3cret"\n}';
  const plan = makePlan({
    root: { resources: [cfg('aws_ssm_parameter.p', 'aws_ssm_parameter')] },
    planned: [val('aws_ssm_parameter.p', 'aws_ssm_parameter', { name: 'p', type: 'SecureString', value: 'hardcoded-s3cret' }, { sensitive_values: { value: true } })],
  });
  const model = buildModel(plan, { 'aws_ssm_parameter.p': { file: 'main.tf', line: 1, code } });
  assert.ok(!JSON.stringify(model).includes('hardcoded-s3cret'));
  assert.match(model.sources['aws_ssm_parameter.p'].code, /value = "\*{8}"/);
  assert.match(model.sources['aws_ssm_parameter.p'].code, /type {2}= "SecureString"/);
});

// ---------- ARN とポリシー ----------

const res = (address, type, values) => ({ address, type, values, unknown: {}, expressions: {} });

test('ARN の文字列（ワイルドカード可）を、名前でリソースと突き合わせる', () => {
  assert.ok(arnMatches('arn:aws:dynamodb:*:*:table/Movies', res('t', 'aws_dynamodb_table', { name: 'Movies' })));
  assert.ok(arnMatches('arn:aws:s3:::uploads/*', res('b', 'aws_s3_bucket', { bucket: 'uploads' })));
  assert.ok(arnMatches('arn:aws:secretsmanager:us-east-1:123456789012:secret:db-*', res('s', 'aws_secretsmanager_secret', { name: 'db' })));
  assert.ok(!arnMatches('arn:aws:dynamodb:*:*:table/Other', res('t', 'aws_dynamodb_table', { name: 'Movies' })));
  assert.ok(!arnMatches('arn:aws:sqs:*:*:Movies', res('t', 'aws_dynamodb_table', { name: 'Movies' })));
});

test('環境変数の値（名前・キューの URL）からリソースを探す', () => {
  const q = res('q', 'aws_sqs_queue', { name: 'jobs' });
  assert.deepEqual(resourcesForValue('https://sqs.us-east-1.amazonaws.com/123456789012/jobs', [q]), ['q']);
  assert.deepEqual(resourcesForValue('jobs', [q]), ['q']);
  assert.deepEqual(resourcesForValue('other', [q]), []);
});

test('値が確定したポリシー JSON（ヒアドキュメントや jsonencode）を読み、Resource を名前で突き合わせる', () => {
  const plan = makePlan({
    root: { resources: [cfg('aws_iam_policy.p', 'aws_iam_policy'), cfg('aws_dynamodb_table.t', 'aws_dynamodb_table')] },
    planned: [
      val('aws_iam_policy.p', 'aws_iam_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['dynamodb:PutItem'], Resource: 'arn:aws:dynamodb:*:*:table/Movies' }] }) }),
      val('aws_dynamodb_table.t', 'aws_dynamodb_table', { name: 'Movies' }),
    ],
  });
  const index = indexPlan(plan);
  const [st] = statementsOf(index.get('aws_iam_policy.p'), 'policy', policyContext(index));
  assert.deepEqual(st.actions, ['dynamodb:PutItem']);
  assert.deepEqual(st.resources, ['aws_dynamodb_table.t']);
});

test('aws_iam_policy をロールにアタッチした権限と、AWS 管理ポリシーを読む', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_iam_role.r', 'aws_iam_role'),
        cfg('aws_iam_policy.p', 'aws_iam_policy'),
        cfg('aws_iam_role_policy_attachment.a', 'aws_iam_role_policy_attachment', { role: refs('aws_iam_role.r.name', 'aws_iam_role.r'), policy_arn: refs('aws_iam_policy.p.arn', 'aws_iam_policy.p') }),
        cfg('aws_iam_role_policy_attachment.m', 'aws_iam_role_policy_attachment', { role: refs('aws_iam_role.r.name', 'aws_iam_role.r'), policy_arn: { constant_value: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess' } }),
        cfg('aws_s3_bucket.b', 'aws_s3_bucket'),
      ],
    },
    planned: [
      val('aws_iam_role.r', 'aws_iam_role', { name: 'r' }),
      val('aws_iam_policy.p', 'aws_iam_policy', { policy: JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::data/*' }] }) }),
      val('aws_iam_role_policy_attachment.a', 'aws_iam_role_policy_attachment'),
      val('aws_iam_role_policy_attachment.m', 'aws_iam_role_policy_attachment', { policy_arn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess' }),
      val('aws_s3_bucket.b', 'aws_s3_bucket', { bucket: 'data' }),
    ],
  });
  const index = indexPlan(plan);
  const targets = rolePermissions(index, policyContext(index)).map((p) => p.target);
  assert.ok(targets.includes('aws_s3_bucket.b'));
  assert.ok(targets.includes('managed:AmazonS3ReadOnlyAccess'));
});

test('ノードの要約に null / undefined を出さない（イメージの Lambda、キャパシティープロバイダーの ECS、データソースのタスク定義）', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_lambda_function.img', 'aws_lambda_function'),
        cfg('aws_ecs_task_definition.api', 'aws_ecs_task_definition'),
        { ...cfg('data.aws_ecs_task_definition.latest', 'aws_ecs_task_definition'), mode: 'data' },
        cfg('aws_ecs_service.api', 'aws_ecs_service', { task_definition: refs('data.aws_ecs_task_definition.latest.arn', 'data.aws_ecs_task_definition.latest') }),
      ],
    },
    planned: [
      val('aws_lambda_function.img', 'aws_lambda_function', { function_name: 'img', package_type: 'Image', runtime: null, memory_size: 512, timeout: 60 }),
      val('aws_ecs_task_definition.api', 'aws_ecs_task_definition', { family: 'api-stg', cpu: '512', memory: '1024' }),
      { ...val('data.aws_ecs_task_definition.latest', 'aws_ecs_task_definition', { task_definition: 'api-stg' }), mode: 'data' },
      val('aws_ecs_service.api', 'aws_ecs_service', { name: 'api', launch_type: null, capacity_provider_strategy: [{ capacity_provider: 'FARGATE_SPOT' }], desired_count: 1 }),
    ],
  });
  const nodes = buildModel(plan).nodes;
  const summaryOf = (id) => nodes.find((n) => n.id === id).summary;
  assert.equal(summaryOf('aws_lambda_function.img'), 'コンテナイメージ · x86_64 · 512MB / 60秒');
  assert.equal(summaryOf('aws_ecs_service.api'), 'FARGATE_SPOT · 0.5 vCPU / 1 GB · ×1');
});

test('ロールの設定欄のマネージドポリシーは、ARN が未確定の自作ポリシーを名前で出す', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_iam_role.r', 'aws_iam_role'),
        cfg('aws_iam_policy.p', 'aws_iam_policy'),
        cfg('aws_iam_role_policy_attachment.a', 'aws_iam_role_policy_attachment', { role: refs('aws_iam_role.r.name', 'aws_iam_role.r'), policy_arn: refs('aws_iam_policy.p.arn', 'aws_iam_policy.p') }),
        cfg('aws_iam_role_policy_attachment.m', 'aws_iam_role_policy_attachment', { role: refs('aws_iam_role.r.name', 'aws_iam_role.r'), policy_arn: { constant_value: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess' } }),
      ],
    },
    planned: [
      val('aws_iam_role.r', 'aws_iam_role', { name: 'r' }),
      val('aws_iam_policy.p', 'aws_iam_policy', { name: 'sqs-read-write' }),
      val('aws_iam_role_policy_attachment.a', 'aws_iam_role_policy_attachment'),
      val('aws_iam_role_policy_attachment.m', 'aws_iam_role_policy_attachment', { policy_arn: 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess' }),
    ],
  });
  const role = buildModel(plan).nodes.find((n) => n.id === 'aws_iam_role.r');
  const row = role.settings.find((s) => s.label === 'マネージドポリシー');
  assert.equal(row.value, 'sqs-read-write, arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess');
});

test('Lambda の実行許可（aws_lambda_permission）から、誰が呼べるかを読む', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_lambda_function.f', 'aws_lambda_function'),
        cfg('aws_sns_topic.t', 'aws_sns_topic'),
        cfg('aws_lambda_permission.p', 'aws_lambda_permission', { function_name: refs('aws_lambda_function.f.function_name', 'aws_lambda_function.f'), source_arn: refs('aws_sns_topic.t.arn', 'aws_sns_topic.t') }),
      ],
    },
    planned: [val('aws_lambda_function.f', 'aws_lambda_function'), val('aws_sns_topic.t', 'aws_sns_topic'), val('aws_lambda_permission.p', 'aws_lambda_permission', { principal: 'sns.amazonaws.com', action: 'lambda:InvokeFunction' })],
  });
  const index = indexPlan(plan);
  const [rp] = resourcePolicies(index, policyContext(index));
  assert.equal(rp.owner, 'aws_lambda_function.f');
  assert.deepEqual(rp.callers, ['aws_sns_topic.t']);
});

// ---------- 別リソースで書かれた配線 ----------

test('API Gateway の統合、SNS のサブスクリプション、EventBridge のターゲットを流れにする', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_apigatewayv2_api.api', 'aws_apigatewayv2_api'),
        cfg('aws_lambda_function.f', 'aws_lambda_function'),
        cfg('aws_apigatewayv2_integration.i', 'aws_apigatewayv2_integration', { api_id: refs('aws_apigatewayv2_api.api.id', 'aws_apigatewayv2_api.api'), integration_uri: refs('aws_lambda_function.f.invoke_arn', 'aws_lambda_function.f') }),
        cfg('aws_sns_topic.t', 'aws_sns_topic'),
        cfg('aws_sns_topic_subscription.s', 'aws_sns_topic_subscription', { topic_arn: refs('aws_sns_topic.t.arn', 'aws_sns_topic.t'), endpoint: refs('aws_lambda_function.f.arn', 'aws_lambda_function.f') }),
        cfg('aws_cloudwatch_event_rule.r', 'aws_cloudwatch_event_rule'),
        cfg('aws_cloudwatch_event_target.et', 'aws_cloudwatch_event_target', { rule: refs('aws_cloudwatch_event_rule.r.name', 'aws_cloudwatch_event_rule.r'), arn: refs('aws_sns_topic.t.arn', 'aws_sns_topic.t') }),
      ],
    },
    planned: ['aws_apigatewayv2_api.api', 'aws_lambda_function.f', 'aws_apigatewayv2_integration.i', 'aws_sns_topic.t', 'aws_sns_topic_subscription.s', 'aws_cloudwatch_event_rule.r', 'aws_cloudwatch_event_target.et'].map((a) =>
      val(a, a.split('.')[0], a.includes('subscription') ? { protocol: 'lambda' } : {}),
    ),
  });
  const edges = edgesOf(explicitFlows(indexPlan(plan)));
  assert.ok(edges.includes('internet -> aws_apigatewayv2_api.api'));
  assert.ok(edges.includes('aws_apigatewayv2_api.api -> aws_lambda_function.f'));
  assert.ok(edges.includes('aws_sns_topic.t -> aws_lambda_function.f'));
  assert.ok(edges.includes('aws_cloudwatch_event_rule.r -> aws_sns_topic.t'));
});

test('EventBridge Scheduler のユニバーサルターゲットは、input に書いた名前や参照から呼び出し先を探す', () => {
  const universal = (address, action, input, inputRefs = []) =>
    [
      cfg(address, 'aws_scheduler_schedule', { target: [{ arn: { constant_value: `arn:aws:scheduler:::aws-sdk:${action}` }, input: inputRefs.length ? refs(...inputRefs) : { constant_value: input } }] }),
      val(address, 'aws_scheduler_schedule', { schedule_expression: 'cron(0 9 * * ? *)', target: [{ arn: `arn:aws:scheduler:::aws-sdk:${action}`, input }] }),
    ];
  const stopDb = universal('aws_scheduler_schedule.stop_db', 'rds:stopDBInstance', JSON.stringify({ DbInstanceIdentifier: 'main-db' }));
  const scaleIn = universal('aws_scheduler_schedule.scale_in', 'ecs:updateService', JSON.stringify({ Cluster: 'c', Service: 'api', DesiredCount: 0 }));
  const stopEc2 = universal('aws_scheduler_schedule.stop_ec2', 'ec2:stopInstances', undefined, ['aws_instance.bastion.id', 'aws_instance.bastion']);
  const plan = makePlan({
    root: { resources: [cfg('aws_db_instance.d', 'aws_db_instance'), cfg('aws_ecs_service.s', 'aws_ecs_service'), cfg('aws_instance.bastion', 'aws_instance'), stopDb[0], scaleIn[0], stopEc2[0]] },
    planned: [val('aws_db_instance.d', 'aws_db_instance', { identifier: 'main-db' }), val('aws_ecs_service.s', 'aws_ecs_service', { name: 'api' }), val('aws_instance.bastion', 'aws_instance'), stopDb[1], scaleIn[1], stopEc2[1]],
  });
  const flows = explicitFlows(indexPlan(plan));
  const edges = edgesOf(flows);
  assert.ok(edges.includes('aws_scheduler_schedule.stop_db -> aws_db_instance.d'));
  assert.ok(edges.includes('aws_scheduler_schedule.scale_in -> aws_ecs_service.s'));
  assert.ok(edges.includes('aws_scheduler_schedule.stop_ec2 -> aws_instance.bastion'));
  // 呼び出す API が分かるようにラベルに入れる
  assert.match(flows.find((e) => e.source === 'aws_scheduler_schedule.stop_db').labels.join(), /rds:stopDBInstance/);
});

test('Step Functions の定義に文字列で書いた Lambda の ARN（:$LATEST 付き）をタスクの流れにする', () => {
  const definition = JSON.stringify({
    StartAt: 'Compress',
    States: { Compress: { Type: 'Task', Resource: 'arn:aws:states:::lambda:invoke', Parameters: { FunctionName: 'arn:aws:lambda:ap-northeast-1:123456789012:function:compress-stg:$LATEST' }, End: true } },
  });
  const plan = makePlan({
    root: { resources: [cfg('aws_lambda_function.compress', 'aws_lambda_function'), cfg('aws_lambda_function.other', 'aws_lambda_function'), cfg('aws_sfn_state_machine.sm', 'aws_sfn_state_machine')] },
    planned: [
      val('aws_lambda_function.compress', 'aws_lambda_function', { function_name: 'compress-stg' }),
      val('aws_lambda_function.other', 'aws_lambda_function', { function_name: 'compress-stg-v2' }),
      val('aws_sfn_state_machine.sm', 'aws_sfn_state_machine', { name: 'sm', definition }),
    ],
  });
  const edges = edgesOf(explicitFlows(indexPlan(plan)));
  assert.ok(edges.includes('aws_sfn_state_machine.sm -> aws_lambda_function.compress'));
  assert.ok(!edges.includes('aws_sfn_state_machine.sm -> aws_lambda_function.other'));
});

test('jsonencode に未確定の値が混ざって plan で読めないときは、ソースの文字列（${} はワイルドカード）から推定する', () => {
  const sfnCode = [
    'resource "aws_sfn_state_machine" "sm" {',
    '  name = "sm-${var.env}"',
    '  definition = jsonencode({',
    '    States = { Compress = { Parameters = {',
    '      FunctionName = "arn:aws:lambda:ap-northeast-1:${var.account}:function:compress-${var.env}:$LATEST"',
    '      SecurityGroups = [var.sg_id]',
    '    } } }',
    '  })',
    '}',
  ].join('\n');
  const schedCode = [
    'resource "aws_scheduler_schedule" "scale_in" {',
    '  name = "scale-in-api-${var.env}"',
    '  target {',
    '    arn = "arn:aws:scheduler:::aws-sdk:ecs:updateService"',
    '    input = jsonencode({',
    '      Cluster = var.cluster_arn',
    '      Service = "api-${var.env}"',
    '    })',
    '  }',
    '}',
  ].join('\n');
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_lambda_function.compress', 'aws_lambda_function'),
        cfg('aws_lambda_function.notify', 'aws_lambda_function'),
        cfg('aws_ecs_service.api', 'aws_ecs_service'),
        cfg('aws_lambda_function.api', 'aws_lambda_function'),
        cfg('aws_sfn_state_machine.sm', 'aws_sfn_state_machine'),
        cfg('aws_scheduler_schedule.scale_in', 'aws_scheduler_schedule', { target: [{ arn: { constant_value: 'arn:aws:scheduler:::aws-sdk:ecs:updateService' } }] }),
      ],
    },
    planned: [
      val('aws_lambda_function.compress', 'aws_lambda_function', { function_name: 'compress-stg' }),
      val('aws_lambda_function.notify', 'aws_lambda_function', { function_name: 'notify-stg' }),
      val('aws_ecs_service.api', 'aws_ecs_service', { name: 'api-stg' }),
      // ECS サービスと同じ名前の Lambda（ecs:updateService の行き先ではない）
      val('aws_lambda_function.api', 'aws_lambda_function', { function_name: 'api-stg' }),
      val('aws_sfn_state_machine.sm', 'aws_sfn_state_machine', { name: 'sm-stg' }),
      val('aws_scheduler_schedule.scale_in', 'aws_scheduler_schedule', { name: 'scale-in-api-stg', target: [{ arn: 'arn:aws:scheduler:::aws-sdk:ecs:updateService' }] }),
    ],
    changes: [
      { address: 'aws_sfn_state_machine.sm', change: { after_unknown: { definition: true } } },
      { address: 'aws_scheduler_schedule.scale_in', change: { after_unknown: { target: [{ input: true }] } } },
    ],
  });
  const sources = {
    'aws_sfn_state_machine.sm': { file: 'main.tf', line: 1, code: sfnCode },
    'aws_scheduler_schedule.scale_in': { file: 'main.tf', line: 20, code: schedCode },
  };
  const flows = explicitFlows(indexPlan(plan), sources);
  const edges = edgesOf(flows);
  assert.ok(edges.includes('aws_sfn_state_machine.sm -> aws_lambda_function.compress'));
  assert.ok(!edges.includes('aws_sfn_state_machine.sm -> aws_lambda_function.notify'));
  assert.ok(edges.includes('aws_scheduler_schedule.scale_in -> aws_ecs_service.api'));
  assert.ok(!edges.includes('aws_scheduler_schedule.scale_in -> aws_lambda_function.api'));
  // 推定であることが根拠に出る
  assert.ok(flows.find((e) => e.target === 'aws_lambda_function.compress').evidence.some((ev) => /推定/.test(ev.text)));
});

test('ログのパイプライン: Lambda のロググループのサブスクリプション → Firehose（変換 Lambda）→ S3', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_lambda_function.api', 'aws_lambda_function'),
        cfg('aws_lambda_function.transformer', 'aws_lambda_function'),
        cfg('aws_s3_bucket.audit', 'aws_s3_bucket'),
        cfg('aws_cloudwatch_log_group.api', 'aws_cloudwatch_log_group'),
        cfg('aws_kinesis_firehose_delivery_stream.f', 'aws_kinesis_firehose_delivery_stream', {
          extended_s3_configuration: [{
            bucket_arn: refs('aws_s3_bucket.audit.arn', 'aws_s3_bucket.audit'),
            processing_configuration: [{ processors: [{ parameters: [{ parameter_value: refs('aws_lambda_function.transformer.arn', 'aws_lambda_function.transformer') }] }] }],
          }],
        }),
        cfg('aws_cloudwatch_log_subscription_filter.audit', 'aws_cloudwatch_log_subscription_filter', {
          log_group_name: refs('aws_cloudwatch_log_group.api.name', 'aws_cloudwatch_log_group.api'),
          destination_arn: refs('aws_kinesis_firehose_delivery_stream.f.arn', 'aws_kinesis_firehose_delivery_stream.f'),
        }),
      ],
    },
    planned: [
      val('aws_lambda_function.api', 'aws_lambda_function', { function_name: 'api-stg' }),
      val('aws_lambda_function.transformer', 'aws_lambda_function', { function_name: 'transformer-stg' }),
      val('aws_s3_bucket.audit', 'aws_s3_bucket', { bucket: 'audit' }),
      val('aws_cloudwatch_log_group.api', 'aws_cloudwatch_log_group', { name: '/aws/lambda/api-stg' }),
      val('aws_kinesis_firehose_delivery_stream.f', 'aws_kinesis_firehose_delivery_stream', { name: 'f' }),
      val('aws_cloudwatch_log_subscription_filter.audit', 'aws_cloudwatch_log_subscription_filter', { filter_pattern: 'audit_log' }),
    ],
  });
  const edges = edgesOf(explicitFlows(indexPlan(plan)));
  assert.ok(edges.includes('aws_lambda_function.api -> aws_kinesis_firehose_delivery_stream.f'));
  assert.ok(edges.includes('aws_kinesis_firehose_delivery_stream.f -> aws_lambda_function.transformer'));
  assert.ok(edges.includes('aws_kinesis_firehose_delivery_stream.f -> aws_s3_bucket.audit'));
});

test('コンテナイメージ: ECR → Lambda / ECS サービス / サービスに属さない ECS タスク の線', () => {
  const ecrUrl = (name) => refs(`aws_ecr_repository.${name}.repository_url`, `aws_ecr_repository.${name}`);
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_ecr_repository.fn', 'aws_ecr_repository'),
        cfg('aws_ecr_repository.api', 'aws_ecr_repository'),
        cfg('aws_ecr_repository.migrator', 'aws_ecr_repository'),
        cfg('aws_lambda_function.fn', 'aws_lambda_function', { image_uri: ecrUrl('fn') }),
        cfg('aws_ecs_task_definition.api', 'aws_ecs_task_definition', { container_definitions: ecrUrl('api') }),
        cfg('aws_ecs_task_definition.migrator', 'aws_ecs_task_definition', { container_definitions: ecrUrl('migrator') }),
        cfg('aws_ecs_service.api', 'aws_ecs_service', { task_definition: refs('aws_ecs_task_definition.api.arn', 'aws_ecs_task_definition.api') }),
        cfg('aws_sfn_state_machine.sm', 'aws_sfn_state_machine'),
      ],
    },
    planned: [
      val('aws_ecr_repository.fn', 'aws_ecr_repository', { name: 'fn' }),
      val('aws_ecr_repository.api', 'aws_ecr_repository', { name: 'api' }),
      val('aws_ecr_repository.migrator', 'aws_ecr_repository', { name: 'migrator' }),
      val('aws_lambda_function.fn', 'aws_lambda_function', { function_name: 'fn' }),
      val('aws_ecs_task_definition.api', 'aws_ecs_task_definition', { family: 'api-stg' }),
      val('aws_ecs_task_definition.migrator', 'aws_ecs_task_definition', { family: 'migrator-stg' }),
      val('aws_ecs_service.api', 'aws_ecs_service', { name: 'api' }),
      // 単発タスクは Step Functions から ARN の文字列で起動される
      val('aws_sfn_state_machine.sm', 'aws_sfn_state_machine', {
        name: 'sm',
        definition: JSON.stringify({ States: { Run: { Resource: 'arn:aws:states:::ecs:runTask.sync', Parameters: { TaskDefinition: 'arn:aws:ecs:ap-northeast-1:123456789012:task-definition/migrator-stg' } } } }),
      }),
    ],
  });
  const index = indexPlan(plan);
  // サービスが使うタスク定義はサービスの中身なのでノードにせず、単発のものだけノードにする
  assert.equal(isNodeResource(index.get('aws_ecs_task_definition.api')), false);
  assert.equal(isNodeResource(index.get('aws_ecs_task_definition.migrator')), true);
  const edges = edgesOf(explicitFlows(index));
  assert.ok(edges.includes('aws_ecr_repository.fn -> aws_lambda_function.fn'));
  assert.ok(edges.includes('aws_ecr_repository.api -> aws_ecs_service.api'));
  assert.ok(edges.includes('aws_ecr_repository.migrator -> aws_ecs_task_definition.migrator'));
  assert.ok(edges.includes('aws_sfn_state_machine.sm -> aws_ecs_task_definition.migrator'));
});

test('S3 のイベント通知の bucket が参照ではなくバケット名の文字列でも、名前でバケットを探す', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_s3_bucket.media', 'aws_s3_bucket'),
        cfg('aws_lambda_function.invoker', 'aws_lambda_function'),
        cfg('aws_s3_bucket_notification.n', 'aws_s3_bucket_notification', {
          bucket: refs('var.trigger_bucket_name'),
          lambda_function: [{ lambda_function_arn: refs('aws_lambda_function.invoker.arn', 'aws_lambda_function.invoker') }],
        }),
      ],
    },
    planned: [
      val('aws_s3_bucket.media', 'aws_s3_bucket', { bucket: 'media-stg' }),
      val('aws_lambda_function.invoker', 'aws_lambda_function', { function_name: 'invoker' }),
      val('aws_s3_bucket_notification.n', 'aws_s3_bucket_notification', { bucket: 'media-stg', lambda_function: [{ events: ['s3:ObjectCreated:*'] }] }),
    ],
  });
  assert.ok(edgesOf(explicitFlows(indexPlan(plan))).includes('aws_s3_bucket.media -> aws_lambda_function.invoker'));
});

test('Resource:* の許可でも、接続先を環境変数で参照していれば「参照あり」の推定線にする（参照が無ければ線にしない）', () => {
  const smArn = 'arn:aws:states:ap-northeast-1:123456789012:stateMachine:media-stg';
  const policy = JSON.stringify({ Statement: [{ Effect: 'Allow', Action: ['states:StartExecution', 'sqs:SendMessage'], Resource: '*' }] });
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_iam_role.r', 'aws_iam_role'),
        cfg('aws_iam_role_policy.p', 'aws_iam_role_policy', { role: refs('aws_iam_role.r.id', 'aws_iam_role.r') }),
        cfg('aws_lambda_function.invoker', 'aws_lambda_function', { role: refs('aws_iam_role.r.arn', 'aws_iam_role.r') }),
        cfg('aws_iam_role.other', 'aws_iam_role'),
        cfg('aws_iam_role_policy.other', 'aws_iam_role_policy', { role: refs('aws_iam_role.other.id', 'aws_iam_role.other') }),
        cfg('aws_lambda_function.other', 'aws_lambda_function', { role: refs('aws_iam_role.other.arn', 'aws_iam_role.other') }),
        cfg('aws_sfn_state_machine.sm', 'aws_sfn_state_machine'),
        cfg('aws_sqs_queue.q', 'aws_sqs_queue'),
      ],
    },
    planned: [
      val('aws_iam_role.r', 'aws_iam_role', { name: 'r' }),
      val('aws_iam_role_policy.p', 'aws_iam_role_policy', { policy }),
      val('aws_lambda_function.invoker', 'aws_lambda_function', { function_name: 'invoker', environment: [{ variables: { STATE_MACHINE_ARN: smArn } }] }),
      val('aws_iam_role.other', 'aws_iam_role', { name: 'other' }),
      val('aws_iam_role_policy.other', 'aws_iam_role_policy', { policy }),
      val('aws_lambda_function.other', 'aws_lambda_function', { function_name: 'other' }),
      val('aws_sfn_state_machine.sm', 'aws_sfn_state_machine', { name: 'media-stg', arn: smArn }),
      val('aws_sqs_queue.q', 'aws_sqs_queue', { name: 'q' }),
    ],
  });
  const data = buildModel(plan).views.data.edges;
  const toSm = data.find((e) => e.source === 'aws_lambda_function.invoker' && e.target === 'aws_sfn_state_machine.sm');
  assert.ok(toSm, 'invoker -> sm');
  assert.equal(toSm.strength, 'referenced');
  // 参照していない相手（SQS）や、参照していない関数（other）には線を引かない
  assert.ok(!edgesOf(data).includes('aws_lambda_function.invoker -> aws_sqs_queue.q'));
  assert.ok(!edgesOf(data).includes('aws_lambda_function.other -> aws_sfn_state_machine.sm'));
});

test('ロールを使う側: Scheduler の target.role_arn と、データソースで最新のタスク定義を引く ECS サービス', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_iam_role.task', 'aws_iam_role'),
        cfg('aws_iam_role.sched', 'aws_iam_role'),
        cfg('aws_ecs_task_definition.api', 'aws_ecs_task_definition', { task_role_arn: refs('aws_iam_role.task.arn', 'aws_iam_role.task') }),
        // GitHub Actions からデプロイするため、サービスはデータソースで最新のリビジョンを参照する
        { ...cfg('data.aws_ecs_task_definition.latest', 'aws_ecs_task_definition'), mode: 'data' },
        cfg('aws_ecs_service.api', 'aws_ecs_service', { task_definition: refs('data.aws_ecs_task_definition.latest.arn', 'data.aws_ecs_task_definition.latest') }),
        cfg('aws_scheduler_schedule.s', 'aws_scheduler_schedule', { target: [{ role_arn: refs('aws_iam_role.sched.arn', 'aws_iam_role.sched') }] }),
      ],
    },
    planned: [
      val('aws_iam_role.task', 'aws_iam_role', { name: 'task' }),
      val('aws_iam_role.sched', 'aws_iam_role', { name: 'sched' }),
      val('aws_ecs_task_definition.api', 'aws_ecs_task_definition', { family: 'api-stg' }),
      { ...val('data.aws_ecs_task_definition.latest', 'aws_ecs_task_definition', { task_definition: 'api-stg' }), mode: 'data' },
      val('aws_ecs_service.api', 'aws_ecs_service', { name: 'api' }),
      val('aws_scheduler_schedule.s', 'aws_scheduler_schedule', { name: 's' }),
    ],
  });
  const bindings = roleBindings(indexPlan(plan)).map((b) => `${b.compute} -> ${b.role}`);
  assert.ok(bindings.includes('aws_ecs_service.api -> aws_iam_role.task'));
  assert.ok(bindings.includes('aws_scheduler_schedule.s -> aws_iam_role.sched'));
});

test('Tier タグの無いサブネットは、名前の末尾の AZ（_1a / -c など）を落とした名前でまとめる', () => {
  const vpcRef = refs('aws_vpc.v.id', 'aws_vpc.v');
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_vpc.v', 'aws_vpc'),
        cfg('aws_subnet.private_1a', 'aws_subnet', { vpc_id: vpcRef }),
        cfg('aws_subnet.private_1c', 'aws_subnet', { vpc_id: vpcRef }),
        cfg('aws_subnet.db', 'aws_subnet', { vpc_id: vpcRef }),
        cfg('aws_lambda_function.fn', 'aws_lambda_function', { vpc_config: [{ subnet_ids: refs('aws_subnet.private_1a.id', 'aws_subnet.private_1a', 'aws_subnet.private_1c.id', 'aws_subnet.private_1c') }] }),
      ],
    },
    planned: [
      val('aws_vpc.v', 'aws_vpc', { cidr_block: '10.0.0.0/16' }),
      val('aws_subnet.private_1a', 'aws_subnet', { cidr_block: '10.0.1.0/24', availability_zone: 'ap-northeast-1a' }),
      val('aws_subnet.private_1c', 'aws_subnet', { cidr_block: '10.0.2.0/24', availability_zone: 'ap-northeast-1c' }),
      val('aws_subnet.db', 'aws_subnet', { cidr_block: '10.0.3.0/24' }),
      val('aws_lambda_function.fn', 'aws_lambda_function', { function_name: 'fn' }),
    ],
  });
  const { parents } = buildModel(plan).views.network;
  // 2つの AZ にまたがる Lambda も、まとめた「private」の枠に入る
  assert.equal(parents['aws_lambda_function.fn'], 'tier:aws_vpc.v:private');
  // AZ らしい末尾が無い名前（db）はそのまま
  assert.equal(parents['tier:aws_vpc.v:db'], 'aws_vpc.v');
});

test('NAT インスタンス: network_interface_id へのルートと、NAT インスタンスから IGW へ出ていく線', () => {
  const vpcRef = refs('aws_vpc.v.id', 'aws_vpc.v');
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_vpc.v', 'aws_vpc'),
        cfg('aws_internet_gateway.igw', 'aws_internet_gateway', { vpc_id: vpcRef }),
        cfg('aws_subnet.pub', 'aws_subnet', { vpc_id: vpcRef }),
        cfg('aws_subnet.priv', 'aws_subnet', { vpc_id: vpcRef }),
        cfg('aws_instance.nat', 'aws_instance', { subnet_id: refs('aws_subnet.pub.id', 'aws_subnet.pub') }),
        cfg('aws_route_table.pub', 'aws_route_table', { vpc_id: vpcRef, route: [{ cidr_block: { constant_value: '0.0.0.0/0' }, gateway_id: refs('aws_internet_gateway.igw.id', 'aws_internet_gateway.igw') }] }),
        cfg('aws_route_table.priv', 'aws_route_table', { vpc_id: vpcRef, route: [{ cidr_block: { constant_value: '0.0.0.0/0' }, network_interface_id: refs('aws_instance.nat.primary_network_interface_id', 'aws_instance.nat') }] }),
        cfg('aws_route_table_association.pub', 'aws_route_table_association', { subnet_id: refs('aws_subnet.pub.id', 'aws_subnet.pub'), route_table_id: refs('aws_route_table.pub.id', 'aws_route_table.pub') }),
        cfg('aws_route_table_association.priv', 'aws_route_table_association', { subnet_id: refs('aws_subnet.priv.id', 'aws_subnet.priv'), route_table_id: refs('aws_route_table.priv.id', 'aws_route_table.priv') }),
      ],
    },
    planned: [
      val('aws_vpc.v', 'aws_vpc', { cidr_block: '10.0.0.0/16' }),
      val('aws_internet_gateway.igw', 'aws_internet_gateway'),
      val('aws_subnet.pub', 'aws_subnet', { cidr_block: '10.0.1.0/24', tags: { Tier: 'public' } }),
      val('aws_subnet.priv', 'aws_subnet', { cidr_block: '10.0.2.0/24', tags: { Tier: 'private' } }),
      val('aws_instance.nat', 'aws_instance', { source_dest_check: false }),
      val('aws_route_table.pub', 'aws_route_table'),
      val('aws_route_table.priv', 'aws_route_table'),
      val('aws_route_table_association.pub', 'aws_route_table_association'),
      val('aws_route_table_association.priv', 'aws_route_table_association'),
    ],
  });
  const edges = edgesOf(buildModel(plan).views.network.edges);
  assert.ok(edges.includes('tier:aws_vpc.v:private -> aws_instance.nat'));
  assert.ok(edges.includes('aws_instance.nat -> aws_internet_gateway.igw'));
});

test('AWS Batch: ジョブキュー → 実行環境の流れと、実行環境の SG から DB への通信', () => {
  const plan = makePlan({
    root: {
      resources: [
        cfg('aws_vpc.v', 'aws_vpc'),
        cfg('aws_security_group.batch', 'aws_security_group', { vpc_id: refs('aws_vpc.v.id', 'aws_vpc.v') }),
        cfg('aws_security_group.db', 'aws_security_group', { vpc_id: refs('aws_vpc.v.id', 'aws_vpc.v') }),
        cfg('aws_vpc_security_group_ingress_rule.db', 'aws_vpc_security_group_ingress_rule', { security_group_id: refs('aws_security_group.db.id', 'aws_security_group.db'), referenced_security_group_id: refs('aws_security_group.batch.id', 'aws_security_group.batch') }),
        cfg('aws_db_instance.d', 'aws_db_instance', { vpc_security_group_ids: refs('aws_security_group.db.id', 'aws_security_group.db') }),
        cfg('aws_batch_compute_environment.fargate', 'aws_batch_compute_environment', { compute_resources: [{ security_group_ids: refs('aws_security_group.batch.id', 'aws_security_group.batch') }] }),
        cfg('aws_batch_job_queue.q', 'aws_batch_job_queue', { compute_environment_order: [{ compute_environment: refs('aws_batch_compute_environment.fargate.arn', 'aws_batch_compute_environment.fargate') }] }),
      ],
    },
    planned: [
      val('aws_vpc.v', 'aws_vpc', { cidr_block: '10.0.0.0/16' }),
      val('aws_security_group.batch', 'aws_security_group'),
      val('aws_security_group.db', 'aws_security_group'),
      val('aws_vpc_security_group_ingress_rule.db', 'aws_vpc_security_group_ingress_rule', { ip_protocol: 'tcp', from_port: 5432, to_port: 5432 }),
      val('aws_db_instance.d', 'aws_db_instance', { identifier: 'd' }),
      val('aws_batch_compute_environment.fargate', 'aws_batch_compute_environment', { name: 'fargate' }),
      val('aws_batch_job_queue.q', 'aws_batch_job_queue', { name: 'q' }),
    ],
    changes: [{ address: 'aws_vpc_security_group_ingress_rule.db', change: { after_unknown: { referenced_security_group_id: true } } }],
  });
  const model = buildModel(plan);
  assert.ok(edgesOf(model.views.data.edges).includes('aws_batch_job_queue.q -> aws_batch_compute_environment.fargate'));
  assert.ok(edgesOf(model.views.network.edges).includes('aws_batch_compute_environment.fargate -> aws_db_instance.d'));
});

// ---------- NW: SG の書き方 ----------

function sgPlan(extraRoot = [], extraPlanned = []) {
  return makePlan({
    root: {
      resources: [
        cfg('aws_vpc.v', 'aws_vpc'),
        cfg('aws_subnet.app', 'aws_subnet', { vpc_id: refs('aws_vpc.v.id', 'aws_vpc.v') }),
        cfg('aws_security_group.app', 'aws_security_group', { vpc_id: refs('aws_vpc.v.id', 'aws_vpc.v') }),
        cfg('aws_security_group.db', 'aws_security_group', { vpc_id: refs('aws_vpc.v.id', 'aws_vpc.v'), ingress: refs('aws_security_group.app.id', 'aws_security_group.app') }),
        cfg('aws_instance.app', 'aws_instance', { subnet_id: refs('aws_subnet.app.id', 'aws_subnet.app'), vpc_security_group_ids: refs('aws_security_group.app.id', 'aws_security_group.app') }),
        cfg('aws_db_instance.db', 'aws_db_instance', { vpc_security_group_ids: refs('aws_security_group.db.id', 'aws_security_group.db') }),
        ...extraRoot,
      ],
    },
    planned: [
      val('aws_vpc.v', 'aws_vpc', { cidr_block: '10.0.0.0/16' }),
      val('aws_subnet.app', 'aws_subnet', { cidr_block: '10.0.1.0/24', tags: { Tier: 'app' } }),
      val('aws_security_group.app', 'aws_security_group'),
      val('aws_security_group.db', 'aws_security_group', {
        ingress: [
          { protocol: 'tcp', from_port: 5432, to_port: 5432, cidr_blocks: [], security_groups: [] },
          { protocol: 'tcp', from_port: 3306, to_port: 3306, cidr_blocks: ['10.0.1.0/24'], security_groups: [] },
        ],
      }),
      val('aws_instance.app', 'aws_instance'),
      val('aws_db_instance.db', 'aws_db_instance', { identifier: 'db' }),
      ...extraPlanned,
    ],
    changes: [{ address: 'aws_security_group.db', change: { after_unknown: { ingress: [{ security_groups: true }, {}] } } }],
  });
}

test('aws_security_group の中の ingress ブロック（inline のルール）を読む', () => {
  const model = buildModel(sgPlan());
  assert.ok(edgesOf(model.views.network.edges).includes('aws_instance.app -> aws_db_instance.db'));
});

test('CIDR で許可したルールは、その CIDR を含むサブネット層からの通信にする', () => {
  const model = buildModel(sgPlan());
  const edge = model.views.network.edges.find((e) => e.target === 'aws_db_instance.db' && e.source === 'tier:aws_vpc.v:app');
  assert.equal(edge?.label, 'tcp/3306');
});

test('参照先に SG が出てきても、plan の値が null と確定していれば SG からの許可にしない', () => {
  const rule = cfg('aws_vpc_security_group_ingress_rule.r', 'aws_vpc_security_group_ingress_rule', {
    security_group_id: refs('aws_security_group.db.id', 'aws_security_group.db'),
    referenced_security_group_id: refs('aws_security_group.app.id', 'aws_security_group.app'),
  });
  const ruleValue = val('aws_vpc_security_group_ingress_rule.r', 'aws_vpc_security_group_ingress_rule', { referenced_security_group_id: null, cidr_ipv4: '192.168.0.0/16', ip_protocol: 'tcp', from_port: 22, to_port: 22 });
  const model = buildModel(sgPlan([rule], [ruleValue]));
  const ssh = model.views.network.edges.filter((e) => e.label?.includes('tcp/22'));
  assert.deepEqual(ssh.map((e) => e.source), ['cidr:192.168.0.0/16']);
});

// ---------- ソースの読み取り ----------

test('parseLocals / parseDynamics / parseModuleMapArgs がソースから参照を拾う', () => {
  assert.deepEqual(parseLocals('locals {\n  a = aws_s3_bucket.b.arn\n  c = {\n    d = var.x\n  }\n}\n'), { a: ['aws_s3_bucket.b'], c: ['var.x'] });
  const dyn = parseDynamics('resource "aws_ecs_service" "s" {\n  dynamic "load_balancer" {\n    for_each = var.lbs\n    content {\n      target_group_arn = load_balancer.value.arn\n    }\n  }\n}\n');
  assert.deepEqual(dyn, { 'aws_ecs_service.s': { load_balancer: ['var.lbs'] } });
  const args = parseModuleMapArgs('module "ep" {\n  endpoints = {\n    s3 = {\n      service = "s3"\n    }\n    rds = {\n      sgs = [module.sg.id]\n    }\n  }\n}\n');
  assert.deepEqual(args, { ep: { endpoints: { s3: [], rds: ['module.sg.id'] } } });
  // オブジェクトの属性（1行、複数行のリスト）もキーごとに拾う
  const obj = parseModuleMapArgs('module "fn" {\n  cfg = {\n    role_arn = module.iam.arn\n    ids = [\n      module.a.id,\n      module.b.id,\n    ]\n    name = "x"\n  }\n}\n');
  assert.deepEqual(obj, { fn: { cfg: { role_arn: ['module.iam.arn'], ids: ['module.a.id', 'module.b.id'], name: [] } } });
});

test('maskSecrets はコード片に直書きされた機密値を伏せる', () => {
  assert.equal(maskSecrets('  password = "hunter2"\n  name = "x"'), '  password = "********"\n  name = "x"');
});
