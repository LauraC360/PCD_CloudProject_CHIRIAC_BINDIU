#!/bin/bash
JWT=$(aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --auth-parameters USERNAME=test@test.com,PASSWORD='Test1234!Perm' --client-id 4t06qivno4u8b5nqq4qqs6usr5 --profile pers --region us-east-1 --query "AuthenticationResult.IdToken" --output text 2>&1)
BASE="https://vvsusbtfkg.us-east-1.awsapprunner.com/api/v1/movies"

IDS=(
  "573a13d3f29313caabd9473c"
  "573a13b3f29313caabd3c7ac"
  "573a13cff29313caabd88f5b"
  "573a1393f29313caabcddbed"
  "573a13b8f29313caabd4d540"
  "573a13d3f29313caabd967ef"
  "573a13d6f29313caabd9e2d7"
  "573a13dcf29313caabdb2dec"
  "573a13d9f29313caabdaa62d"
  "573a13d7f29313caabda5079"
  "573a13cef29313caabd86ddc"
  "573a139cf29313caabcf560f"
  "573a13a0f29313caabcfac7c"
  "573a13a3f29313caabcff87e"
  "573a13a4f29313caabcff87e"
)

for i in "${!IDS[@]}"; do
  ID="${IDS[$i]}"
  TS=$(date +%s)000
  TITLE=$(curl -s -H "Authorization: Bearer $JWT" -H "X-Requested-At: $TS" "$BASE/$ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('title','?'))" 2>/dev/null)
  echo "GET $((i+1))/15: $TITLE"
  sleep 1
done
