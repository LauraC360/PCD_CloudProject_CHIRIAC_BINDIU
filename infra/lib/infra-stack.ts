import * as cdk from 'aws-cdk-lib/core';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
  }
}
