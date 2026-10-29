#!/bin/sh
# Stand-in for a real email channel: it only says what it would send.
echo "would email: $PIPELINES_NOTIFY_NAME $PIPELINES_NOTIFY_STATUS" >&2
