/**
 * S3 key of the LiteLLM price table, shared by the receiver, the refresh
 * Lambda and the CDK grants. Its own module so the CDK app can import it
 * without pulling in the AWS SDK or the bundled snapshot.
 */
export const PRICES_KEY = 'pricing/litellm-prices.json';
