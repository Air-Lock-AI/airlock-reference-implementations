/**
 * CDK stack: AgentCore Runtime + IAM role for the reference agent.
 *
 * Ownership boundary:
 *   - **You own:** this stack, the AgentCore Runtime, the IAM role, the
 *     Secrets Manager entry for the service token, and the CloudWatch
 *     observability surface for the runtime.
 *   - **Airlock owns:** the agent definition, the tool catalog, policy
 *     enforcement, approval flow, audit log, and budget enforcement.
 *
 * The runtime never re-implements tool execution. Every tool call goes back
 * through Airlock's MCP endpoint (the URL+headers the `claude-sdk` adapter
 * baked into the rendered config), where policy/approval/audit run.
 */

import {
  Stack,
  type StackProps,
  CfnOutput,
  RemovalPolicy,
  Duration,
  aws_iam as iam,
  aws_s3_assets as s3assets,
  aws_logs as logs,
} from 'aws-cdk-lib';
import { CfnResource } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { resolve } from 'node:path';

export interface AgentCoreReferenceStackProps extends StackProps {
  /** Airlock org MCP URL, e.g. `https://mcp.air-lock.ai/org/acme`. */
  mcpUrl: string;
  /** Airlock agent name (must exist in the Control Room). */
  agentName: string;
  /** Secrets Manager ARN holding the Airlock service token (plain string). */
  serviceTokenSecretArn: string;
  /** Bundled entrypoint filename — `index.js` or `build-time-export.js`. */
  entryPoint: string;
}

export class AgentCoreReferenceStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentCoreReferenceStackProps) {
    super(scope, id, props);

    // The `npm run bundle` step writes the deployable artifact here.
    const bundlePath = resolve(import.meta.dirname, '..', 'dist');
    const asset = new s3assets.Asset(this, 'AgentBundle', {
      path: bundlePath,
    });

    const role = new iam.Role(this, 'RuntimeRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Execution role for the Airlock reference AgentCore Runtime',
    });

    // Bedrock model invocation — needed for the LLM loop the SDK drives.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['*'],
      }),
    );

    // Read the service token at cold start. Scope to the one secret ARN.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.serviceTokenSecretArn],
      }),
    );

    // CloudWatch logs — the runtime writes to /aws/bedrock-agentcore/runtimes/{id}-DEFAULT.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogGroup'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`],
      }),
    );

    // Pull the bundle out of the CDK staging bucket.
    asset.grantRead(role);

    // 14-day log retention to keep dev costs predictable; tune for prod.
    new logs.LogRetention(this, 'RuntimeLogRetention', {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${this.stackName}-DEFAULT`,
      retention: logs.RetentionDays.TWO_WEEKS,
    });

    // No L2 construct for AgentCore Runtime yet (as of May 2026) — use the
    // L1 CFN resource directly. AWS::BedrockAgentCore::Runtime supports both
    // ContainerConfiguration and CodeConfiguration; we use CodeConfiguration
    // (NODE_22) for the zip-deploy path.
    const runtime = new CfnResource(this, 'Runtime', {
      type: 'AWS::BedrockAgentCore::Runtime',
      properties: {
        AgentRuntimeName: this.stackName.replaceAll('-', '_').slice(0, 47),
        Description: `Airlock reference agent (${props.agentName} @ ${props.mcpUrl})`,
        RoleArn: role.roleArn,
        ProtocolConfiguration: 'HTTP',
        NetworkConfiguration: { NetworkMode: 'PUBLIC' },
        AgentRuntimeArtifact: {
          CodeConfiguration: {
            Code: {
              S3: {
                Bucket: asset.s3BucketName,
                Prefix: asset.s3ObjectKey,
              },
            },
            EntryPoint: [props.entryPoint],
            Runtime: 'NODE_22',
          },
        },
        EnvironmentVariables: {
          AIRLOCK_MCP_URL: props.mcpUrl,
          AIRLOCK_AGENT_NAME: props.agentName,
          AIRLOCK_TOKEN_SECRET_ARN: props.serviceTokenSecretArn,
        },
      },
    });
    runtime.applyRemovalPolicy(RemovalPolicy.DESTROY);
    runtime.node.addDependency(role);

    new CfnOutput(this, 'AgentRuntimeArn', {
      value: runtime.ref,
      description: 'ARN to pass as agentRuntimeArn in InvokeAgentRuntimeCommand',
    });
    new CfnOutput(this, 'RuntimeRoleArn', { value: role.roleArn });

    // Suppress the unused-warning for Duration; kept exported in case the
    // user wires up a custom resource that needs a timeout.
    void Duration;
  }
}
