import { createHash, timingSafeEqual } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import {
  extractBearerToken,
  type AuthFn,
  withAuthChallenges,
} from "eve/channels/auth";

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

const reviewerAuth: AuthFn<Request> = withAuthChallenges(
  (request) => {
    const expected = process.env.PSKILLS_EVE_API_TOKEN?.trim();
    const supplied = extractBearerToken(request.headers.get("authorization"));
    if (!expected || expected.length > 512 || /\s/u.test(expected) || !supplied || supplied.length > 512 || !constantTimeEqual(expected, supplied)) return null;
    return {
      attributes: { service: "private-skills-reviewer" },
      authenticator: "pskills-static-bearer",
      principalId: "private-skills-reviewer-client",
      principalType: "service",
    };
  },
  [{ scheme: "Bearer" }],
);

export default eveChannel({ auth: reviewerAuth });
