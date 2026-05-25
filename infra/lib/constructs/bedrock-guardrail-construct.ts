import * as cdk from 'aws-cdk-lib';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import { Construct } from 'constructs';

export interface ContentFilterConfig {
  type: 'HATE' | 'INSULTS' | 'SEXUAL' | 'VIOLENCE' | 'MISCONDUCT' | 'PROMPT_ATTACK';
  inputStrength: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
  outputStrength: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface DeniedTopicConfig {
  name: string;
  definition: string;
  examples: string[];
}

export interface PiiEntityConfig {
  type: string;
  action: 'BLOCK' | 'ANONYMIZE';
}

export interface RegexFilterConfig {
  name: string;
  pattern: string;
  action: 'BLOCK' | 'ANONYMIZE';
}

export interface BedrockGuardrailProps {
  guardrailName: string;
  description?: string;
  contentFilters?: ContentFilterConfig[];
  deniedTopics?: DeniedTopicConfig[];
  piiEntities?: PiiEntityConfig[];
  regexFilters?: RegexFilterConfig[];
  managedWordLists?: ('PROFANITY')[];
  customWords?: string[];
  blockedInputMessage?: string;
  blockedOutputMessage?: string;
}

export class BedrockGuardrailConstruct extends Construct {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;
  public readonly guardrailArn: string;

  constructor(scope: Construct, id: string, props: BedrockGuardrailProps) {
    super(scope, id);

    // Build content policy config
    const filtersConfig = (props.contentFilters ?? []).map((f) => ({
      type: f.type,
      inputStrength: f.inputStrength,
      outputStrength: f.outputStrength,
    }));

    // Build topic policy config
    const topicsConfig = (props.deniedTopics ?? []).map((t) => ({
      name: t.name,
      definition: t.definition,
      examples: t.examples,
      type: 'DENY',
    }));

    // Build sensitive info policy
    const piiEntitiesConfig = (props.piiEntities ?? []).map((p) => ({
      type: p.type,
      action: p.action,
    }));

    const regexConfig = (props.regexFilters ?? []).map((r) => ({
      name: r.name,
      pattern: r.pattern,
      action: r.action,
    }));

    // Build word policy config
    const wordPolicyConfig: Record<string, unknown> = {};
    if (props.managedWordLists && props.managedWordLists.length > 0) {
      wordPolicyConfig.managedWordListsConfig = props.managedWordLists.map((w) => ({
        type: w,
      }));
    }
    if (props.customWords && props.customWords.length > 0) {
      wordPolicyConfig.wordsConfig = props.customWords.map((w) => ({
        text: w,
      }));
    }

    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: props.guardrailName,
      description: props.description ?? `PRISM D1 guardrail: ${props.guardrailName}`,
      blockedInputMessaging: props.blockedInputMessage ?? 'This request has been blocked by safety guardrails.',
      blockedOutputsMessaging: props.blockedOutputMessage ?? 'This response has been blocked by safety guardrails.',
      ...(filtersConfig.length > 0 && {
        contentPolicyConfig: {
          filtersConfig,
        },
      }),
      ...(topicsConfig.length > 0 && {
        topicPolicyConfig: {
          topicsConfig,
        },
      }),
      ...((piiEntitiesConfig.length > 0 || regexConfig.length > 0) && {
        sensitiveInformationPolicyConfig: {
          ...(piiEntitiesConfig.length > 0 && { piiEntitiesConfig }),
          ...(regexConfig.length > 0 && { regexesConfig: regexConfig }),
        },
      }),
      ...(Object.keys(wordPolicyConfig).length > 0 && {
        wordPolicyConfig,
      }),
      tags: [
        { key: 'prism:component', value: 'guardrail' },
        { key: 'prism:pillar', value: 'security' },
      ],
    });

    // Create a versioned snapshot
    const guardrailVersion = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: `PRISM D1 guardrail version for ${props.guardrailName}`,
    });

    guardrailVersion.addDependency(guardrail);

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailArn = guardrail.attrGuardrailArn;
    this.guardrailVersion = guardrailVersion.attrVersion;

    new cdk.CfnOutput(this, 'GuardrailIdOutput', {
      value: this.guardrailId,
      description: `Guardrail ID for ${props.guardrailName}`,
      exportName: `PrismD1GuardrailId-${props.guardrailName}`,
    });

    new cdk.CfnOutput(this, 'GuardrailVersionOutput', {
      value: this.guardrailVersion,
      description: `Guardrail version for ${props.guardrailName}`,
      exportName: `PrismD1GuardrailVersion-${props.guardrailName}`,
    });
  }
}

/**
 * Default PRISM guardrail configuration matching the template at
 * bootstrapper/agent-configs/guardrails-template.json
 */
export function createDefaultPrismGuardrailProps(): BedrockGuardrailProps {
  return {
    guardrailName: 'prism-d1-agent-guardrail',
    description: 'PRISM D1 default guardrail for AI agents — content safety, PII protection, and topic governance.',
    contentFilters: [
      { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'INSULTS', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'VIOLENCE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'MISCONDUCT', inputStrength: 'HIGH', outputStrength: 'HIGH' },
      { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
    ],
    deniedTopics: [
      {
        name: 'competitor-recommendations',
        definition: 'Recommending or endorsing competitor products or services.',
        examples: [
          'You should use Competitor X instead.',
          'Competitor Y has a better solution for this.',
        ],
      },
      {
        name: 'financial-advice',
        definition: 'Providing specific financial, investment, or tax advice.',
        examples: [
          'You should invest in stocks right now.',
          'This tax strategy will save you money.',
        ],
      },
    ],
    piiEntities: [
      { type: 'EMAIL', action: 'ANONYMIZE' },
      { type: 'PHONE', action: 'ANONYMIZE' },
      { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
      { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
    ],
    regexFilters: [
      {
        name: 'aws-access-key',
        pattern: 'AKIA[A-Z0-9]{16}',
        action: 'BLOCK',
      },
      {
        name: 'generic-api-key',
        pattern: 'sk-[a-zA-Z0-9]{32,}',
        action: 'BLOCK',
      },
    ],
    managedWordLists: ['PROFANITY'],
    blockedInputMessage: 'Your request was blocked by PRISM safety guardrails. Please rephrase.',
    blockedOutputMessage: 'The response was blocked by PRISM safety guardrails.',
  };
}
