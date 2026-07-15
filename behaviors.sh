#!/usr/bin/env bash
# Completeness oracle for the flue fork.
#
# For each behavior the runner patches carry, assert its observable surface is
# present in the fork's BUILT dist. This is what "the fork carries what the
# patch carried" actually means — line-count diffs are noise, because
# re-derived source legitimately differs from a hand-edited bundle (doc
# comments survive into dist; TS narrowing changes codegen).
set -euo pipefail

S=$(cd -- "$(dirname -- "$0")" && pwd)
cd "$S"
pnpm turbo build \
	--filter=@argonavis-labs/flue-runtime \
	--filter=@argonavis-labs/flue-sdk \
	--filter=@argonavis-labs/flue-react \
	--filter=@argonavis-labs/flue-cli

D="$S/packages"
have() {
	if grep -rqs -- "$2" "$D/$1"/dist; then
		echo "  OK   $3"
	else
		echo "  MISS $3"
		MISSING=$((MISSING + 1))
	fi
}
MISSING=0

echo "── behaviors carried by the fork ──────────────────────────────"
have cli  'flue-cloudflare-deployment.v1.json' '01 cloudflare deployment manifest          (session foundation)'
have runtime 'submissionId: options.submissionId ?? crypto.randomUUID()' \
                                               '02a client-supplied submissionId           (session foundation)'
have sdk  'options.submissionId ? { submissionId' '02b submissionId on prompt/send body      (session foundation)'
have runtime 'toolCallId'                      '02c toolCallId in custom-tool context      (session foundation)'
have runtime 'declare function createTools' '03  createTools() re-export               (browser-tools-inline)'
have runtime 'appendAgentConversationSignal'   '04a appendAgentConversationSignal          (blocking cards)'
have sdk  "origin?: 'signal'"                  '04b metadata.origin=signal on SDK message  (blocking cards)'
have runtime 'promptFrame'                     '05  promptFrame: none                      (b556ec3a)'
have runtime 'FLUE_AGENT_SUBMISSION_WAKE_MAX_SECONDS' \
                                               '07  recovery wake alarm backoff            (RUN-4825)'
have runtime 'provider finish_reason' '08  bare finish_reason:error is retryable  (RUN-4838)'
have runtime 'no_progress_streak'              '09  progress-based attempt accounting      (RUN-4859)'
have runtime 'reduceConversationRecordsInPlace' '10  per-batch clone elision                (RUN-4852)'
have runtime 'clearReducedStateCache'          '11  prefix-read state cache + projectRead   (RUN-4964)'
have react 'settlements: FlueConversationSettlement' '12  settlements on AgentSnapshot           (RUN-4670)'
echo "───────────────────────────────────────────────────────────────"
echo "  (RUN-4853 durable checkpoints intentionally NOT carried — PR #638 removes it)"
echo
echo "  MISSING: $MISSING"
test "$MISSING" -eq 0
