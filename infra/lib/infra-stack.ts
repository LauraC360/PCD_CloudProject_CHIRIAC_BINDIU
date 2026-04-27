import * as cdk from 'aws-cdk-lib/core';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as budgets from 'aws-cdk-lib/aws-budgets';
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
  // ECR repository for WebSocket Gateway image (Task 3.1)
  public readonly wsgRepository: ecr.Repository;
  // ECS Fargate cluster (Task 3.2)
  public readonly ecsCluster: ecs.Cluster;
  // IAM task role for WSG ECS task (Task 3.3)
  public readonly wsgTaskRole: iam.Role;
  // ECS Task Definition for WSG (Task 3.4)
  public readonly wsgTaskDefinition: ecs.FargateTaskDefinition;
  // ALB + security group for WSG (Task 3.5)
  public readonly wsgAlb: elbv2.ApplicationLoadBalancer;
  public readonly wsgAlbSg: ec2.SecurityGroup;
  // CloudFront distribution in front of ALB for wss:// support (Task 3.5)
  public readonly wsgCloudFront: cloudfront.Distribution;
  // ECS Fargate service (Task 3.6 + 3.7)
  public readonly wsgService: ecs.FargateService;
  // ECR repository for Service A image (Task 4.1)
  public readonly serviceARepository: ecr.Repository;
  // IAM instance role for App Runner (Task 4.2)
  public readonly serviceAInstanceRole: iam.Role;
  // App Runner service for Service A (Task 4.3)
  public readonly serviceAAppRunner: apprunner.CfnService;
  // S3 bucket for frontend static assets (Task 6.1)
  public readonly frontendBucket: s3.Bucket;
  // CloudFront distribution for frontend + WebSocket proxy (Task 6.2)
  public readonly frontendCloudFront: cloudfront.Distribution;

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

    // VPC Endpoints — allow Lambda in private isolated subnets to reach AWS services
    // without internet access (no NAT gateway). Gateway endpoints are free.
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Interface endpoint for SSM (Lambda reads INTERNAL_SECRET_ARN at cold start)
    this.vpc.addInterfaceEndpoint('SsmEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      privateDnsEnabled: true,
    });

    // Interface endpoint for CloudWatch Logs (Lambda writes logs)
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
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
        // node_modules is included — handler.js requires @aws-sdk/* packages
        // which are not available in the Lambda runtime layer for nodejs22.x
        exclude: ['src/__tests__', 'coverage', '.env*', 'deploy.sh', '*.md'],
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

    // -------------------------------------------------------------------------
    // Task 3.1 — ECR repository for WebSocket Gateway
    // -------------------------------------------------------------------------
    this.wsgRepository = new ecr.Repository(this, 'WsgRepository', {
      repositoryName: 'websocket-gateway',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'WsgEcrRepositoryUri', {
      value: this.wsgRepository.repositoryUri,
      description: 'ECR repository URI for websocket-gateway image',
      exportName: 'AnalyticsWsgEcrRepositoryUri',
    });

    // -------------------------------------------------------------------------
    // Task 3.2 — ECS Fargate cluster
    // -------------------------------------------------------------------------
    this.ecsCluster = new ecs.Cluster(this, 'AnalyticsCluster', {
      clusterName: 'analytics-cluster',
      vpc: this.vpc,
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.ecsCluster.clusterName,
      description: 'ECS Fargate cluster name',
      exportName: 'AnalyticsEcsClusterName',
    });

    // -------------------------------------------------------------------------
    // Task 3.3 — IAM task role ecs-wsg-task-role
    // -------------------------------------------------------------------------
    this.wsgTaskRole = new iam.Role(this, 'WsgTaskRole', {
      roleName: 'ecs-wsg-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Task role for WebSocket Gateway ECS task',
    });

    this.wsgTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'DynamoDbRead',
      actions: ['dynamodb:Query', 'dynamodb:GetItem'],
      resources: [
        this.movieStatsTable.tableArn,
        `${this.movieStatsTable.tableArn}/index/*`,
        this.recentActivityTable.tableArn,
      ],
    }));

    this.wsgTaskRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetrics',
      actions: ['cloudwatch:PutMetricData', 'cloudwatch:GetMetricData'],
      resources: ['*'],
    }));

    this.internalSecretParam.grantRead(this.wsgTaskRole);

    new cdk.CfnOutput(this, 'WsgTaskRoleArn', {
      value: this.wsgTaskRole.roleArn,
      description: 'IAM task role ARN for WSG ECS task',
      exportName: 'AnalyticsWsgTaskRoleArn',
    });

    // -------------------------------------------------------------------------
    // Task 3.4 — ECS Task Definition
    // -------------------------------------------------------------------------
    // Execution role: pulls image from ECR and writes CloudWatch Logs
    const wsgExecutionRole = new iam.Role(this, 'WsgExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    this.wsgTaskDefinition = new ecs.FargateTaskDefinition(this, 'WsgTaskDef', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: this.wsgTaskRole,
      executionRole: wsgExecutionRole,
    });

    this.wsgTaskDefinition.addContainer('WsgContainer', {
      image: ecs.ContainerImage.fromEcrRepository(this.wsgRepository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'wsg' }),
      environment: {
        DYNAMODB_TABLE_STATS:           this.movieStatsTable.tableName,
        DYNAMODB_TABLE_RECENT_ACTIVITY: this.recentActivityTable.tableName,
        AWS_REGION:                     this.region,
        PORT:                           '8080',
        INTERNAL_PORT:                  '8081',
        COGNITO_JWKS_URL:               `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/jwks.json`,
        // INTERNAL_SECRET is fetched at runtime via SSM GetParameter using this ARN
        INTERNAL_SECRET_ARN:            this.internalSecretParam.parameterArn,
        CLOUDWATCH_POLL_INTERVAL_MS:    '5000',
      },
      portMappings: [
        { containerPort: 8080, protocol: ecs.Protocol.TCP },
        { containerPort: 8081, protocol: ecs.Protocol.TCP },
      ],
    });

    // -------------------------------------------------------------------------
    // Task 3.5 — ALB (HTTP, internal) + CloudFront (HTTPS/WSS, public)
    // ACM requires a custom domain. Instead, CloudFront provides a free
    // *.cloudfront.net HTTPS domain — browsers can connect via wss:// with
    // no domain purchase needed. CloudFront → ALB on port 80 internally.
    // -------------------------------------------------------------------------
    this.wsgAlbSg = new ec2.SecurityGroup(this, 'WsgAlbSg', {
      vpc: this.vpc,
      securityGroupName: 'wsg-alb-sg',
      description: 'Security group for WSG Application Load Balancer',
      allowAllOutbound: true,
    });
    // ALB only needs to accept traffic from CloudFront managed prefix list
    // (and optionally all IPv4 for direct health checks during development)
    this.wsgAlbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP from CloudFront and health checks');

    // Allow ALB → ECS task on port 8080
    this.wsgSg.addIngressRule(this.wsgAlbSg, ec2.Port.tcp(8080), 'Allow ALB to reach WSG on port 8080');

    this.wsgAlb = new elbv2.ApplicationLoadBalancer(this, 'WsgAlb', {
      loadBalancerName: 'wsg-alb',
      vpc: this.vpc,
      internetFacing: true,
      securityGroup: this.wsgAlbSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    new cdk.CfnOutput(this, 'WsgAlbDnsName', {
      value: this.wsgAlb.loadBalancerDnsName,
      description: 'ALB DNS name (internal — use CloudFront domain for public access)',
      exportName: 'AnalyticsWsgAlbDnsName',
    });

    // CloudFront distribution — public HTTPS/WSS endpoint
    // Origin: ALB over HTTP (TLS terminated at CloudFront edge)
    // WebSocket support: enabled by forwarding all headers and disabling caching
    const albOrigin = new origins.HttpOrigin(this.wsgAlb.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });

    this.wsgCloudFront = new cloudfront.Distribution(this, 'WsgCloudFront', {
      comment: 'WebSocket Gateway — public wss:// endpoint',
      defaultBehavior: {
        origin: albOrigin,
        // Disable caching — WebSocket and health check responses must not be cached
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Forward all headers so the WebSocket upgrade handshake passes through
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });

    new cdk.CfnOutput(this, 'WsgCloudFrontDomain', {
      value: this.wsgCloudFront.distributionDomainName,
      description: 'CloudFront domain for WebSocket Gateway — use wss://<domain>/ws in frontend',
      exportName: 'AnalyticsWsgCloudFrontDomain',
    });

    // -------------------------------------------------------------------------
    // Task 3.6 + 3.7 — ECS Fargate service with Cloud Map registration
    // -------------------------------------------------------------------------
    this.wsgService = new ecs.FargateService(this, 'WsgService', {
      cluster: this.ecsCluster,
      taskDefinition: this.wsgTaskDefinition,
      desiredCount: 1,
      securityGroups: [this.wsgSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      assignPublicIp: true, // needed in public subnet without NAT gateway
      healthCheckGracePeriod: Duration.seconds(180), // give the container 3 min to start before ALB health checks count
      minHealthyPercent: 0, // allow 0 healthy tasks during deployment (single-task service)
      maxHealthyPercent: 200,
    });

    // Task 3.7 — register ECS service with the pre-created Cloud Map service
    // so Lambda can resolve wsg.local:8081 via DNS
    this.wsgService.associateCloudMapService({
      service: this.wsgCloudMapService,
    });

    // ALB target group → ECS service on port 8080
    const wsgTargetGroup = new elbv2.ApplicationTargetGroup(this, 'WsgTargetGroup', {
      vpc: this.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(180),
        timeout: Duration.seconds(60),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // WebSocket connections need a longer deregistration delay
      deregistrationDelay: Duration.seconds(30),
    });

    // Attach ECS service to target group
    this.wsgService.attachToApplicationTargetGroup(wsgTargetGroup);

    // ALB listener on port 80
    this.wsgAlb.addListener('WsgHttpListener', {
      port: 80,
      defaultTargetGroups: [wsgTargetGroup],
    });

    // -------------------------------------------------------------------------
    // Task 4.1 — ECR repository for Service A
    // -------------------------------------------------------------------------
    this.serviceARepository = new ecr.Repository(this, 'ServiceARepository', {
      repositoryName: 'service-a',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'ServiceAEcrRepositoryUri', {
      value: this.serviceARepository.repositoryUri,
      description: 'ECR repository URI for service-a image',
      exportName: 'AnalyticsServiceAEcrRepositoryUri',
    });

    // -------------------------------------------------------------------------
    // Task 4.2 — IAM instance role for App Runner (Service A)
    // App Runner instance role: grants the running container permission to
    // publish to SQS and emit CloudWatch metrics.
    // -------------------------------------------------------------------------
    this.serviceAInstanceRole = new iam.Role(this, 'ServiceAInstanceRole', {
      roleName: 'apprunner-service-a-instance-role',
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
      description: 'Instance role for Service A App Runner - SQS publish + CloudWatch metrics',
    });

    this.serviceAInstanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'SqsPublish',
      actions: ['sqs:SendMessage'],
      resources: [this.viewEventsQueue.queueArn],
    }));

    this.serviceAInstanceRole.addToPolicy(new iam.PolicyStatement({
      sid: 'CloudWatchMetrics',
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));

    // SSM — read MONGO_URL at runtime
    this.mongoUrlParam.grantRead(this.serviceAInstanceRole);

    new cdk.CfnOutput(this, 'ServiceAInstanceRoleArn', {
      value: this.serviceAInstanceRole.roleArn,
      description: 'IAM instance role ARN for Service A App Runner',
      exportName: 'AnalyticsServiceAInstanceRoleArn',
    });

    // -------------------------------------------------------------------------
    // Task 4.3 — App Runner service for Service A
    // Uses CfnService (L1) because the L2 construct does not yet support
    // all App Runner features (auto-scaling configuration, instance role).
    // Image: pulled from ECR serviceARepository on every deploy.
    // Env vars: SQS_QUEUE_URL, AWS_REGION, MONGO_URL (from SSM at runtime via
    // instance role), MONGO_DB_NAME, COGNITO_JWKS_URL, APP_PORT=3000.
    // -------------------------------------------------------------------------

    // Access role: allows App Runner to pull images from ECR
    const serviceAAccessRole = new iam.Role(this, 'ServiceAAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSAppRunnerServicePolicyForECRAccess'),
      ],
    });

    this.serviceAAppRunner = new apprunner.CfnService(this, 'ServiceAAppRunner', {
      serviceName: 'service-a',
      sourceConfiguration: {
        authenticationConfiguration: {
          accessRoleArn: serviceAAccessRole.roleArn,
        },
        autoDeploymentsEnabled: false, // manual deploys - push image then trigger update
        imageRepository: {
          imageIdentifier: `${this.serviceARepository.repositoryUri}:latest`,
          imageRepositoryType: 'ECR',
          imageConfiguration: {
            port: '3000',
            runtimeEnvironmentVariables: [
              { name: 'NODE_ENV',          value: 'production' },
              { name: 'APP_PORT',          value: '3000' },
              { name: 'AWS_REGION',        value: this.region },
              { name: 'SQS_QUEUE_URL',     value: this.viewEventsQueue.queueUrl },
              { name: 'MONGO_DB_NAME',     value: 'sample_mflix' },
              { name: 'COGNITO_JWKS_URL',  value: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/jwks.json` },
              { name: 'MONGO_URL',         value: 'mongodb+srv://pcd-user:BFm76EVoiWWfmtG7@pcd-cluster.sveuic.mongodb.net/sample_mflix?appName=pcd-cluster' },
            ],
          },
        },
      },
      instanceConfiguration: {
        instanceRoleArn: this.serviceAInstanceRole.roleArn,
        cpu: '0.25 vCPU',
        memory: '0.5 GB',
      },
      autoScalingConfigurationArn: undefined, // uses App Runner default (min 1, max 10)
    });

    new cdk.CfnOutput(this, 'ServiceAAppRunnerUrl', {
      value: `https://${this.serviceAAppRunner.attrServiceUrl}`,
      description: 'App Runner service URL for Service A',
      exportName: 'AnalyticsServiceAAppRunnerUrl',
    });

    // -------------------------------------------------------------------------
    // Task 6.1 — S3 bucket for frontend static assets
    // Block all public access; only CloudFront OAC can read objects.
    // -------------------------------------------------------------------------
    this.frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true, // empties bucket on cdk destroy
      versioned: false,
    });

    // -------------------------------------------------------------------------
    // Task 6.2 + 6.3 — CloudFront distribution with two origins:
    //   Origin 1 (default /*): S3 bucket via OAC — serves frontend files
    //   Origin 2 (/ws path): ALB HTTP origin — proxies WebSocket connections
    // -------------------------------------------------------------------------

    // OAC for S3 origin (replaces legacy OAI)
    const oac = new cloudfront.S3OriginAccessControl(this, 'FrontendOac', {
      description: 'OAC for frontend S3 bucket',
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(
      this.frontendBucket,
      { originAccessControl: oac },
    );

    // ALB origin for WebSocket proxying (same ALB as WSG)
    const wsgAlbOrigin = new origins.HttpOrigin(this.wsgAlb.loadBalancerDnsName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });

    this.frontendCloudFront = new cloudfront.Distribution(this, 'FrontendCloudFront', {
      comment: 'Frontend dashboard + WebSocket Gateway proxy',
      defaultRootObject: 'index.html',
      defaultBehavior: {
        // Default: serve frontend files from S3
        origin: s3Origin,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      },
      additionalBehaviors: {
        // /ws path: proxy to ALB for WebSocket connections
        '/ws': {
          origin: wsgAlbOrigin,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
        // /health: proxy to ALB for health checks
        '/health': {
          origin: wsgAlbOrigin,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
    });

    new cdk.CfnOutput(this, 'FrontendCloudFrontDomain', {
      value: this.frontendCloudFront.distributionDomainName,
      description: 'CloudFront domain for frontend dashboard — use https://<domain>/ to open dashboard, wss://<domain>/ws for WebSocket',
      exportName: 'AnalyticsFrontendCloudFrontDomain',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: this.frontendBucket.bucketName,
      description: 'S3 bucket name for frontend static assets',
      exportName: 'AnalyticsFrontendBucketName',
    });

    // -------------------------------------------------------------------------
    // Task 7.1 — AWS Budget alert: email when monthly spend exceeds $10
    // -------------------------------------------------------------------------
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'analytics-dashboard-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: 10,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 80, // alert at 80% of $10 = $8
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: 'ana.bindiu33@gmail.com', // placeholder — update with real email after deploy
            },
          ],
        },
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: 100,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: [
            {
              subscriptionType: 'EMAIL',
              address: 'ana.bindiu33@gmail.com', // placeholder — update with real email after deploy
            },
          ],
        },
      ],
    });
  }
}
