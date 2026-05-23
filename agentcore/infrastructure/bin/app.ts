import { App } from 'aws-cdk-lib';
import { AgentCoreReferenceStack } from '../agentcore-stack.ts';

const app = new App();

const stackName = process.env['STACK_NAME'] ?? 'airlock-agentcore-reference';
const region = process.env['AWS_REGION'] ?? process.env['CDK_DEFAULT_REGION'] ?? 'us-west-2';
const account = process.env['CDK_DEFAULT_ACCOUNT'];

new AgentCoreReferenceStack(app, stackName, {
  env: { account, region },
  orgSlug: requireEnv('AIRLOCK_ORG_SLUG'),
  agentName: requireEnv('AIRLOCK_AGENT_NAME'),
  apiBaseUrl: process.env['AIRLOCK_API_BASE_URL'] ?? 'https://api.air-lock.ai',
  serviceTokenSecretArn: requireEnv('AIRLOCK_TOKEN_SECRET_ARN'),
  // Switch to `build-time-export.js` if you ran `npm run export-agent` first.
  entryPoint: process.env['AGENT_ENTRYPOINT'] ?? 'index.js',
});

app.synth();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
