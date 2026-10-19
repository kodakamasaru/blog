#!/usr/bin/env node
// 公開サンプルに対して「取得 → plan → モデル生成 → 網羅率の測定」を行う。
//
//   node scripts/samples.mjs fetch            サンプルを ref 固定で取得
//   node scripts/samples.mjs plan [id...]     moto（AWS のモック）に向けて plan する
//   node scripts/samples.mjs model [id...]    plan からモデルを作る
//   node scripts/samples.mjs report [id...]   網羅率を表示する
//
// plan は AWS_ENDPOINT_URL で moto に向けるので、本物の AWS には一切アクセスしない。
// 事前に moto を起動しておくこと（AWS 管理ポリシーを参照するサンプルがあるので、読み込む設定にする）:
//   MOTO_IAM_LOAD_MANAGED_POLICIES=true uvx --from 'moto[server]' moto_server -p 5055
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { buildModel } from '../tf2model/model.mjs';
import { scanStack } from '../tf2model/source.mjs';
import { coverageOf, recallOf } from './coverage.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const WORK = join(ROOT, 'samples/.work');

// *.local.json は手元だけのサンプル（非公開リポジトリなど）。gitignore 済みで、あれば後ろに足す
function readJson(name, fallback) {
  const path = join(ROOT, 'samples', name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}
const MANIFEST = Object.freeze({
  samples: [...readJson('samples.json').samples, ...readJson('samples.local.json', { samples: [] }).samples],
});
const EXPECTATIONS = Object.freeze({ ...readJson('expectations.json'), ...readJson('expectations.local.json', {}) });
const MOTO = process.env.MOTO_ENDPOINT ?? 'http://localhost:5055';
const LOG_TAIL_LINES = 25;
// moto が未実装の API を叩くと、プロバイダが再試行を続けて止まらないことがあるので打ち切る
const STEP_TIMEOUT_MS = 5 * 60 * 1000;

// plan / apply の間だけ、存在しないプロキシを HTTPS_PROXY に設定する。
// AWS_ENDPOINT_URL に対応していない古いプロバイダなどが本物の AWS に向かっても、通信が外に出ずに失敗する。
const BLOCK_EXTERNAL = Object.freeze({ HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: 'localhost,127.0.0.1' });

// provider に profile = "default" と書かれたサンプルのために、ダミーの認証情報ファイルを用意する
const CREDENTIALS_FILE = join(WORK, 'aws-credentials');

const AWS_ENV = Object.freeze({
  AWS_ENDPOINT_URL: MOTO,
  AWS_SHARED_CREDENTIALS_FILE: CREDENTIALS_FILE,
  AWS_CONFIG_FILE: CREDENTIALS_FILE,
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  AWS_REGION: 'us-east-1',
  AWS_DEFAULT_REGION: 'us-east-1',
  TF_IN_AUTOMATION: '1',
  TF_INPUT: '0',
});

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts, env: { ...process.env, ...opts.env } });
  const timedOut = res.error?.code === 'ETIMEDOUT';
  const note = timedOut ? `\n[tfscope] ${opts.timeout / 1000}秒で打ち切りました（moto が未対応の API で再試行が続いている可能性）` : '';
  return { ok: res.status === 0, out: `${res.stdout ?? ''}${res.stderr ?? ''}${note}` };
}

function tail(text) {
  return text.trim().split('\n').slice(-LOG_TAIL_LINES).join('\n');
}

function sparseDirs(sample) {
  return [...sample.stacks.map((s) => s.dir), ...(sample.include ?? [])];
}

function srcDirOf(sample) {
  if (sample.local) return join(ROOT, sample.local);
  const key = createHash('sha1').update(`${sample.repo}@${sample.ref}`).digest('hex').slice(0, 10);
  return join(WORK, 'src', key);
}

function stackDir(sample, stack) {
  return join(srcDirOf(sample), stack.dir);
}

function outDir(sample) {
  const dir = join(WORK, 'out', sample.id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stackSlug(stack) {
  return stack.dir === '.' ? 'root' : stack.dir.replaceAll('/', '__');
}

function selected(ids) {
  return ids.length ? MANIFEST.samples.filter((s) => ids.includes(s.id)) : MANIFEST.samples;
}

// ---------- fetch ----------

function fetchSample(sample) {
  if (sample.local) return { ok: true, note: 'local' };
  const dir = srcDirOf(sample);
  if (existsSync(join(dir, '.git'))) {
    // 同じリポジトリを複数のサンプルで共有しているので、このサンプルのディレクトリを展開対象に足す
    const add = run('git', ['-C', dir, 'sparse-checkout', 'add', ...sparseDirs(sample)]);
    return add.ok ? { ok: true, note: 'cached' } : { ok: false, note: tail(add.out) };
  }
  mkdirSync(dir, { recursive: true });
  const steps = [
    ['git', ['init', '-q', dir]],
    ['git', ['-C', dir, 'remote', 'add', 'origin', sample.repo]],
    ['git', ['-C', dir, 'sparse-checkout', 'set', ...sparseDirs(sample)]],
    ['git', ['-C', dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', sample.ref]],
    ['git', ['-C', dir, 'checkout', '-q', 'FETCH_HEAD']],
  ];
  for (const [cmd, args] of steps) {
    const res = run(cmd, args);
    if (!res.ok) return { ok: false, note: tail(res.out) };
  }
  return { ok: true, note: 'fetched' };
}

// ---------- plan ----------

// samples.json の profiles: provider に profile = "<名前>" と書かれたサンプル用に、同じダミー認証のプロファイルを足す
function ensureCredentialsFile(profiles = []) {
  mkdirSync(WORK, { recursive: true });
  const section = (name) => `[${name}]\naws_access_key_id = test\naws_secret_access_key = test\nregion = us-east-1\n`;
  const text = ['default', ...profiles].map(section).join('\n');
  writeFileSync(CREDENTIALS_FILE, text);
}

const TF_ARCH = Object.freeze({ x64: 'amd64', arm64: 'arm64' });

/**
 * samples.json の terraform: サンプルが新しい Terraform を要求する場合に、そのバージョンを .work/bin に取得する。
 * 公式の SHA256SUMS で照合してから展開する。未指定ならパス上の terraform を使う
 */
function terraformBin(version) {
  if (!version) return { ok: true, bin: 'terraform' };
  const dir = join(WORK, 'bin', version);
  const bin = join(dir, 'terraform');
  if (existsSync(bin)) return { ok: true, bin };
  mkdirSync(dir, { recursive: true });
  const zip = `terraform_${version}_${process.platform}_${TF_ARCH[process.arch]}.zip`;
  const base = `https://releases.hashicorp.com/terraform/${version}`;
  const steps = [
    ['curl', ['-sSfL', '-o', join(dir, zip), `${base}/${zip}`]],
    ['curl', ['-sSfL', '-o', join(dir, 'SHA256SUMS'), `${base}/terraform_${version}_SHA256SUMS`]],
    ['sh', ['-c', `grep ' ${zip}$' SHA256SUMS | shasum -a 256 -c -`], { cwd: dir }],
    ['unzip', ['-oq', zip, 'terraform'], { cwd: dir }],
  ];
  for (const [cmd, args, opts] of steps) {
    const res = run(cmd, args, opts);
    if (!res.ok) return { ok: false, detail: `terraform ${version} の取得に失敗: ${tail(res.out)}` };
  }
  return { ok: true, bin };
}

// boto3 で moto にデータを入れる（AWS が公開している SSM パラメータや、データソースで読むシークレットなど）
const SEED_SCRIPT = `
import json, sys, boto3
for s in json.load(sys.stdin):
    c = boto3.client(s["service"], endpoint_url="${MOTO}", region_name=s.get("region", "us-east-1"), aws_access_key_id="test", aws_secret_access_key="test")
    try:
        getattr(c, s["method"])(**s["params"])
    except c.exceptions.ClientError as e:
        if "AlreadyExists" not in str(e) and "ResourceExists" not in str(e):
            raise
`;

/** サンプル同士が影響しないように、moto の中身を初期化する */
function resetMoto() {
  const res = spawnSync('curl', ['-s', '-f', '-X', 'POST', `${MOTO}/moto-api/reset`], { encoding: 'utf8' });
  return { ok: res.status === 0, detail: tail(`${res.stdout}${res.stderr}`) };
}

function seedMoto(sample) {
  if (!sample.seed?.length) return { ok: true };
  const res = spawnSync('uvx', ['--with', 'boto3', 'python', '-c', SEED_SCRIPT], { input: JSON.stringify(sample.seed), encoding: 'utf8' });
  return { ok: res.status === 0, detail: tail(`${res.stdout}${res.stderr}`) };
}

function planStack(sample, stack, terraform) {
  const dir = stackDir(sample, stack);
  const out = outDir(sample);
  const slug = stackSlug(stack);
  const env = AWS_ENV;
  const isolated = { ...AWS_ENV, ...BLOCK_EXTERNAL };
  writeOverride(dir, sample.providerVersion, stack.override);
  // moduleOverrides: ローカルモジュールの中のデータソースを差し替える（キーはスタックからの相対パス）
  Object.entries(stack.moduleOverrides ?? {}).forEach(([rel, hcl]) => writeOverride(join(dir, rel), undefined, hcl));
  const varArgs = Object.entries(stack.vars ?? {}).flatMap(([k, v]) => ['-var', `${k}=${v}`]);
  const log = [];
  const step = (args, stepEnv = isolated) => {
    const res = run(terraform, args, { cwd: dir, env: stepEnv, timeout: STEP_TIMEOUT_MS, killSignal: 'SIGKILL' });
    log.push(`$ terraform ${args.join(' ')}\n${res.out}`);
    return res;
  };

  // init はプロバイダやモジュールのダウンロードがあるので、外部への通信を許可する
  // 毎回まっさらな状態から plan する（moto は再起動やリセットで中身が消えるので、前回の state が残っていると
  // 存在しないリソースの読み直しで詰まる）。apply するスタックもここで作り直す
  ['terraform.tfstate', 'terraform.tfstate.backup'].forEach((f) => rmSync(join(dir, f), { force: true }));
  const init = step(['init', '-input=false', '-no-color', '-upgrade'], env);
  if (!init.ok) return finish(false, 'init');
  const plan = step(['plan', '-input=false', '-no-color', '-out', 'tfscope.plan', ...varArgs]);
  if (!plan.ok) return finish(false, 'plan');
  const show = run(terraform, ['show', '-json', 'tfscope.plan'], { cwd: dir, env: isolated });
  if (!show.ok) return finish(false, 'show');
  writeFileSync(join(out, `${slug}.plan.json`), show.out);
  if (stack.apply) {
    const apply = step(['apply', '-input=false', '-no-color', '-auto-approve', 'tfscope.plan']);
    if (!apply.ok) return finish(false, 'apply');
  }
  return finish(true, stack.apply ? 'planned+applied' : 'planned');

  function finish(ok, phase) {
    writeFileSync(join(out, `${slug}.log`), log.join('\n\n'));
    return { ok, phase, detail: ok ? '' : tail(log.at(-1) ?? '') };
  }
}

const OVERRIDE_FILE = 'tfscope_override.tf';

/**
 * override ファイルを書く（サンプルのコードは書き換えない）
 *   providerVersion : サンプルの AWS プロバイダ指定が古い場合に、バージョン指定だけ上書きする
 *   override        : moto に無いデータの参照先を差し替えるなどの HCL
 *   moduleOverrides : 同じ HCL をローカルモジュールのディレクトリに置く
 */
function writeOverride(dir, version, extra) {
  const path = join(dir, OVERRIDE_FILE);
  const parts = [
    version ? `terraform {\n  required_providers {\n    aws = {\n      source  = "hashicorp/aws"\n      version = "${version}"\n    }\n  }\n}\n` : '',
    extra ?? '',
  ].filter(Boolean);
  if (parts.length === 0) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  writeFileSync(path, `# tfscope が網羅率の測定用に生成（samples.json の providerVersion / override）\n${parts.join('\n')}`);
}

// ---------- model / report ----------

function planPaths(sample) {
  const out = outDir(sample);
  return sample.stacks
    .map((stack) => ({ stack, slug: stackSlug(stack), plan: join(out, `${stackSlug(stack)}.plan.json`) }))
    .filter(({ plan }) => existsSync(plan));
}

function modelSample(sample) {
  const viewerDir = join(ROOT, 'viewer/public/samples');
  mkdirSync(viewerDir, { recursive: true });
  return planPaths(sample).map(({ stack, slug, plan }) => {
    try {
      const planJson = JSON.parse(readFileSync(plan, 'utf8'));
      const { sources, ...scanned } = scanStack(stackDir(sample, stack));
      const model = buildModel(planJson, sources, scanned);
      const text = JSON.stringify(model);
      writeFileSync(join(outDir(sample), `${slug}.model.json`), text);
      writeFileSync(join(viewerDir, `${sample.id}--${slug}.json`), text);
      const recall = recallOf(model, EXPECTATIONS[`${sample.id}/${stack.dir}`]);
      return { id: sample.id, stack: stack.dir, ok: true, phase: 'modeled', coverage: coverageOf(planJson, model, text), recall };
    } catch (err) {
      return { id: sample.id, stack: stack.dir, ok: false, phase: 'model', detail: err.stack };
    }
  });
}

const VIEW_LABEL = Object.freeze({ network: 'NW', iam: 'IAM', data: 'Data' });

function printReport(rows) {
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
  rows.filter((r) => r.coverage).forEach(({ id, stack, coverage: c, recall }) => {
    process.stdout.write(`\n■ ${id} (${stack})\n`);
    recall.forEach((r) => {
      process.stdout.write(`  正解 ${VIEW_LABEL[r.view]} ${r.hit}/${r.total}${r.missing.length ? `  ✗ ${r.missing.join(' | ')}` : ' ✓'}\n`);
    });
    process.stdout.write(`  リソース ${c.total} 件 / ノード ${c.nodes} / 説明あり ${c.explained} (${pct(c.explained, c.total)})\n`);
    process.stdout.write(`  エッジ NW ${c.edges.network} / IAM ${c.edges.iam} / Data ${c.edges.data}（推定 ${c.inferred}）\n`);
    process.stdout.write(`  機密値の漏れ ${c.leaks.length ? `⚠ ${c.leaks.length} 件: ${c.leaks.slice(0, 3).join(', ')}` : 'なし'}\n`);
    if (c.unexplained.length) process.stdout.write(`  説明なしの種類: ${c.unexplained.map(([t, n]) => `${t}×${n}`).join(', ')}\n`);
  });
  const all = rows.flatMap((r) => r.recall ?? []);
  const hit = all.reduce((n, r) => n + r.hit, 0);
  const total = all.reduce((n, r) => n + r.total, 0);
  process.stdout.write(`\n=== 正解の線・ノードの再現率: ${hit}/${total} (${pct(hit, total)})\n`);
  Object.keys(VIEW_LABEL).forEach((view) => {
    const v = all.filter((r) => r.view === view);
    const h = v.reduce((n, r) => n + r.hit, 0);
    const t = v.reduce((n, r) => n + r.total, 0);
    process.stdout.write(`    ${VIEW_LABEL[view]}: ${h}/${t} (${pct(h, t)})\n`);
  });
}

// ---------- main ----------

const [command, ...ids] = process.argv.slice(2);
const commands = {
  model: () => selected(ids).flatMap(modelSample),
  report: () => {
    const rows = selected(ids).flatMap(modelSample);
    printReport(rows);
    return rows;
  },
  fetch: () => selected(ids).map((s) => ({ id: s.id, ...fetchSample(s) })),
  plan: () =>
    selected(ids).flatMap((s) => {
      ensureCredentialsFile(s.profiles);
      const tf = terraformBin(s.terraform);
      if (!tf.ok) return [{ id: s.id, ok: false, phase: 'terraform', detail: tf.detail }];
      const reset = resetMoto();
      if (!reset.ok) return [{ id: s.id, ok: false, phase: 'reset', detail: `moto に接続できません（${MOTO}）\n${reset.detail}` }];
      const seeded = seedMoto(s);
      if (!seeded.ok) return [{ id: s.id, ok: false, phase: 'seed', detail: seeded.detail }];
      for (const stack of s.stacks) {
        const res = planStack(s, stack, tf.bin);
        if (!res.ok) return [{ id: s.id, stack: stack.dir, ...res }];
        if (stack === s.stacks.at(-1)) return [{ id: s.id, stack: stack.dir, ...res }];
      }
      return [];
    }),
};

if (!commands[command]) {
  process.stderr.write(`usage: samples.mjs <${Object.keys(commands).join('|')}> [id...]\n`);
  process.exit(1);
}
const results = commands[command]();
results.forEach((r) => {
  process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id}${r.stack ? ` (${r.stack})` : ''} ${r.phase ?? r.note ?? ''}\n`);
  if (!r.ok && (r.detail || r.note)) process.stdout.write(`${(r.detail || r.note).replace(/^/gm, '     ')}\n`);
});
process.exit(results.every((r) => r.ok) ? 0 : 1);
