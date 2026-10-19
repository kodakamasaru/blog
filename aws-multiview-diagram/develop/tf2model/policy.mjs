// IAM ポリシーを、書き方によらず同じ形（statement の配列）にそろえて読む。
//
// 実際のコードでのポリシーの書き方はいくつもあるので、取れるところから順に使う。
//   1. data "aws_iam_policy_document" … configuration の statement（actions は定数、resources は参照）
//   2. plan で値が確定した JSON     … jsonencode / ヒアドキュメント / 確定したポリシードキュメント
//                                       （Resource は ARN の文字列なので、arn.mjs で名前と突き合わせる）
//   3. 値が確定しない JSON          … 式の参照（どのリソースか）と、ソースに書かれた Action の文字列
import { refsOf, refsOfType, valueAt, UNKNOWN, stripIndex } from './plan.mjs';
import { resourcesForArn } from './arn.mjs';
import { isNodeResource } from './catalog.mjs';

/**
 * @typedef {{ actions: string[], resources: string[], wildcard: boolean, principals: string[],
 *   sourceArns: string[], source: string, estimated?: boolean }} Statement
 *   resources / sourceArns はノードのアドレス。source は「どこから読んだか」（根拠の表示用）
 */

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function policyContext(index, sources = {}) {
  return { index, sources, candidates: [...index.values()].filter(isNodeResource) };
}

function parseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** ポリシー JSON の Condition から aws:SourceArn の値を拾う */
function sourceArnsOf(condition = {}) {
  return Object.values(condition).flatMap((byKey) =>
    Object.entries(byKey ?? {})
      .filter(([k]) => k.toLowerCase() === 'aws:sourcearn')
      .flatMap(([, v]) => arr(v)),
  );
}

function fromJson(doc, ctx, source) {
  return arr(doc?.Statement)
    .filter((st) => (st.Effect ?? 'Allow') === 'Allow')
    .map((st) => {
      const resources = arr(st.Resource);
      return {
        actions: arr(st.Action),
        resources: [...new Set(resources.flatMap((r) => resourcesForArn(r, ctx.candidates)))],
        wildcard: resources.includes('*'),
        principals: arr(st.Principal?.Service).concat(st.Principal === '*' ? ['*'] : []),
        sourceArns: [...new Set(sourceArnsOf(st.Condition).flatMap((a) => resourcesForArn(a, ctx.candidates)))],
        source,
      };
    });
}

function fromPolicyDocument(doc, ctx) {
  const configStatements = (doc.expressions.statement ?? []).map((st) => ({
    actions: st.actions?.constant_value ?? [],
    resources: refsOf(st.resources, ctx.index),
    wildcard: (st.resources?.constant_value ?? []).includes('*'),
    principals: (st.principals ?? []).flatMap((p) => p.identifiers?.constant_value ?? []),
    sourceArns: (st.condition ?? []).filter((c) => c.variable?.constant_value === 'aws:SourceArn').flatMap((c) => refsOf(c.values, ctx.index)),
    source: doc.address,
  }));
  // dynamic "statement" や source_policy_documents は configuration に現れないので、確定した JSON も読む
  const json = valueAt(doc, 'json');
  const fromValues = json === UNKNOWN ? [] : fromJson(parseJson(json), ctx, doc.address);
  return [...configStatements, ...fromValues];
}

/** 値が確定しない JSON のポリシー: 参照しているノードと、ソースに書かれた Action / Service を使う */
function fromUnknownJson(owner, attr, ctx) {
  const code = (ctx.sources[owner.address] ?? ctx.sources[stripIndex(owner.address)])?.code ?? '';
  const actions = [...new Set([...code.matchAll(/"([a-z0-9-]+:[A-Za-z0-9*]+)"/g)].map((m) => m[1]))].filter((a) => !a.startsWith('aws:'));
  const principals = [...new Set([...code.matchAll(/([a-z0-9-]+\.amazonaws\.com)/g)].map((m) => m[1]))];
  const resources = refsOf(owner.expressions[attr], ctx.index).filter((a) => isNodeResource(ctx.index.get(a)));
  return [{ actions, resources, wildcard: /"Resource"\s*:\s*"\*"|Resource\s*=\s*"\*"/.test(code), principals, sourceArns: [], source: owner.address, estimated: true }];
}

/**
 * owner の attr（policy や assume_role_policy）に書かれたポリシーを読む
 * @returns {Statement[]}
 */
export function statementsOf(owner, attr, ctx) {
  const docs = refsOfType(owner.expressions[attr], ctx.index, 'aws_iam_policy_document');
  if (docs.length) return docs.flatMap((d) => fromPolicyDocument(ctx.index.get(d), ctx));
  const value = valueAt(owner, attr);
  if (value === UNKNOWN) return fromUnknownJson(owner, attr, ctx);
  const json = parseJson(value);
  return json ? fromJson(json, ctx, owner.address) : [];
}

/** ロールのインラインポリシー（inline_policy ブロック）は値として plan に入る */
export function inlinePoliciesOf(role, ctx) {
  return arr(role.values.inline_policy).flatMap((p) => fromJson(parseJson(p.policy), ctx, role.address));
}

/** "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" → "AWSLambdaBasicExecutionRole" */
export function managedPolicyName(arn) {
  return typeof arn === 'string' && arn.includes(':iam::aws:policy/') ? arn.split('/').at(-1) : null;
}
