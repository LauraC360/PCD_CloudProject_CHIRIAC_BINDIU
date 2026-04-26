import * as cdk from 'aws-cdk-lib/core';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export class InfraStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly viewEventsDlq: sqs.Queue;
  public readonly viewEventsQueue: sqs.Queue;
  public readonly movieStatsTable: dynamodb.Table;
  public readonly processedEventsTable: dynamodb.Table;
  public readonly recentActivityTable: dynamodb.Table;
  public readonly cloudMapNamespace: servicediscovery.PrivateDnsNamespace;
  public readonly wsgCloudMapService: servicediscovery.Service;
  // SSM SecureString parameters — must be created before `cdk deploy`
  // via infrastructure/ssm/create-ssm-params.sh
  public readonly internalSecretParam: ssm.IStringParameter;
  public readonly mongoUrlParam: ssm.IStringParameter;
  // IAM role for Lambda event-processor (Task 2.1)
  public readonly eventProcessorRole: iam.Role;
  // Lambda function: event-processor (Task 2.2)
  public readonly eventProcessorFn: lambda.Function;
  // Security groups (Task 2.4) — created together so they can reference each other
  public readonly lambdaSg: ec2.SecurityGroup;  // assigned to Lambda
  public readonly wsgSg: ec2.SecurityGroup;     // assigned to WSG ECS task (used in Task 3.6)
  // Cognito User Pool (Task 5)
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC: 2 public + 2 private subnets across 2 AZs.
    // No NAT Gateway — App Runner has outbound internet natively;
    // Lambda and ECS tasks in private subnets reach the internet via VPC endpoints
    // or are kept within the VPC for internal communication only.
    this.vpc = new ec2.Vpc(this, 'AnalyticsVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Output VPC ID for reference
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'Analytics VPC ID',
      exportName: 'AnalyticsVpcId',
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: this.vpc.publicSubnets.map(s => s.subnetId).join(','),
      description: 'Public subnet IDs (2 AZs)',
      exportName: 'AnalyticsPublicSubnetIds',
    });

    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: this.vpc.isolatedSubnets.map(s => s.subnetId).join(','),
      description: 'Private isolated subnet IDs (2 AZs)',
      exportName: 'AnalyticsPrivateSubnetIds',
    });

    // SQS Dead Letter Queue: view-events-dlq (Requirement 2.3, 2.4)
    this.viewEventsDlq = new sqs.Queue(this, 'ViewEventsDlq', {
      queueName: 'view-events-dlq',
      retentionPeriod: Duration.days(4),
    });

    new cdk.CfnOutput(this, 'ViewEventsDlqUrl', {
      value: this.viewEventsDlq.queueUrl,
      description: 'SQS view-events-dlq queue URL',
      exportName: 'AnalyticsViewEventsDlqUrl',
    });

    new cdk.CfnOutput(this, 'ViewEventsDlqArn', {
      value: this.viewEventsDlq.queueArn,
      description: 'SQS view-events-dlq queue ARN',
      exportName: 'AnalyticsViewEventsDlqArn',
    });

    // SQS Standard Queue: view-events
    // visibilityTimeout must exceed Lambda timeout (30s) per Requirement 2.1
    this.viewEventsQueue = new sqs.Queue(this, 'ViewEventsQueue', {
      queueName: 'view-events',
      visibilityTimeout: Duration.seconds(60),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: {
        queue: this.viewEventsDlq,
        maxReceiveCount: 3,
      },
    });

    new cdk.CfnOutput(this, 'ViewEventsQueueUrl', {
      value: this.viewEventsQueue.queueUrl,
      description: 'SQS view-events queue URL',
      exportName: 'AnalyticsViewEventsQueueUrl',
    });

    new cdk.CfnOutput(this, 'ViewEventsQueueArn', {
      value: this.viewEventsQueue.queueArn,
      description: 'SQS view-events queue ARN',
      exportName: 'AnalyticsViewEventsQueueArn',
    });

    // DynamoDB table: MovieStats (Requirement 4.1, 4.2, 4.4)
    // PK: movieId (String), billing: PAY_PER_REQUEST
    // GSI: viewCount-index — PK: pk (String), SK: viewCount (Number), projection: ALL
    // The `pk` attribute is set to the fixed string "STATS" on every item,
    // enabling a Query on the GSI sorted by viewCount descending to get the top-10.
    this.movieStatsTable = new dynamodb.Table(this, 'MovieStatsTable', {
      tableName: 'MovieStats',
      partitionKey: { name: 'movieId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.movieStatsTable.addGlobalSecondaryIndex({
      indexName: 'viewCount-index',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'viewCount', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    new cdk.CfnOutput(this, 'MovieStatsTableName', {
      value: this.movieStatsTable.tableName,
      description: 'DynamoDB MovieStats table name',
      exportName: 'AnalyticsMovieStatsTableName',
    });

    new cdk.CfnOutput(this, 'MovieStatsTableArn', {
      value: this.movieStatsTable.tableArn,
      description: 'DynamoDB MovieStats table ARN',
      exportName: 'AnalyticsMovieStatsTableArn',
    });

    // DynamoDB table: ProcessedEvents (Requirement 11 — idempotency)
    // PK: requestId (String), billing: PAY_PER_REQUEST
    // TTL on attribute `ttl` — items expire after 24h to prevent duplicate view counts
    this.processedEventsTable = new dynamodb.Table(this, 'ProcessedEventsTable', {
      tableName: 'ProcessedEvents',
      partitionKey: { name: 'requestId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      deletionProtection: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'ProcessedEventsTableName', {
      value: this.processedEventsTable.tableName,
      description: 'DynamoDB ProcessedEvents table name',
      exportName: 'AnalyticsProcessedEventsTableName',
    });

    new cdk.CfnOutput(this, 'ProcessedEventsTableArn', {
      value: this.processedEventsTable.tableArn,
      description: 'DynamoDB ProcessedEvents table ARN',
      exportName: 'AnalyticsProcessedEventsTableArn',
    });

    // DynamoDB table: RecentActivity (Requirement 7.1 — recent activity feed)
    // PK: pk (String, day-scoped "ACTIVITY#YYYY-MM-DD"), SK: viewedAt (Number)
    // TTL on attribute `ttl` — items expire automatically
    this.recentActivityTable = new dynamodb.Table(this, 'RecentActivityTable', {
      tableName: 'RecentActivity',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'viewedAt', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      deletionProtection: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'RecentActivityTableName', {
      value: this.recentActivityTable.tableName,
      description: 'DynamoDB RecentActivity table name',
      exportName: 'AnalyticsRecentActivityTableName',
    });

    new cdk.CfnOutput(this, 'RecentActivityTableArn', {
      value: this.recentActivityTable.tableArn,
      description: 'DynamoDB RecentActivity table ARN',
      exportName: 'AnalyticsRecentActivityTableArn',
    });

    // Cloud Map: private DNS namespace `local` in the VPC (Task 1.8)
    // Lambda uses this to resolve `wsg.local` → ECS task IP on port 8081
    this.cloudMapNamespace = new servicediscovery.PrivateDnsNamespace(this, 'CloudMapNamespace', {
      name: 'local',
      vpc: this.vpc,
      description: 'Private DNS namespace for internal service discovery',
    });

    // Service `wsg` under the `local` namespace — DNS A record, TTL 60s
    // Actual ECS task registration happens in Task 3.7
    this.wsgCloudMapService = this.cloudMapNamespace.createService('WsgService', {
      name: 'wsg',
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: Duration.seconds(60),
    });

    new cdk.CfnOutput(this, 'CloudMapNamespaceId', {
      value: this.cloudMapNamespace.namespaceId,
      description: 'Cloud Map private DNS namespace ID (local)',
      exportName: 'AnalyticsCloudMapNamespaceId',
    });

    // SSM SecureString references (Task 1.10)
    // These parameters must be created before `cdk deploy` by running:
    //   bash infrastructure/ssm/create-ssm-params.sh
    // Downstream constructs (Lambda, App Runner) call .grantRead(role)
    // and reference .parameterArn to inject the values at runtime.
    this.internalSecretParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'InternalSecretParam',
      { parameterName: '/analytics/INTERNAL_SECRET' },
    );

    this.mongoUrlParam = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'MongoUrlParam',
      { parameterName: '/analytics/MONGO_URL' },
    );

    // Security groups (Task 2.4)
    // lambdaSg: assigned to Lambda — allows outbound to WSG on port 8081
    // wsgSg:    assigned to WSG ECS task — allows inbound 8081 from Lambda only,
    //           inbound 8080 from ALB (ALB SG added in Task 3.5)
    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      securityGroupName: 'lambda-event-processor-sg',
      description: 'Security group for event-processor Lambda - outbound to WSG on 8081',
      allowAllOutbound: true, // Lambda needs outbound to DynamoDB, SSM, CloudWatch, WSG
    });

    this.wsgSg = new ec2.SecurityGroup(this, 'WsgSg', {
      vpc: this.vpc,
      securityGroupName: 'wsg-ecs-sg',
      description: 'Security group for WebSocket Gateway ECS task',
      allowAllOutbound: true,
    });

    // Allow Lambda → WSG on internal port 8081 (not exposed via ALB)
    this.wsgSg.addIngressRule(
      this.lambdaSg,
      ec2.Port.tcp(8081),
      'Allow Lambda event-processor to POST /internal/notify',
    );

    // IAM role: event-processor-role (Task 2.1)
    // Least-privilege permissions for Lambda to consume SQS, write to
    // DynamoDB tables, publish CloudWatch metrics, and write logs.
    this.eventProcessorRole = new iam.Role(this, 'EventProcessorRole', {
      roleName: 'event-processor-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Execution role for the event-processor Lambda function',
    });

    // SQS — consume messages from view-events queue
    this.eventProcessorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SqsConsume',
      actions: [
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'sqs:GetQueueAttributes',
        'sqs:ChangeMessageVisibility',
      ],
      resources: [this.viewEventsQueue.queueArn],
    }));

    // DynamoDB — write to all three analytics tables
    this.eventProcessorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDbWrite',
      actions: [
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:GetItem',
      ],
      resources: [
        this.movieStatsTable.tableArn,
        this.processedEventsTable.tableArn,
        this.recentActivityTable.tableArn,
      ],
    }));

    // CloudWatch — publish custom metrics
    this.eventProcessorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetrics',
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'], // PutMetricData does not support resource-level restrictions
    }));

    // CloudWatch Logs — write Lambda execution logs
    this.eventProcessorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchLogs',
      actions: ['logs:*'],
      resources: ['*'],
    }));

    // EC2 VPC — required for Lambda to attach to VPC (create/describe/delete ENIs)
    this.eventProcessorRole.addToPolicy(new iam.PolicyStatement({
      sid: 'Ec2Eni',
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    }));

    // SSM — read the INTERNAL_SECRET SecureString at runtime
    this.internalSecretParam.grantRead(this.eventProcessorRole);

    new cdk.CfnOutput(this, 'EventProcessorRoleArn', {
      value: this.eventProcessorRole.roleArn,
      description: 'IAM role ARN for event-processor Lambda',
      exportName: 'AnalyticsEventProcessorRoleArn',
    });

    // Lambda function: event-processor (Task 2.2)
    // Runtime: nodejs22.x, timeout 30s, memory 256MB, reserved concurrency 10
    // Placed in VPC private subnets so it can reach wsg.local via Cloud Map DNS
    // INTERNAL_SECRET_ARN is injected so the function fetches the value at runtime
    // via SSM GetParameter — avoids the secret appearing in CloudFormation plaintext
    this.eventProcessorFn = new lambda.Function(this, 'EventProcessorFn', {
      functionName: 'event-processor',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'src/handler.handler',
      code: lambda.Code.fromAsset('../event-processor', {
        exclude: ['node_modules', '*.test.js', 'coverage', '.env*'],
      }),
      role: this.eventProcessorRole,
      timeout: Duration.seconds(30),
      memorySize: 256,
      // reservedConcurrentExecutions: 10,
      // Cannot set reserved concurrency until account quota is increased above 10.
      // New accounts are capped at 10 total — AWS requires minimum 10 unreserved,
      // making it impossible to reserve any. Request increase to 100 at:
      // Service Quotas → Lambda → Concurrent executions → Request increase at account level
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.lambdaSg],
      environment: {
        DYNAMODB_TABLE_STATS:            this.movieStatsTable.tableName,
        DYNAMODB_TABLE_EVENTS:           this.processedEventsTable.tableName,
        DYNAMODB_TABLE_RECENT_ACTIVITY:  this.recentActivityTable.tableName,
        GATEWAY_INTERNAL_URL:            'http://wsg.local:8081',
        // Secret fetched at runtime via SSM GetParameter using this ARN
        INTERNAL_SECRET_ARN:             this.internalSecretParam.parameterArn,
        AWS_REGION_NAME:                 this.region,
        SQS_BATCH_SIZE:                  '10',
      },
    });

    new cdk.CfnOutput(this, 'EventProcessorFnArn', {
      value: this.eventProcessorFn.functionArn,
      description: 'ARN of the event-processor Lambda function',
      exportName: 'AnalyticsEventProcessorFnArn',
    });

    // SQS event source mapping: view-events → event-processor (Task 2.3)
    // batch size 10, ReportBatchItemFailures so only failed messages are retried
    this.eventProcessorFn.addEventSource(
      new lambdaEventSources.SqsEventSource(this.viewEventsQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    // Cognito User Pool (Task 5.1) — email sign-in, hosted UI
    // User accounts are created manually after deploy — never hardcoded in CDK
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'analytics-dashboard-users',
      selfSignUpEnabled: false,          // invite-only — team members added manually
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Hosted UI domain — prefix must be globally unique
    this.userPool.addDomain('UserPoolDomain', {
      cognitoDomain: {
        domainPrefix: `analytics-dashboard-${this.account}`,
      },
    });

    // App client (Task 5.2) — no client secret (SPA)
    // Callback URLs updated in Task 6 once CloudFront domain is known
    this.userPoolClient = this.userPool.addClient('DashboardClient', {
      userPoolClientName: 'dashboard-spa',
      generateSecret: false,             // SPA cannot keep a secret
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          'http://localhost:3000',        // local dev placeholder
          // CloudFront callback URL added in Task 6
        ],
        logoutUrls: ['http://localhost:3000'],
      },
    });

    // Outputs (Task 5.3)
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: 'AnalyticsUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito app client ID (dashboard SPA)',
      exportName: 'AnalyticsUserPoolClientId',
    });

    new cdk.CfnOutput(this, 'CognitoJwksUrl', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/jwks.json`,
      description: 'Cognito JWKS endpoint for JWT validation',
      exportName: 'AnalyticsCognitoJwksUrl',
    });

    new cdk.CfnOutput(this, 'CognitoHostedUiUrl', {
      value: `https://analytics-dashboard-${this.account}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito hosted UI base URL',
      exportName: 'AnalyticsCognitoHostedUiUrl',
    });
  }
}
