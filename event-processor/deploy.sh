#!/usr/bin/env bash
# Packages and deploys the event-processor Lambda to AWS.
# Run from the event-processor/ directory.
set -euo pipefail

FUNCTION_NAME="event-processor"
ZIP_FILE="function.zip"

echo "Installing production dependencies..."
npm ci --omit=dev

echo "Creating deployment package..."
zip -r "$ZIP_FILE" src/ node_modules/ package.json

echo "Uploading to Lambda..."
aws lambda update-function-code \
  --function-name "$FUNCTION_NAME" \
  --zip-file "fileb://$ZIP_FILE" \
  --profile pers \
  --region us-east-1

echo "Cleaning up..."
rm -f "$ZIP_FILE"

echo "Deploy complete."
