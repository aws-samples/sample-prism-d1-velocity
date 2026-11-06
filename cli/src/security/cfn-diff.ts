/**
 * Resource-level diff between the deployed CloudFormation template and the
 * one `cdk synth` produced, used for the summary shown before confirmation.
 *
 * `cdk diff` is still run (its full text goes to a file the summary points
 * at), but its output is human-oriented and changes between CDK versions, so
 * the summary is computed from the two templates directly. It answers what the
 * confirmation needs: how many resources are added, changed or removed, which
 * of those touch IAM, network or public endpoints, and whether any of them are
 * the Security Agent resources at all.
 */

export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
}
interface CfnResource {
  Type: string;
  Properties?: unknown;
  DependsOn?: unknown;
  Condition?: unknown;
  Metadata?: Record<string, unknown>;
}

export type ChangeKind = 'add' | 'modify' | 'remove';
export type Category = 'iam' | 'network' | 'endpoint' | 'other';

export interface ResourceChange {
  logicalId: string;
  type: string;
  /** CDK construct path without the stack prefix, e.g. SecurityAgent/ScanBucket/Resource. */
  path: string;
  change: ChangeKind;
  category: Category;
  /** Part of the Security Agent feature (the SecurityAgent construct or the CI policy). */
  securityAgent: boolean;
}

export interface TemplateDiff {
  newStack: boolean;
  changes: ResourceChange[];
  counts: Record<ChangeKind, number>;
  /** Any change to a Security Agent resource. */
  touchesSecurityAgent: boolean;
  /** The deployed template already has an agent space. */
  deployedHasSecurityAgent: boolean;
}

/**
 * Construct path prefixes (after the stack name) that make up the Security
 * Agent feature. The auto-delete provider is a stack-level singleton CDK adds
 * for the scan bucket's autoDeleteObjects; measured on a real synth, it is
 * the only thing enableSecurityAgent adds outside the SecurityAgent construct.
 */
export const SECURITY_AGENT_PATHS = ['SecurityAgent/', 'ContinuumCiPolicy/', 'Custom::S3AutoDeleteObjectsCustomResourceProvider/'];

const IGNORED_TYPES = new Set(['AWS::CDK::Metadata']);

export function categorize(type: string): Category {
  if (/^AWS::IAM::/.test(type) || /^AWS::(S3::BucketPolicy|KMS::Key|KMS::Grant|Lambda::Permission|SQS::QueuePolicy|SNS::TopicPolicy|Events::EventBusPolicy)$/.test(type)) return 'iam';
  if (/^AWS::EC2::(SecurityGroup|SecurityGroupIngress|SecurityGroupEgress|VPC|Subnet|InternetGateway|NatGateway|EIP|Route|RouteTable|VPCEndpoint|NetworkAcl)/.test(type)) return 'network';
  if (/^AWS::(ApiGateway::|ApiGatewayV2::|ElasticLoadBalancing|ElasticLoadBalancingV2::|CloudFront::|Lambda::Url$|Cognito::UserPoolDomain$|AppSync::)/.test(type)) return 'endpoint';
  return 'other';
}

function cdkPath(r: CfnResource | undefined, stackName: string): string {
  const p = r?.Metadata?.['aws:cdk:path'];
  if (typeof p !== 'string') return '';
  return p.startsWith(stackName + '/') ? p.slice(stackName.length + 1) : p;
}

function comparable(r: CfnResource): string {
  return JSON.stringify({ t: r.Type, p: r.Properties ?? null, d: r.DependsOn ?? null, c: r.Condition ?? null });
}

/** `deployed` is null when the stack does not exist yet. */
export function diffTemplates(deployed: CfnTemplate | null, synthesized: CfnTemplate, stackName: string): TemplateDiff {
  const before = deployed?.Resources ?? {};
  const after = synthesized.Resources ?? {};
  const changes: ResourceChange[] = [];
  const add = (logicalId: string, r: CfnResource, change: ChangeKind) => {
    if (IGNORED_TYPES.has(r.Type)) return;
    const path = cdkPath(r, stackName) || logicalId;
    changes.push({
      logicalId, type: r.Type, path, change, category: categorize(r.Type),
      securityAgent: SECURITY_AGENT_PATHS.some((p) => path.startsWith(p)),
    });
  };
  for (const [id, r] of Object.entries(after)) {
    if (!(id in before)) add(id, r, 'add');
    else if (comparable(before[id]) !== comparable(r)) add(id, r, 'modify');
  }
  for (const [id, r] of Object.entries(before)) if (!(id in after)) add(id, r, 'remove');
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const counts = { add: 0, modify: 0, remove: 0 };
  for (const c of changes) counts[c.change]++;
  return {
    newStack: deployed === null,
    changes,
    counts,
    touchesSecurityAgent: changes.some((c) => c.securityAgent),
    deployedHasSecurityAgent: Object.values(before).some((r) => r.Type === 'AWS::SecurityAgent::AgentSpace'),
  };
}

const SIGN: Record<ChangeKind, string> = { add: '+', modify: '~', remove: '-' };
const HEADINGS: Record<Category, string> = {
  iam: 'IAM and resource policies',
  network: 'Security groups and network',
  endpoint: 'Public endpoints (API Gateway, load balancers, CloudFront, Cognito domains, function URLs)',
  other: 'Other resources',
};

/** Lines for the summary. Every IAM, network and endpoint change is listed by name; other resources are counted by type. */
export function formatDiff(d: TemplateDiff, stackName: string): string[] {
  const L: string[] = [];
  const { add, modify, remove } = d.counts;
  L.push(`Stack ${stackName}${d.newStack ? ' (new stack)' : ''}: ${add} to add, ${modify} to change, ${remove} to remove`);
  if (!d.changes.length) { L.push('  No changes.'); return L; }
  for (const cat of ['iam', 'network', 'endpoint'] as Category[]) {
    const items = d.changes.filter((c) => c.category === cat);
    L.push(`  ${HEADINGS[cat]}:${items.length ? '' : ' none'}`);
    for (const c of items) L.push(`    ${SIGN[c.change]} ${c.type}  ${c.path}`);
  }
  const other = d.changes.filter((c) => c.category === 'other');
  if (other.length) {
    L.push(`  ${HEADINGS.other}:`);
    const groups = new Map<string, number>();
    for (const c of other) groups.set(`${SIGN[c.change]} ${c.type}`, (groups.get(`${SIGN[c.change]} ${c.type}`) ?? 0) + 1);
    for (const [k, n] of [...groups].sort()) L.push(`    ${k}${n > 1 ? ` x${n}` : ''}`);
  }
  if (remove) L.push(`  WARNING: ${remove} resource(s) would be REMOVED. If your stack was deployed with extra context (for example -c skipVpc=true), pass the same values with --context.`);
  const outside = d.changes.filter((c) => !c.securityAgent).length;
  if (!d.newStack && outside) L.push(`  ${outside} of these changes are outside the Security Agent resources (the local infra code differs from what is deployed).`);
  return L;
}
