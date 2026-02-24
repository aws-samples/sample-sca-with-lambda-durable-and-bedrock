#!/bin/bash
# Ingest sample transcription segments into the SCA Kinesis Data Stream
# Usage: ./scripts/ingest-transcriptions.sh [contact-id]
#
# The stream name is retrieved dynamically from the ScaBackendStack CloudFormation outputs.
# A contact ID can be provided as an argument, otherwise a random one is generated.

set -euo pipefail

# Retrieve stream name from CDK stack output
STREAM_NAME=$(aws cloudformation describe-stacks \
  --stack-name ScaBackendStack \
  --query "Stacks[0].Outputs[?OutputKey=='TranscriptionStreamName'].OutputValue" \
  --output text 2>/dev/null)

if [ -z "$STREAM_NAME" ] || [ "$STREAM_NAME" = "None" ]; then
  echo "Error: Could not retrieve Kinesis stream name from ScaBackendStack."
  echo "Make sure the stack is deployed: cdk deploy ScaBackendStack"
  exit 1
fi

echo "Using Kinesis stream: $STREAM_NAME"

# Generate or use provided contact ID
CONTACT_ID="${1:-contact-$(date +%s)-$(( RANDOM % 1000 ))}"
BASE_EPOCH=$(date +%s)

echo "Contact ID: $CONTACT_ID"
echo ""

# Create a temp file for payloads (avoids shell quoting issues with AWS CLI v1)
TMPFILE=$(mktemp)
trap "rm -f $TMPFILE" EXIT

# Helper: generate an ISO timestamp offset by N seconds from the base time
offset_ts() {
  local offset_secs=$1
  date -u -d "@$(( BASE_EPOCH + offset_secs ))" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null \
    || date -u -r $(( BASE_EPOCH + offset_secs )) +"%Y-%m-%dT%H:%M:%S.000Z"
}

# Helper function to send a JSON payload to Kinesis via temp file
send_segment() {
  local description="$1"
  local payload="$2"

  echo -n "$payload" > "$TMPFILE"
  aws kinesis put-record \
    --stream-name "$STREAM_NAME" \
    --partition-key "$CONTACT_ID" \
    --data "fileb://$TMPFILE" \
    --output text --query 'SequenceNumber' > /dev/null

  echo "  Sent: $description"
}

echo "Sending transcription segments..."

TS1=$(offset_ts 0)
TS2=$(offset_ts 9)
TS3=$(offset_ts 16)
TS4=$(offset_ts 23)
TS5=$(offset_ts 34)
TS6=$(offset_ts 40)

# --- Segment 1: Customer greeting ---
send_segment "Segment 1 - Customer greeting" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "CUSTOMER",
        "Content": "Hi, I am calling because I have a question about my recent order. It was supposed to arrive yesterday but I have not received it yet.",
        "BeginOffsetMillis": 0,
        "EndOffsetMillis": 8500,
        "Id": "segment-001",
        "Time": {"AbsoluteTime": "'"$TS1"'"},
        "Sentiment": "NEGATIVE"
      }
    }
  ]
}'

sleep 1

# --- Segment 2: Agent response ---
send_segment "Segment 2 - Agent response" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "AGENT",
        "Content": "I am sorry to hear that. Let me look into your order right away. Could you please provide me with your order number?",
        "BeginOffsetMillis": 9000,
        "EndOffsetMillis": 15000,
        "Id": "segment-002",
        "Time": {"AbsoluteTime": "'"$TS2"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 3: Customer provides details ---
send_segment "Segment 3 - Customer provides details" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "CUSTOMER",
        "Content": "Sure, the order number is A B C 1 2 3 4 5. I placed it last week and selected express shipping.",
        "BeginOffsetMillis": 15500,
        "EndOffsetMillis": 22000,
        "Id": "segment-003",
        "Time": {"AbsoluteTime": "'"$TS3"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 4: Agent investigates ---
send_segment "Segment 4 - Agent investigates" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "AGENT",
        "Content": "I found your order. It looks like there was a delay at the distribution center due to weather conditions. The package is now in transit and should arrive by tomorrow.",
        "BeginOffsetMillis": 23000,
        "EndOffsetMillis": 33000,
        "Id": "segment-004",
        "Time": {"AbsoluteTime": "'"$TS4"'"},
        "Sentiment": "NEUTRAL"
      }
    }
  ]
}'

sleep 1

# --- Segment 5: Customer follow-up ---
send_segment "Segment 5 - Customer follow-up" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "CUSTOMER",
        "Content": "That is great to know, thank you for checking. Will I receive a tracking update when it is out for delivery?",
        "BeginOffsetMillis": 33500,
        "EndOffsetMillis": 39000,
        "Id": "segment-005",
        "Time": {"AbsoluteTime": "'"$TS5"'"},
        "Sentiment": "POSITIVE"
      }
    }
  ]
}'

sleep 1

# --- Segment 6: Agent closing ---
send_segment "Segment 6 - Agent closing" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "SEGMENTS",
  "Segments": [
    {
      "Transcript": {
        "ParticipantRole": "AGENT",
        "Content": "Absolutely, you will get an email and a text notification once it is out for delivery. Is there anything else I can help you with today?",
        "BeginOffsetMillis": 39500,
        "EndOffsetMillis": 47000,
        "Id": "segment-006",
        "Time": {"AbsoluteTime": "'"$TS6"'"},
        "Sentiment": "POSITIVE"
      }
    }
  ]
}'

sleep 1

# --- COMPLETED event ---
send_segment "COMPLETED event" '{
  "Version": "1.0.0",
  "Channel": "VOICE",
  "ContactId": "'"$CONTACT_ID"'",
  "LanguageCode": "en-US",
  "EventType": "COMPLETED"
}'

echo ""
echo "Done! Sent 6 transcription segments + COMPLETED event for contact: $CONTACT_ID"
echo "Check the TranscriptionProcessor Lambda logs for processing results."
