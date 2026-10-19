// .tf ファイルから次の2つを取り出す。plan JSON にはどちらも含まれないため。
//   - 各 resource / data ブロックの位置とコード片（詳細パネルで「ここに書いてある」を出すため）
//   - locals の各値が参照しているもの（plan JSON の configuration には locals の中身が無いので、参照を辿るのに使う）
// モジュールのコードは terraform init が .terraform/modules/ に置くので、modules.json を見て一緒に読む。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const BLOCK_START = /^(resource|data)\s+"([\w-]+)"\s+"([\w-]+)"\s*\{/;
const LOCALS_START = /^locals\s*\{/;
const DYNAMIC_START = /^\s*dynamic\s+"([\w-]+)"\s*\{/;
const LOCAL_ENTRY = /^\s*([A-Za-z_][\w-]*)\s*=(?!=)/;

// 参照になりうる文字列（module.x.y / data.t.n / var.x / local.x / type.name）
const REF_PATTERN = /\b(module\.[\w-]+(?:\.[\w-]+)?|data\.[\w-]+\.[\w-]+|var\.[\w-]+|local\.[\w-]+|[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z_][\w-]*)/g;

// コード片に直書きされた機密値を伏せる（ソースをそのまま図と一緒に配布してしまわないように）
const SECRET_ASSIGNMENT = /^(\s*[\w-]*(?:password|secret|token|private_key|access_key)[\w-]*\s*=\s*)"[^"]*"/gim;

export function maskSecrets(code) {
  return code.replace(SECRET_ASSIGNMENT, '$1"********"');
}

const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/g;

/**
 * コード片のうち、ある属性（"input = jsonencode({...})" など）の中の文字列リテラル。
 * ${...} の補間はワイルドカード（*）にする。plan で値が未確定のときに、ソースから行き先を推定するのに使う
 */
export function attributeLiterals(code, attr) {
  const lines = code.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^\\s*${attr}\\s*=(?!=)`).test(l));
  if (start < 0) return [];
  const text = lines.slice(start, blockEnd(lines, start) + 1).join('\n');
  return [...new Set([...text.matchAll(STRING_LITERAL)].map((m) => m[1].replace(/\$\{[^}]*\}/g, '*')))];
}

/** plan で sensitive だった値が文字列リテラルとして書かれていたら伏せる（属性名で判別できない value = "..." など） */
export function maskLiterals(code, secrets) {
  return secrets.reduce((acc, s) => acc.replaceAll(`"${s}"`, '"********"'), code);
}

function bracketDelta(line) {
  const opens = (line.match(/[{[(]/g) ?? []).length;
  const closes = (line.match(/[}\])]/g) ?? []).length;
  return opens - closes;
}

/** 開き括弧の行から、対応する閉じ括弧の行までを返す（文字列中の括弧も ${} で対になるので数えるだけで足りる） */
function blockEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    depth += bracketDelta(lines[i]);
    if (depth === 0) return i;
  }
  return lines.length - 1;
}

export function refsInText(text) {
  return [...new Set([...text.matchAll(REF_PATTERN)].map((m) => m[1]))];
}

/**
 * @param {string} prefix モジュールのアドレス（"module.vpc." など。ルートは ""）
 * @returns {Record<string, { file: string, line: number, code: string }>}
 */
export function scanSource(fileName, text, prefix = '') {
  const lines = text.split('\n');
  return Object.fromEntries(
    lines.flatMap((line, i) => {
      const m = line.match(BLOCK_START);
      if (!m) return [];
      const [, mode, type, name] = m;
      const address = `${prefix}${mode === 'data' ? `data.${type}.${name}` : `${type}.${name}`}`;
      const code = maskSecrets(lines.slice(i, blockEnd(lines, i) + 1).join('\n'));
      return [[address, { file: fileName, line: i + 1, code }]];
    }),
  );
}

/**
 * resource ブロックの中の dynamic ブロックに出てくる参照（plan JSON の configuration には dynamic の中身が出ないため）
 * @returns {Record<string, Record<string, string[]>>} ブロックのアドレス → dynamic の名前 → 参照
 */
export function parseDynamics(text, prefix = '') {
  const lines = text.split('\n');
  return Object.fromEntries(
    lines.flatMap((line, start) => {
      const m = line.match(BLOCK_START);
      if (!m) return [];
      const [, mode, type, name] = m;
      const end = blockEnd(lines, start);
      const dynamics = {};
      for (let i = start + 1; i < end; i += 1) {
        const d = lines[i].match(DYNAMIC_START);
        if (!d) continue;
        const dEnd = blockEnd(lines, i);
        const iterator = new RegExp(`^${d[1]}\\.`);
        const refs = refsInText(lines.slice(i, dEnd + 1).join('\n')).filter((r) => !iterator.test(r));
        dynamics[d[1]] = [...new Set([...(dynamics[d[1]] ?? []), ...refs])];
      }
      if (Object.keys(dynamics).length === 0) return [];
      return [[`${prefix}${mode === 'data' ? `data.${type}.${name}` : `${type}.${name}`}`, dynamics]];
    }),
  );
}

const MODULE_START = /^module\s+"([\w-]+)"\s*\{/;
const MAP_ARGUMENT = /^\s*([\w-]+)\s*=\s*\{\s*$/;
// キー = { ... } のブロックも、キー = 式（複数行のリストを含む）の属性も、キーごとに参照を拾う
const MAP_ENTRY = /^\s*"?([\w.-]+)"?\s*=(?!=)/;

/** ブロックの中で、深さ1（直下）にある行のうち pattern に合うものを、その行から閉じ括弧までの範囲と一緒に返す */
function childBlocks(lines, start, end, pattern) {
  const found = [];
  let depth = 0;
  for (let i = start + 1; i < end; i += 1) {
    const m = depth === 0 ? lines[i].match(pattern) : null;
    if (m) {
      const close = blockEnd(lines, i);
      found.push({ name: m[1], start: i, end: close });
      i = close;
      continue;
    }
    depth += bracketDelta(lines[i]);
  }
  return found;
}

/**
 * module ブロックに渡している「キーごとの設定を並べた map」の、キーごとの参照。
 *   endpoints = { s3 = { ... }, rds = { security_group_ids = [module.rds_sg.id] } }
 * モジュール側は for_each = var.endpoints と each.value で使うので、インスタンスのキー（"rds"）ごとに参照を分けられる。
 * @returns {Record<string, Record<string, Record<string, string[]>>>} モジュール名 → 引数名 → キー → 参照
 */
export function parseModuleMapArgs(text) {
  const lines = text.split('\n');
  return Object.fromEntries(
    lines.flatMap((line, start) => {
      const m = line.match(MODULE_START);
      if (!m) return [];
      const end = blockEnd(lines, start);
      const args = childBlocks(lines, start, end, MAP_ARGUMENT).map((arg) => [
        arg.name,
        Object.fromEntries(childBlocks(lines, arg.start, arg.end, MAP_ENTRY).map((e) => [e.name, refsInText(lines.slice(e.start, e.end + 1).join('\n').replace(MAP_ENTRY, ''))])),
      ]);
      return [[m[1], Object.fromEntries(args.filter(([, entries]) => Object.keys(entries).length))]];
    }),
  );
}

/** locals { a = ..., b = ... } の各値に出てくる参照 */
export function parseLocals(text) {
  const lines = text.split('\n');
  const result = {};
  lines.forEach((line, start) => {
    if (!LOCALS_START.test(line)) return;
    const end = blockEnd(lines, start);
    let depth = 0;
    let current = null;
    for (let i = start + 1; i < end; i += 1) {
      const entry = depth === 0 ? lines[i].match(LOCAL_ENTRY) : null;
      if (entry) {
        current = entry[1];
        result[current] = [];
      }
      if (current) result[current] = [...new Set([...result[current], ...refsInText(lines[i].replace(LOCAL_ENTRY, ''))])];
      depth += bracketDelta(lines[i]);
    }
  });
  return result;
}

function tfFiles(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.tf')).sort() : [];
}

/** terraform init が書く modules.json から「モジュールのアドレス → ディレクトリ」を作る */
function moduleDirs(stackDir) {
  const manifest = join(stackDir, '.terraform/modules/modules.json');
  const entries = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).Modules ?? [] : [];
  const fromManifest = entries
    .filter((m) => m.Key)
    .map((m) => [m.Key.split('.').map((k) => `module.${k}`).join('.'), join(stackDir, m.Dir)]);
  return [['', stackDir], ...fromManifest];
}

/**
 * @returns {{ sources: Record<string, object>, locals: Record<string, Record<string, string[]>>, dynamics: Record<string, object> }}
 *   locals のキーはモジュールのアドレス（ルートは ""）。dynamics のキーはブロックのアドレス
 */
export function scanStack(stackDir) {
  return moduleDirs(stackDir).reduce(
    (acc, [modulePath, dir]) => {
      const prefix = modulePath ? `${modulePath}.` : '';
      const files = tfFiles(dir).map((f) => ({ f, text: readFileSync(join(dir, f), 'utf8') }));
      const label = (f) => relative(stackDir, join(dir, f)).replace(/^\.terraform\/modules\//, '');
      const sources = files.reduce((s, { f, text }) => ({ ...s, ...scanSource(label(f), text, prefix) }), {});
      const locals = files.reduce((l, { text }) => ({ ...l, ...parseLocals(text) }), {});
      const dynamics = files.reduce((d, { text }) => ({ ...d, ...parseDynamics(text, prefix) }), {});
      // 子モジュールのアドレス（module.a.module.b）をキーにする
      const mapArgs = Object.fromEntries(
        Object.entries(files.reduce((a, { text }) => ({ ...a, ...parseModuleMapArgs(text) }), {})).map(([name, args]) => [`${prefix}module.${name}`, args]),
      );
      return {
        sources: { ...acc.sources, ...sources },
        locals: { ...acc.locals, [modulePath]: locals },
        dynamics: { ...acc.dynamics, ...dynamics },
        moduleMapArgs: { ...acc.moduleMapArgs, ...mapArgs },
      };
    },
    { sources: {}, locals: {}, dynamics: {}, moduleMapArgs: {} },
  );
}

/** 互換用: ルートモジュールのコード片だけ */
export function scanSourceDir(dir) {
  return scanStack(dir).sources;
}
