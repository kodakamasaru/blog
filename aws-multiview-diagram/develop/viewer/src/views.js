// 視点ごとの説明文と凡例。凡例の線種は cyStyle.js のエッジのスタイルと対応させている。
export const VIEWS = Object.freeze({
  network: {
    key: '1',
    label: 'Network',
    layout: { direction: 'RIGHT', layerGap: 70, nodeGap: 48 },
    ja: 'NW フロー',
    desc: [['どこに置かれ'], ['、'], ['どこからの通信が許可されているか', true], ['。SG ルールとルートテーブルから描いています。']],
    legend: [
      { kind: 'sg', text: 'SG で許可された通信（ポート）' },
      { kind: 'route', text: 'ルートテーブルの経路' },
    ],
  },
  iam: {
    key: '2',
    label: 'IAM',
    layout: { direction: 'RIGHT', layerGap: 190, nodeGap: 24 },
    ja: 'IAM フロー',
    desc: [['誰が・どのロールで'], ['、'], ['何に対して何をできるか', true], ['。ロールとポリシードキュメントから描いています。']],
    legend: [
      { kind: 'assume', text: 'ロールを使う' },
      { kind: 'allow', text: 'ポリシーで許可された操作' },
      { kind: 'resource-policy', text: 'リソースベースポリシー' },
    ],
  },
  data: {
    key: '3',
    label: 'Data',
    layout: { direction: 'RIGHT', layerGap: 96, nodeGap: 56 },
    ja: 'データフロー',
    desc: [['データが'], ['どこからどこへ流れるか', true], ['。IaC に書かれた配線に加え、「接続先を知っている × 権限 or 通信が許可されている」から推定しています。']],
    legend: [
      { kind: 'flow', text: 'IaC に配線がある流れ' },
      { kind: 'flow-inferred', text: '推定した流れ（参照 × 許可）' },
    ],
  },
  unified: {
    key: '4',
    label: 'Unified',
    layout: { direction: 'RIGHT', layerGap: 80, nodeGap: 44, hierarchy: 'SEPARATE_CHILDREN' },
    ja: '統合',
    desc: [['配置は1つのまま、'], ['線のレイヤーを切り替えて', true], ['見ます。ロールは箱にせず「使う側 → 相手」の権限の線にまとめています。']],
    legend: [],
  },
});

export const VIEW_NAMES = Object.keys(VIEWS);

// 統合ビューの線のレイヤー。色は各視点の色（--view-*）を使う
export const LAYERS = Object.freeze({
  network: { label: 'ネットワーク', note: 'SG・経路' },
  data: { label: 'データ', note: '流れ（破線は推定）' },
  iam: { label: '権限', note: '使う側 → 相手' },
});
export const LAYER_NAMES = Object.keys(LAYERS);
export const DEFAULT_LAYERS = Object.freeze(['network', 'data']);
