import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectView, visibleOwner, viewsContaining } from './graph.js';

const model = JSON.parse(readFileSync(new URL('../public/model.json', import.meta.url), 'utf8'));
const ids = (els, group) => els.filter((e) => e.group === group).map((e) => e.data.id);

test('visibleOwner は一番外側の折りたたまれた祖先を返す', () => {
  const parents = { leaf: 'tier', tier: 'vpc' };
  assert.equal(visibleOwner('leaf', parents, new Set()), 'leaf');
  assert.equal(visibleOwner('leaf', parents, new Set(['tier'])), 'tier');
  assert.equal(visibleOwner('leaf', parents, new Set(['tier', 'vpc'])), 'vpc');
});

test('projectView は折りたたむとグループの中身を隠し、エッジをグループに付け替える', () => {
  const tier = 'tier:aws_vpc.main:app';
  const els = projectView(model, 'network', new Set([tier]));
  const nodes = ids(els, 'nodes');
  assert.ok(nodes.includes(tier));
  assert.ok(!nodes.includes('aws_ecs_service.api'));
  const edges = els.filter((e) => e.group === 'edges').map((e) => `${e.data.source}->${e.data.target}`);
  assert.ok(edges.includes(`aws_lb.public->${tier}`));
  assert.ok(edges.includes(`${tier}->aws_db_instance.main`));
});

test('projectView は VPC ごと折りたたむと、中のエッジ同士の自己ループを出さない', () => {
  const els = projectView(model, 'network', new Set(['aws_vpc.main']));
  const loops = els.filter((e) => e.group === 'edges' && e.data.source === e.data.target);
  assert.deepEqual(loops, []);
  assert.ok(ids(els, 'edges').some((id) => id.includes('aws_vpc.main->internet') || id.includes('internet->aws_vpc.main')));
});

test('projectView は推定エッジに inferred クラスを付ける', () => {
  const els = projectView(model, 'data');
  const inferred = els.filter((e) => e.group === 'edges' && e.classes.includes('inferred'));
  assert.ok(inferred.length > 0);
});

test('viewsContaining はノードが出てくる視点を返す', () => {
  assert.deepEqual(viewsContaining(model, 'aws_ecs_service.api'), ['network', 'iam', 'data', 'unified']);
  // 統合ビューはロールを箱にしない
  assert.deepEqual(viewsContaining(model, 'aws_iam_role.api_task'), ['iam']);
});
