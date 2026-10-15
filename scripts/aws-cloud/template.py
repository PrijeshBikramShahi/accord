"""Plain CloudFormation for the first Accord cloud slice; existing LabRole only."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def build():
    ref = lambda name: {"Ref": name}
    get = lambda name, attr: {"Fn::GetAtt": [name, attr]}
    sub = lambda text: {"Fn::Sub": text}
    source = HERE / "handler.py"
    if not source.exists():
        source = HERE.parent.parent / "apps/cloud-api/handler.py"
    resources = {}

    def add(name, kind, props, **extra):
        resources[name] = {"Type": "AWS::" + kind, "Properties": props, **extra}

    issuer = sub("https://cognito-idp.${AWS::Region}.amazonaws.com/${UserPool}")
    add("Table", "DynamoDB::Table", {"BillingMode": "PAY_PER_REQUEST", "AttributeDefinitions": [{"AttributeName": key, "AttributeType": "S"} for key in ("pk", "sk")], "KeySchema": [{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}], "SSESpecification": {"SSEEnabled": True}})
    add("UserPool", "Cognito::UserPool", {"AdminCreateUserConfig": {"AllowAdminCreateUserOnly": True}, "UsernameConfiguration": {"CaseSensitive": False}, "Policies": {"PasswordPolicy": {"MinimumLength": 16, "RequireLowercase": True, "RequireUppercase": True, "RequireNumbers": True, "RequireSymbols": True}}, "UserPoolTags": {"Purpose": "accord-cloud-foundation"}})
    add("UserPoolClient", "Cognito::UserPoolClient", {"UserPoolId": ref("UserPool"), "GenerateSecret": False, "ExplicitAuthFlows": ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"], "PreventUserExistenceErrors": "ENABLED", "AllowedOAuthFlowsUserPoolClient": True, "AllowedOAuthFlows": ["code"], "AllowedOAuthScopes": ["openid", "email", "profile"], "SupportedIdentityProviders": ["COGNITO"], "CallbackURLs": ["http://localhost:5174/callback"], "LogoutURLs": ["http://localhost:5174/"], "AccessTokenValidity": 15, "IdTokenValidity": 15, "RefreshTokenValidity": 1, "TokenValidityUnits": {"AccessToken": "minutes", "IdToken": "minutes", "RefreshToken": "days"}, "EnableTokenRevocation": True})
    add("UserPoolDomain", "Cognito::UserPoolDomain", {"UserPoolId": ref("UserPool"), "Domain": ref("AWS::StackName"), "ManagedLoginVersion": 1})
    add("LogGroup", "Logs::LogGroup", {"LogGroupName": sub("/aws/lambda/${AWS::StackName}"), "RetentionInDays": 7})
    add("Function", "Lambda::Function", {"FunctionName": ref("AWS::StackName"), "Runtime": "python3.13", "Handler": "index.handler", "Role": ref("LabRoleArn"), "Timeout": 20, "MemorySize": 128, "Code": {"ZipFile": source.read_text()}, "Environment": {"Variables": {"TABLE": ref("Table"), "CLIENT_ID": ref("UserPoolClient"), "ISSUER": issuer, "WEB_ORIGIN": "http://localhost:5174"}}}, DependsOn="LogGroup")
    add("Api", "ApiGatewayV2::Api", {"Name": ref("AWS::StackName"), "ProtocolType": "HTTP", "CorsConfiguration": {"AllowOrigins": ["http://localhost:5174"], "AllowMethods": ["GET", "POST", "OPTIONS"], "AllowHeaders": ["authorization", "content-type", "idempotency-key"], "MaxAge": 300}})
    add("Authorizer", "ApiGatewayV2::Authorizer", {"ApiId": ref("Api"), "Name": "CognitoAccessToken", "AuthorizerType": "JWT", "IdentitySource": ["$request.header.Authorization"], "JwtConfiguration": {"Audience": [ref("UserPoolClient")], "Issuer": issuer}})
    add("Integration", "ApiGatewayV2::Integration", {"ApiId": ref("Api"), "IntegrationType": "AWS_PROXY", "IntegrationUri": get("Function", "Arn"), "PayloadFormatVersion": "2.0", "TimeoutInMillis": 25000})
    for name, route in {"Me": "GET /api/auth/me", "Clients": "GET /api/clients", "Projects": "GET /api/projects", "Project": "GET /api/projects/{id}", "CreateProject": "POST /api/projects", "Brief": "GET /api/projects/{id}/briefs", "BriefHistory": "GET /api/projects/{id}/briefs/history", "SaveBrief": "POST /api/projects/{id}/briefs", "SubmitBrief": "POST /api/projects/{id}/briefs/submit", "DecideBrief": "POST /api/projects/{id}/briefs/decide"}.items():
        add(name + "Route", "ApiGatewayV2::Route", {"ApiId": ref("Api"), "RouteKey": route, "Target": sub("integrations/${Integration}"), "AuthorizationType": "JWT", "AuthorizerId": ref("Authorizer"), "AuthorizationScopes": ["openid"]})
    add("Stage", "ApiGatewayV2::Stage", {"ApiId": ref("Api"), "StageName": "$default", "AutoDeploy": True, "DefaultRouteSettings": {"ThrottlingBurstLimit": 5, "ThrottlingRateLimit": 2.0}})
    add("ApiPermission", "Lambda::Permission", {"FunctionName": ref("Function"), "Action": "lambda:InvokeFunction", "Principal": "apigateway.amazonaws.com", "SourceArn": sub("arn:${AWS::Partition}:execute-api:${AWS::Region}:${AWS::AccountId}:${Api}/*/*/api/*"), "SourceAccount": ref("AWS::AccountId")})
    outputs = {name: {"Value": ref(name)} for name in ["Table", "UserPool", "UserPoolClient", "LogGroup"]}
    outputs.update({"Endpoint": {"Value": get("Api", "ApiEndpoint")}, "Issuer": {"Value": issuer}, "LoginDomain": {"Value": sub("https://${UserPoolDomain}.auth.${AWS::Region}.amazoncognito.com")}})
    return {"AWSTemplateFormatVersion": "2010-09-09", "Description": "Accord cloud foundation: Cognito browser login, private projects and versioned brief approvals. Synthetic data only.", "Parameters": {"LabRoleArn": {"Type": "String", "AllowedPattern": r"arn:aws:iam::[0-9]{12}:role/LabRole"}}, "Resources": resources, "Outputs": outputs}


if __name__ == "__main__":
    print(json.dumps(build(), indent=2))
