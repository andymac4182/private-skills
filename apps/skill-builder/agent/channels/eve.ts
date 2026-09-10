import { createHash, timingSafeEqual } from "node:crypto";
import { eveChannel } from "eve/channels/eve";
import {
  extractBearerToken,
  type AuthFn,
  withAuthChallenges,
} from "eve/channels/auth";
import { builderEveToken } from "../lib/config.js";

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

const builderAuth: AuthFn<Request> = withAuthChallenges(
  (request) => {
    let expected: string;
    try {
      expected = builderEveToken();
    } catch {
      return null;
    }
    const supplied = extractBearerToken(request.headers.get("authorization"));
    if (!supplied || supplied.length > 512 || /\s/u.test(supplied) || !constantTimeEqual(expected, supplied)) return null;
    return {
      attributes: { service: "private-skills-skill-builder" },
      authenticator: "pskills-static-bearer",
      principalId: "private-skills-skill-builder-bff",
      principalType: "service",
    };
  },
  [{ scheme: "Bearer" }],
);

export default eveChannel({ auth: builderAuth });
