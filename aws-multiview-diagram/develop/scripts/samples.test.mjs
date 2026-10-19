// 公開サンプルでの回帰テスト。npm run samples -- fetch / plan で plan を取ってある場合だけ動く（無ければスキップ）。
//   - expectations.json の「正解の線・ノード」がすべて図に出ていること
//   - plan で sensitive 指定された値がモデルに入っていないこと
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildModel } from '../tf2model/model.mjs';
import { scanStack } from '../tf2model/source.mjs';
import { coverageOf, recallOf } from './coverage.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'samples/samples.json'), 'utf8'));
const EXPECTATIONS = JSON.parse(readFileSync(join(ROOT, 'samples/expectations.json'), 'utf8'));
const WORK = join(ROOT, 'samples/.work');

function srcDirOf(sample) {
  if (sample.local) return join(ROOT, sample.local);
  return join(WORK, 'src', createHash('sha1').update(`${sample.repo}@${sample.ref}`).digest('hex').slice(0, 10));
}

const stacks = MANIFEST.samples.flatMap((sample) =>
  sample.stacks.map((stack) => {
    const slug = stack.dir === '.' ? 'root' : stack.dir.replaceAll('/', '__');
    return { sample, stack, plan: join(WORK, 'out', sample.id, `${slug}.plan.json`), key: `${sample.id}/${stack.dir}` };
  }),
);

for (const { sample, stack, plan, key } of stacks) {
  test(`サンプル ${key}: 正解の線がすべて出ていて、機密値が漏れていない`, { skip: !existsSync(plan) && 'plan がありません（npm run samples -- plan）' }, () => {
    const planJson = JSON.parse(readFileSync(plan, 'utf8'));
    const { sources, ...scanned } = scanStack(join(srcDirOf(sample), stack.dir));
    const model = buildModel(planJson, sources, scanned);
    const missing = recallOf(model, EXPECTATIONS[key]).flatMap((r) => r.missing.map((m) => `${r.view}: ${m}`));
    assert.deepEqual(missing, []);
    assert.deepEqual(coverageOf(planJson, model).leaks, []);
  });
}
