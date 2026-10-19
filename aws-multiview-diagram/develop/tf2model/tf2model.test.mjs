import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toAddress, allRefsOf, indexPlan } from './plan.mjs';
import { commonPrefix, compactActions, mergeEdges, edge } from './catalog.mjs';
import { classifyActions } from './dataflow.mjs';
import { scanSource } from './source.mjs';
import { buildModel } from './model.mjs';
import { scanSourceDir } from './source.mjs';
import { envFromSource } from './settings.mjs';

const plan = JSON.parse(readFileSync(new URL('../infra/plan.json', import.meta.url), 'utf8'));
const model = buildModel(plan, scanSourceDir(new URL('../infra/', import.meta.url).pathname));
const nodeOf = (id) => model.nodes.find((n) => n.id === id);
const settingOf = (id, label) => nodeOf(id).settings.find((s) => s.label === label)?.value;
const edgesOf = (view) => model.views[view].edges.map((e) => `${e.source} -> ${e.target}`);

test('toAddress は属性とインデックスを落としてリソースアドレスにする', () => {
  assert.equal(toAddress('aws_s3_bucket.uploads.arn'), 'aws_s3_bucket.uploads');
  assert.equal(toAddress('aws_subnet.app[0].id'), 'aws_subnet.app');
  assert.equal(toAddress('data.aws_iam_policy_document.api.json'), 'data.aws_iam_policy_document.api');
});

test('allRefsOf はネストしたブロックの中の参照も集め、存在しないアドレスは捨てる', () => {
  const index = new Map([['aws_s3_bucket.a', {}], ['aws_sqs_queue.q', {}]]);
  const expr = { env: [{ variables: { references: ['aws_s3_bucket.a.bucket', 'local.name'] } }], q: { references: ['aws_sqs_queue.q.arn'] } };
  assert.deepEqual(allRefsOf(expr, index).sort(), ['aws_s3_bucket.a', 'aws_sqs_queue.q']);
});

test('indexPlan は terraform show -json 以外を渡すと分かるエラーを投げる', () => {
  assert.throws(() => indexPlan({}), /terraform show -json/);
});

test('commonPrefix は過半数の名前に共通する接頭辞を返す', () => {
  assert.equal(commonPrefix(['photo-share-api', 'photo-share-db', 'main']), 'photo-share-');
  assert.equal(commonPrefix(['a', 'b']), '');
});

test('compactActions はサービスごとに action をまとめる', () => {
  assert.equal(compactActions(['dynamodb:PutItem', 'dynamodb:UpdateItem', 's3:GetObject']), 'dynamodb:PutItem/UpdateItem, s3:GetObject');
});

test('classifyActions は動詞で読み取りと書き込みを分ける', () => {
  assert.deepEqual(classifyActions(['s3:GetObject', 's3:PutObject', 'sts:AssumeRole']), { reads: ['s3:GetObject'], writes: ['s3:PutObject'] });
});

test('classifyActions: メタデータの取得はデータの流れにせず、SQS の削除・可視性延長は受信側として扱う', () => {
  assert.deepEqual(classifyActions(['sqs:GetQueueAttributes', 's3:ListBucket', 's3:GetBucketLocation']), { reads: [], writes: [] });
  assert.deepEqual(classifyActions(['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:SendMessage']), { reads: ['sqs:ReceiveMessage', 'sqs:DeleteMessage'], writes: ['sqs:SendMessage'] });
});

test('mergeEdges は同じ向き・種類のエッジのラベルと根拠を結合し、元の配列を変更しない', () => {
  const input = [
    edge({ source: 'a', target: 'b', kind: 'sg', labels: ['tcp/80'], evidence: [{ text: 'x', address: 'r1' }] }),
    edge({ source: 'a', target: 'b', kind: 'sg', labels: ['tcp/443'], evidence: [{ text: 'y', address: 'r2' }] }),
  ];
  const snapshot = structuredClone(input);
  const [merged, ...rest] = mergeEdges(input);
  assert.equal(rest.length, 0);
  assert.equal(merged.label, 'tcp/80, tcp/443');
  assert.equal(merged.evidence.length, 2);
  assert.deepEqual(input, snapshot);
});

test('scanSource はブロックの開始行とコード片を返す', () => {
  const src = 'locals {}\n\nresource "aws_s3_bucket" "a" {\n  bucket = "${local.x}"\n}\n';
  assert.deepEqual(scanSource('main.tf', src)['aws_s3_bucket.a'], {
    file: 'main.tf',
    line: 3,
    code: 'resource "aws_s3_bucket" "a" {\n  bucket = "${local.x}"\n}',
  });
});

test('NW 視点: SG ルールが リソース同士の通信として出る', () => {
  const edges = edgesOf('network');
  assert.ok(edges.includes('aws_internet_gateway.main -> aws_lb.public'));
  assert.ok(edges.includes('aws_lb.public -> aws_ecs_service.api'));
  assert.ok(edges.includes('aws_ecs_service.api -> aws_db_instance.main'));
  assert.ok(edges.includes('tier:aws_vpc.main:app -> aws_nat_gateway.main'));
});

test('NW 視点: リソースは Tier タグでまとめたサブネット層に入る', () => {
  const { parents } = model.views.network;
  assert.equal(parents['aws_ecs_service.api'], 'tier:aws_vpc.main:app');
  assert.equal(parents['aws_db_instance.main'], 'tier:aws_vpc.main:db');
  assert.equal(parents['tier:aws_vpc.main:app'], 'aws_vpc.main');
});

test('IAM 視点: ロールの権限が actions 付きで出る', () => {
  const e = model.views.iam.edges.find((x) => x.source === 'aws_iam_role.thumbnail' && x.target === 'aws_dynamodb_table.photos');
  assert.equal(e.label, 'dynamodb:PutItem/UpdateItem');
  assert.ok(edgesOf('iam').includes('aws_s3_bucket.uploads -> aws_sqs_queue.uploaded'));
});

test('データフロー視点: 明示的な配線は推定扱いにしない', () => {
  const e = model.views.data.edges.find((x) => x.source === 'aws_sqs_queue.uploaded');
  assert.equal(e.target, 'aws_lambda_function.thumbnail');
  assert.equal(e.inferred, false);
});

test('データフロー視点: 参照 × 権限から向き付きの流れを推定する', () => {
  const edges = edgesOf('data');
  assert.ok(edges.includes('aws_s3_bucket.uploads -> aws_lambda_function.thumbnail'));
  assert.ok(edges.includes('aws_lambda_function.thumbnail -> aws_s3_bucket.thumbnails'));
  assert.ok(!edges.includes('aws_lambda_function.thumbnail -> aws_sqs_queue.uploaded'));
});

test('データフロー視点: IAM が無くても 参照 × SG 許可 があれば流れとして出す', () => {
  const e = model.views.data.edges.find((x) => x.target === 'aws_db_instance.main');
  assert.equal(e.source, 'aws_ecs_service.api');
  assert.equal(e.inferred, true);
});

test('すべての視点のノードがモデルのノード一覧に存在する', () => {
  const ids = new Set(model.nodes.map((n) => n.id));
  const missing = Object.values(model.views).flatMap((v) => v.nodes).filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('NW 視点: 0.0.0.0/0 からの許可は Internet Gateway 経由の線になり、外向きは NAT → IGW になる', () => {
  const edges = edgesOf('network');
  assert.ok(edges.includes('internet -> aws_internet_gateway.main'));
  assert.ok(edges.includes('aws_nat_gateway.main -> aws_internet_gateway.main'));
  assert.ok(!edges.includes('internet -> aws_lb.public'));
});

test('NW 視点: IGW へのルートの有無でパブリック / プライベートを判定し、VPC は Region の枠に入る', () => {
  assert.equal(nodeOf('tier:aws_vpc.main:public').type, 'public-subnet');
  assert.equal(nodeOf('tier:aws_vpc.main:app').type, 'private-subnet');
  assert.equal(nodeOf('tier:aws_vpc.main:db').type, 'private-subnet');
  assert.equal(model.views.network.parents['aws_vpc.main'], 'region:ap-northeast-1');
});

test('データフロー視点: VPC 内のリソースは VPC の枠、それ以外は Region の枠に入る', () => {
  const { parents } = model.views.data;
  assert.equal(parents['aws_ecs_service.api'], 'aws_vpc.main');
  assert.equal(parents['aws_s3_bucket.uploads'], 'region:ap-northeast-1');
  assert.equal(parents.internet, undefined);
});

test('データフロー視点: DLQ への redrive は明示的な流れとして出る', () => {
  assert.ok(edgesOf('data').includes('aws_sqs_queue.uploaded -> aws_sqs_queue.uploaded_dlq'));
});

test('envFromSource はコンテナ定義の環境変数とシークレットの名前を拾う', () => {
  const code = '{ name = "A", value = aws_s3_bucket.x.bucket },\n{ name = "B", valueFrom = aws_secretsmanager_secret.y.arn }';
  assert.deepEqual(envFromSource(code).map((e) => [e.name, e.secret]), [['A', false], ['B', true]]);
});

test('主要な設定: 関連リソースの値も集める（ECS ならタスク定義とターゲットグループ）', () => {
  assert.equal(settingOf('aws_ecs_service.api', 'CPU / メモリ'), '0.5 vCPU / 1 GB（ARM64）');
  assert.equal(settingOf('aws_ecs_service.api', 'ヘルスチェック'), 'HTTP /healthz → 200（15秒ごと、3回失敗で除外）');
  assert.equal(settingOf('aws_ecs_service.api', '環境変数'), 'UPLOAD_BUCKET, THUMBNAIL_BUCKET, PHOTOS_TABLE, DB_HOST');
  assert.equal(settingOf('aws_s3_bucket.uploads', 'パブリックアクセス'), 'すべてブロック');
  assert.equal(settingOf('aws_sqs_queue.uploaded', 'DLQ'), 'uploaded-dlq（5回失敗で移動）');
});

test('主要な設定: apply まで決まらない値は「apply 時に決定」と明示する', () => {
  const endpoint = nodeOf('aws_db_instance.main').settings.find((s) => s.label === 'エンドポイント');
  assert.deepEqual(endpoint, { label: 'エンドポイント', value: 'apply 時に決定', pending: true });
});

test('主要な設定: ノードの下に出す要約を作る', () => {
  assert.equal(nodeOf('aws_db_instance.main').summary, 'postgres 16.4 · db.t4g.medium · Multi-AZ');
  assert.equal(nodeOf('aws_lb.public').summary, 'internet-facing · HTTP:80, HTTPS:443');
});
