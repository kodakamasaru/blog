#!/usr/bin/env node
// 使い方: node tf2model/cli.mjs <plan.json> [plan を取ったディレクトリ] > model.json
// ディレクトリを渡すと、ソースのコード片と locals（モジュールの中も含む）を読んで参照の解決に使う。
import { readFileSync } from 'node:fs';
import { buildModel } from './model.mjs';
import { scanStack } from './source.mjs';

const [planPath, tfDir] = process.argv.slice(2);
if (!planPath) {
  console.error('usage: tf2model <plan.json> [tf-dir]');
  process.exit(1);
}

try {
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const { sources, ...scanned } = tfDir ? scanStack(tfDir) : { sources: {} };
  process.stdout.write(`${JSON.stringify(buildModel(plan, sources, scanned), null, 2)}\n`);
} catch (err) {
  console.error(`tf2model: ${err.message}`);
  process.exit(1);
}
