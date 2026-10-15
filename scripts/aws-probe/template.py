"""Generate a plain CloudFormation template; no SAM bootstrap or IAM creation."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def build():
    ref = lambda name: {"Ref": name}
    get = lambda name, attr: {"Fn::GetAtt": [name, attr]}
    sub = lambda text: {"Fn::Sub": text}
    resources = {}

    def add(name, kind, props, **extra):
        resources[name] = {"Type": "AWS::" + kind, "Properties": props, **extra}

    add("Table", "DynamoDB::Table", {"BillingMode": "PAY_PER_REQUEST", "AttributeDefinitions": [{"AttributeName": "pk", "AttributeType": "S"}], "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}]})
    add("Bucket", "S3::Bucket", {"VersioningConfiguration": {"Status": "Enabled"}, "PublicAccessBlockConfiguration": {"BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True}, "OwnershipControls": {"Rules": [{"ObjectOwnership": "BucketOwnerEnforced"}]}, "BucketEncryption": {"ServerSideEncryptionConfiguration": [{"ServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}})
    add("DeadLetterQueue", "SQS::Queue", {"MessageRetentionPeriod": 86400, "SqsManagedSseEnabled": True})
    add("Queue", "SQS::Queue", {"VisibilityTimeout": 90, "MessageRetentionPeriod": 86400, "SqsManagedSseEnabled": True, "RedrivePolicy": {"deadLetterTargetArn": get("DeadLetterQueue", "Arn"), "maxReceiveCount": 2}})
    add("LogGroup", "Logs::LogGroup", {"LogGroupName": sub("/aws/lambda/${AWS::StackName}"), "RetentionInDays": 1})
    add("Function", "Lambda::Function", {"FunctionName": ref("AWS::StackName"), "Runtime": "python3.13", "Handler": "index.handler", "Role": ref("LabRoleArn"), "Timeout": 15, "MemorySize": 128, "Code": {"ZipFile": (HERE / "worker.py").read_text()}, "Environment": {"Variables": {"TABLE": ref("Table"), "BUCKET": ref("Bucket"), "QUEUE": ref("Queue"), "REVISION": ref("Revision")}}}, DependsOn="LogGroup")
    add("QueueMapping", "Lambda::EventSourceMapping", {"FunctionName": ref("Function"), "EventSourceArn": get("Queue", "Arn"), "BatchSize": 1, "MaximumBatchingWindowInSeconds": 0, "Enabled": True, "ScalingConfig": {"MaximumConcurrency": 2}})
    add("UserPool", "Cognito::UserPool", {"AdminCreateUserConfig": {"AllowAdminCreateUserOnly": True}, "Policies": {"PasswordPolicy": {"MinimumLength": 16, "RequireLowercase": True, "RequireUppercase": True, "RequireNumbers": True, "RequireSymbols": True}}, "UserPoolTags": {"Purpose": "accord-feasibility-probe"}})
    add("UserPoolClient", "Cognito::UserPoolClient", {"UserPoolId": ref("UserPool"), "GenerateSecret": False, "ExplicitAuthFlows": ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], "PreventUserExistenceErrors": "ENABLED", "AccessTokenValidity": 5, "IdTokenValidity": 5, "RefreshTokenValidity": 1, "TokenValidityUnits": {"AccessToken": "minutes", "IdToken": "minutes", "RefreshToken": "days"}})
    add("Api", "ApiGatewayV2::Api", {"Name": ref("AWS::StackName"), "ProtocolType": "HTTP"})
    add("Authorizer", "ApiGatewayV2::Authorizer", {"ApiId": ref("Api"), "Name": "Cognito", "AuthorizerType": "JWT", "IdentitySource": ["$request.header.Authorization"], "JwtConfiguration": {"Audience": [ref("UserPoolClient")], "Issuer": sub("https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}")}})
    add("Integration", "ApiGatewayV2::Integration", {"ApiId": ref("Api"), "IntegrationType": "AWS_PROXY", "IntegrationUri": get("Function", "Arn"), "PayloadFormatVersion": "2.0", "TimeoutInMillis": 20000})
    for method in ["GET", "POST"]:
        add(method + "Route", "ApiGatewayV2::Route", {"ApiId": ref("Api"), "RouteKey": method + " /probe", "Target": sub("integrations/${Integration}"), "AuthorizationType": "JWT", "AuthorizerId": ref("Authorizer")})
    add("Stage", "ApiGatewayV2::Stage", {"ApiId": ref("Api"), "StageName": "$default", "AutoDeploy": True, "DefaultRouteSettings": {"ThrottlingBurstLimit": 2, "ThrottlingRateLimit": 1.0}})
    add("ApiPermission", "Lambda::Permission", {"FunctionName": ref("Function"), "Action": "lambda:InvokeFunction", "Principal": "apigateway.amazonaws.com", "SourceArn": sub("arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*/probe"), "SourceAccount": ref("AWS::AccountId")})
    outputs = {name: {"Value": ref(name)} for name in ["Table", "Bucket", "Queue", "DeadLetterQueue", "UserPool", "UserPoolClient", "Function", "LogGroup", "QueueMapping"]}
    outputs["Endpoint"] = {"Value": get("Api", "ApiEndpoint")}
    return {"AWSTemplateFormatVersion": "2010-09-09", "Description": "Disposable Accord synthetic feasibility probe. No Bedrock or IAM resources.", "Parameters": {"LabRoleArn": {"Type": "String", "AllowedPattern": r"arn:aws:iam::[0-9]{12}:role/LabRole"}, "Revision": {"Type": "String", "AllowedValues": ["1", "2"], "Default": "1"}}, "Resources": resources, "Outputs": outputs}


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
