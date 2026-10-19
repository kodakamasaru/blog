// 統合ビュー: 配置は1つ（NW の枠）、線はレイヤー（network / data / iam）として重ねる
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnifiedView } from './unified.mjs';

const REGION = 'region:ap-northeast-1';
const node = (id, type, extra = {}) => ({ id, type, kind: type, name: id, ...extra });
const e = (kind, source, target, extra = {}) => ({ id: `${kind}:${source}->${target}`, kind, source, target, label: kind, evidence: [{ text: kind, address: source }], ...extra });

function fixture() {
  const nodes = [
    node(REGION, 'region'),
    node('vpc', 'aws_vpc'),
    node('tier:app', 'private-subnet'),
    node('fn', 'aws_lambda_function'),
    node('db', 'aws_db_instance'),
    node('bucket', 'aws_s3_bucket', { kind: 'S3', category: 'storage' }),
    node('api', 'aws_api_gateway_rest_api'),
    node('role', 'aws_iam_role', { warning: true }),
    node('admin', 'aws_iam_role'),
    node('managed:ReadOnlyAccess', 'managed-policy'),
    node('internet', 'internet'),
    node('repo', 'aws_ecr_repository', { kind: 'ECR', category: 'compute' }),
    node('repo2', 'aws_ecr_repository', { kind: 'ECR', category: 'compute' }),
    node('topic', 'aws_sns_topic', { kind: 'SNS', category: 'messaging' }),
  ];
  const views = {
    network: {
      nodes: [REGION, 'vpc', 'tier:app', 'fn', 'db', 'internet'],
      parents: { vpc: REGION, 'tier:app': 'vpc', fn: 'tier:app', db: 'tier:app' },
      edges: [e('sg', 'fn', 'db', { label: 'tcp/5432' })],
    },
    iam: {
      nodes: ['fn', 'role', 'bucket', 'api', 'admin', 'managed:ReadOnlyAccess'],
      parents: {},
      edges: [
        e('assume', 'fn', 'role', { label: '実行ロール' }),
        e('allow', 'role', 'bucket', { label: 's3:PutObject', actions: ['s3:PutObject'] }),
        e('managed', 'admin', 'managed:ReadOnlyAccess'),
        e('resource-policy', 'api', 'fn', { label: 'lambda:InvokeFunction' }),
      ],
    },
    data: {
      nodes: ['internet', 'api', 'fn'],
      parents: {},
      edges: [e('flow', 'internet', 'api'), e('flow', 'api', 'fn')],
    },
  };
  return { nodes, views };
}

test('配置は NW の枠を使い、VPC の外のリソースは Region の枠に入れる', () => {
  const { nodes, views } = fixture();
  const u = buildUnifiedView(views, nodes, REGION);
  assert.equal(u.parents.fn, 'tier:app');
  assert.equal(u.parents.bucket, REGION);
  assert.equal(u.parents.api, REGION);
  assert.equal(u.parents.internet, undefined);
});

test('ロールと管理ポリシーはノードにせず、「使う側 → リソース」の権限の線に畳む', () => {
  const { nodes, views } = fixture();
  const u = buildUnifiedView(views, nodes, REGION);
  assert.ok(!u.nodes.includes('role'));
  assert.ok(!u.nodes.includes('admin'));
  assert.ok(!u.nodes.includes('managed:ReadOnlyAccess'));
  const perm = u.edges.find((x) => x.layer === 'iam' && x.source === 'fn' && x.target === 'bucket');
  assert.ok(perm, 'fn -> bucket の権限の線');
  assert.equal(perm.label, 's3:PutObject');
  // 根拠には「どのロールで」と「どのポリシーで」の両方を残す
  assert.deepEqual(perm.evidence.map((ev) => ev.text), ['assume', 'allow']);
  // リソースベースポリシー（API Gateway → Lambda）は権限のレイヤーにそのまま出す
  assert.ok(u.edges.some((x) => x.layer === 'iam' && x.source === 'api' && x.target === 'fn'));
});

test('線にはレイヤーが付き、ID は重複しない。Resource:* のロールを使うものは warnings に入る', () => {
  const { nodes, views } = fixture();
  const u = buildUnifiedView(views, nodes, REGION);
  assert.deepEqual([...new Set(u.edges.map((x) => x.layer))].sort(), ['data', 'iam', 'network']);
  assert.equal(new Set(u.edges.map((x) => x.id)).size, u.edges.length);
  assert.deepEqual(u.warnings, ['fn']);
  // 線の両端はすべてノードに含まれる
  assert.ok(u.edges.every((x) => u.nodes.includes(x.source) && u.nodes.includes(x.target)));
});

test('VPC の外のリソースは、同じ種類が複数あれば種類（サービス）ごとの枠にまとめる。中身がすべて孤立していれば最初は畳む', () => {
  const { nodes, views } = fixture();
  const u = buildUnifiedView(views, nodes, REGION);
  const ecr = u.parents.repo;
  assert.ok(u.nodes.includes('repo') && u.nodes.includes(ecr));
  assert.equal(u.parents.repo2, ecr);
  assert.equal(u.parents[ecr], REGION);
  assert.deepEqual(u.collapsed, [ecr]);
  const frame = u.extraNodes.find((n) => n.id === ecr);
  assert.equal(frame.kind, 'ECR');
  assert.equal(frame.type, 'aws_ecr_repository');
  // 1つしかない種類はそのまま Region に置く
  assert.equal(u.parents.topic, REGION);
});

test('線でつながっているリソースも、種類ごとの枠に入れる（畳まない）', () => {
  const { nodes, views } = fixture();
  const more = [...nodes, { id: 'bucket2', type: 'aws_s3_bucket', kind: 'S3', name: 'bucket2', category: 'storage' }];
  const u = buildUnifiedView(views, more, REGION);
  const s3 = u.parents.bucket;
  assert.notEqual(s3, REGION);
  assert.equal(u.parents.bucket2, s3);
  assert.ok(!u.collapsed.includes(s3));
});
