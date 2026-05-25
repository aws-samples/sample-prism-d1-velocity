/**
 * PRISM D1 Guardrail Enforcer — Lambda layer for Bedrock Guardrail enforcement.
 *
 * Usage:
 *   const { enforceGuardrail } = require('guardrail-enforcer');
 *   const result = await enforceGuardrail(inputText);
 *   if (result.blocked) { ... }
 */

const { BedrockRuntimeClient, ApplyGuardrailCommand } = require('@aws-sdk/client-bedrock-runtime');

const client = new BedrockRuntimeClient({});
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION || 'DRAFT';

/**
 * Apply the PRISM guardrail to input or output text.
 * @param {string} text - The text to check
 * @param {'INPUT'|'OUTPUT'} source - Whether this is input or output
 * @returns {Promise<{blocked: boolean, action: string, outputs: any[]}>}
 */
async function enforceGuardrail(text, source = 'INPUT') {
  if (!GUARDRAIL_ID) {
    console.warn('GUARDRAIL_ID not set, skipping enforcement');
    return { blocked: false, action: 'NONE', outputs: [] };
  }

  try {
    const response = await client.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: GUARDRAIL_ID,
        guardrailVersion: GUARDRAIL_VERSION,
        source,
        content: [{ text: { text } }],
      }),
    );

    const action = response.action || 'NONE';
    const blocked = action === 'GUARDRAIL_INTERVENED';

    return {
      blocked,
      action,
      outputs: response.outputs || [],
      assessments: response.assessments || [],
    };
  } catch (err) {
    console.error('Guardrail enforcement failed:', err);
    return { blocked: false, action: 'ERROR', outputs: [], error: err.message };
  }
}

module.exports = { enforceGuardrail };
