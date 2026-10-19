#!/usr/bin/env node
// AWS Architecture Icons（npm の aws-icons）から、ビューアで使うものだけを viewer/public/icons/ にコピーする。
// Cytoscape は viewBox だけの SVG を正しい大きさで描けないので、viewBox と同じ width / height を付ける。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SRC = join(ROOT, 'node_modules/aws-icons/icons');
const DEST = join(ROOT, 'viewer/public/icons');

// コピー先の名前 → aws-icons 内のパス
export const ICON_FILES = Object.freeze({
  region: 'architecture-group/Region.svg',
  vpc: 'architecture-group/VirtualprivatecloudVPC.svg',
  'public-subnet': 'architecture-group/Publicsubnet.svg',
  'private-subnet': 'architecture-group/Privatesubnet.svg',
  'internet-gateway': 'resource/AmazonVPCInternetGateway.svg',
  'nat-gateway': 'resource/AmazonVPCNATGateway.svg',
  'vpc-endpoint': 'resource/AmazonVPCEndpoints.svg',
  alb: 'resource/ElasticLoadBalancingApplicationLoadBalancer.svg',
  nlb: 'resource/ElasticLoadBalancingNetworkLoadBalancer.svg',
  ec2: 'architecture-service/AmazonEC2.svg',
  ecs: 'architecture-service/AmazonElasticContainerService.svg',
  ecr: 'architecture-service/AmazonElasticContainerRegistry.svg',
  batch: 'architecture-service/AWSBatch.svg',
  lambda: 'architecture-service/AWSLambda.svg',
  rds: 'architecture-service/AmazonRDS.svg',
  aurora: 'architecture-service/AmazonAurora.svg',
  'rds-proxy': 'resource/AmazonRDSProxyInstance.svg',
  dynamodb: 'architecture-service/AmazonDynamoDB.svg',
  elasticache: 'architecture-service/AmazonElastiCache.svg',
  efs: 'architecture-service/AmazonEFS.svg',
  s3: 'architecture-service/AmazonSimpleStorageService.svg',
  sqs: 'architecture-service/AmazonSimpleQueueService.svg',
  sns: 'architecture-service/AmazonSimpleNotificationService.svg',
  'api-gateway': 'architecture-service/AmazonAPIGateway.svg',
  'eventbridge-bus': 'resource/AmazonEventBridgeCustomEventBus.svg',
  'eventbridge-rule': 'resource/AmazonEventBridgeRule.svg',
  'eventbridge-scheduler': 'resource/AmazonEventBridgeScheduler.svg',
  'eventbridge-pipes': 'resource/AmazonEventBridgePipes.svg',
  'step-functions': 'architecture-service/AWSStepFunctions.svg',
  kinesis: 'architecture-service/AmazonKinesisDataStreams.svg',
  firehose: 'architecture-service/AmazonDataFirehose.svg',
  cloudfront: 'architecture-service/AmazonCloudFront.svg',
  waf: 'architecture-service/AWSWAF.svg',
  codebuild: 'architecture-service/AWSCodeBuild.svg',
  codepipeline: 'architecture-service/AWSCodePipeline.svg',
  kms: 'architecture-service/AWSKeyManagementService.svg',
  cognito: 'architecture-service/AmazonCognito.svg',
  'secrets-manager': 'architecture-service/AWSSecretsManager.svg',
  'iam-role': 'resource/AWSIdentityAccessManagementRole.svg',
  'iam-permissions': 'resource/AWSIdentityAccessManagementPermissions.svg',
  iam: 'architecture-service/AWSIdentityandAccessManagement.svg',
  internet: 'resource/Internet.svg',
});

function withSize(svg) {
  const head = svg.slice(0, svg.indexOf('>'));
  if (/\swidth=/.test(head)) return svg;
  const [, w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/) ?? [];
  return w ? svg.replace('<svg ', `<svg width="${w}" height="${h}" `) : svg;
}

mkdirSync(DEST, { recursive: true });
const missing = Object.entries(ICON_FILES).filter(([name, file]) => {
  try {
    writeFileSync(join(DEST, `${name}.svg`), withSize(readFileSync(join(SRC, file), 'utf8')));
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  process.stderr.write(`見つからないアイコン: ${missing.map(([n, f]) => `${n} (${f})`).join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`${Object.keys(ICON_FILES).length} 個のアイコンをコピーしました\n`);
