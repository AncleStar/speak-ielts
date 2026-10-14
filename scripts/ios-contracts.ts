/** Proposed contract only. No production mobile endpoint is enabled by this module. */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string" };
const id = { type: "string", minLength: 1, maxLength: 100 };
const errorResponses = Object.fromEntries([400, 401, 403, 404, 409, 413, 429, 500, 502, 503].map(status => [String(status), { description: "Safe API error; processing/charging state is not inferred from a network failure", content: { "application/json": { schema: ref("Error") } } }]));

function operation(name: string, source: string, schema?: string, output = "Object", publicEndpoint = false) {
  const headers: Record<string, { schema: { type: string }; description: string }> = { "X-Server-Time": { schema: { type: "integer" }, description: "Server wall time in milliseconds" } };
  return {
    operationId: name,
    "x-implementation-status": "proposal",
    "x-existing-source": source,
    description: "Not implemented in production. Native authentication and service-layer integration require separate validation.",
    security: publicEndpoint ? [] : [{ NativeSessionProposal: [] }],
    ...(schema ? { requestBody: { required: true, content: { "application/json": { schema: ref(schema) } } } } : {}),
    responses: { "200": { description: "Proposed success DTO", headers, content: { "application/json": { schema: ref(output) } } }, ...errorResponses },
  };
}
const pathId = [{ name: "id", in: "path", required: true, schema: id }];
const searchPage = [
  { name: "q", in: "query", schema: { ...string, maxLength: 100 } },
  { name: "offset", in: "query", schema: { type: "integer", minimum: 0, maximum: 100000, default: 0 } },
];
const monthQuery = [{ name: "month", in: "query", schema: { ...string, pattern: "^20[0-9]{2}-(0[1-9]|1[0-2])$" } }];
const signIn = operation("mobileSignIn", "lib/auth.ts", "SignIn", "SignInResult", true);
signIn.responses["200"].headers["set-auth-token"] = { schema: { type: "string" }, description: "Sensitive signed opaque credential. The native adapter must capture it into secure storage and redact it from diagnostics." };
const createSession = operation("mobileCreateSession", "app/api/sessions/route.ts", "CreateSession");
export const mobileOpenApi = {
  openapi: "3.1.0",
  info: { title: "SPEAK proposed iOS API", version: "0.1.0-proposal", description: "Design contract. No /api/mobile/v1 endpoint is implemented or exposed by this preparation package." },
  servers: [{ url: "https://example.invalid/api/mobile/v1", description: "Reserved documentation placeholder; replace only after backend selection" }],
  "x-production-enabled": false,
  paths: {
    "/auth/sign-in": { post: signIn },
    "/auth/sign-out": { post: operation("mobileSignOut", "lib/auth.ts") },
    "/me": { get: operation("mobileMe", "app/api/me/route.ts", undefined, "Profile") },
    "/account/password": { post: operation("mobileChangePassword", "app/actions/account.ts", "PasswordChange") },
    "/account/onboarding": { post: operation("mobileOnboarding", "app/actions/account.ts", "Onboarding") },
    "/account/recording-consent": { delete: operation("mobileWithdrawConsent", "lib/services/recording-consent.ts") },
    "/account": { delete: operation("mobileDeleteAccount", "lib/services/deletion.ts", "AccountDeletion") },
    "/levels": { get: operation("mobileLevels", "app/api/levels/route.ts") },
    "/sessions": { post: { ...createSession, responses: { ...createSession.responses, "201": { ...createSession.responses["200"], description: "Created; 200 means an existing session was reused" } } }, get: { ...operation("mobileListSessions", "app/api/sessions/route.ts"), parameters: [searchPage[1], { name: "mode", in: "query", schema: { type: "string", enum: ["level", "mock", "practice", "retry"] } }] } },
    "/sessions/{id}": { parameters: pathId, get: operation("mobileSession", "app/api/sessions/[id]/route.ts"), delete: operation("mobileDeleteSession", "lib/services/deletion.ts") },
    "/sessions/{id}/state": { parameters: pathId, get: operation("mobileSessionState", "app/api/sessions/[id]/state/route.ts") },
    "/sessions/{id}/events": { parameters: pathId, post: operation("mobileSessionEvent", "app/api/sessions/[id]/events/route.ts", "SessionEvent") },
    "/sessions/{id}/report": { parameters: pathId, get: operation("mobileReport", "app/api/sessions/[id]/report/route.ts") },
    "/answers/upload-ticket": { post: operation("mobileUploadTicket", "app/api/answers/upload-ticket/route.ts", "UploadTicket") },
    "/answers/{id}/submit": { parameters: pathId, post: operation("mobileSubmitAnswer", "app/api/answers/[id]/submit/route.ts") },
    "/answers/{id}": { parameters: pathId, get: operation("mobileAnswer", "app/api/answers/[id]/route.ts") },
    "/answers/{id}/retry": { parameters: pathId, post: operation("mobileRetryProcessing", "app/api/answers/[id]/retry/route.ts") },
    "/answers/{id}/reference-audio": { parameters: pathId, post: operation("mobileReferenceAudio", "app/api/answers/[id]/reference-audio/route.ts") },
    "/answers/{id}/audio": { parameters: pathId,
      get: { ...operation("mobileReplay", "app/api/answers/[id]/audio/route.ts"), parameters: [{ name: "Range", in: "header", schema: string, description: "Authenticated replay byte range" }], responses: { "200": { description: "Authenticated audio" }, "206": { description: "Authenticated byte range" }, "416": { description: "Unsatisfiable range" }, ...errorResponses } },
      put: { ...operation("mobileUploadAudio", "app/api/answers/[id]/audio/route.ts"), "x-max-upload-bytes": 25 * 1024 * 1024, parameters: [{ name: "ticket", in: "query", required: true, schema: string, description: "Short-lived object-bound upload capability; redact from logs" }], requestBody: { required: true, content: { "audio/mp4": { schema: { type: "string", format: "binary" } }, "audio/wav": { schema: { type: "string", format: "binary" } } } } },
    },
    "/thoughts": { get: { ...operation("mobileThoughts", "app/api/thoughts/route.ts"), parameters: searchPage }, post: operation("mobileGenerateThought", "app/api/thoughts/route.ts", "GenerateThought") },
    "/thoughts/{id}": { parameters: pathId, get: operation("mobileThought", "app/api/thoughts/[id]/route.ts"), put: operation("mobileEditThought", "app/api/thoughts/[id]/route.ts", "EditThought"), delete: operation("mobileDeleteThought", "app/api/thoughts/[id]/route.ts") },
    "/thoughts/{id}/review": { parameters: pathId, post: operation("mobileThoughtReview", "app/api/thoughts/[id]/review/route.ts", "ThoughtReview") },
    "/vocabulary": { get: { ...operation("mobileVocabulary", "app/api/vocabulary/route.ts"), parameters: searchPage }, post: operation("mobileSaveVocabulary", "app/api/vocabulary/route.ts", "SaveVocabulary") },
    "/vocabulary/{id}": { parameters: pathId, put: operation("mobileEditVocabulary", "app/api/vocabulary/[id]/route.ts", "VocabularyEdit"), delete: operation("mobileDeleteVocabulary", "app/api/vocabulary/[id]/route.ts") },
    "/reviews": { get: operation("mobileReviews", "lib/services/reviews.ts") },
    "/growth": { get: { ...operation("mobileGrowth", "lib/services/growth.ts"), parameters: monthQuery } },
    "/rewards": { get: operation("mobileRewards", "app/api/rewards/route.ts"), post: operation("mobileRewardAction", "app/api/rewards/route.ts", "RewardAction") },
    "/usage": { get: { ...operation("mobileUsage", "lib/ai/account.ts"), parameters: [...monthQuery, searchPage[1]] } },
  },
  components: {
    securitySchemes: { NativeSessionProposal: { type: "http", scheme: "bearer", description: "Proposed signed opaque session token, not JWT. Secure native storage/network integration is pending." } },
    schemas: {
      Object: { type: "object", additionalProperties: true, description: "Detailed DTO to be frozen with the native service integration; not a claim about current response fields." },
      Error: object({ error: { type: "object", properties: { code: string, message: string }, required: ["code", "message"], additionalProperties: true } }),
      SignIn: object({ email: { type: "string", format: "email" }, password: { type: "string", minLength: 8, maxLength: 128, writeOnly: true } }),
      SignInResult: object({ user: ref("Profile") }),
      Profile: object({ id, email: { type: "string", format: "email" }, mustChangePassword: { type: "boolean" }, onboarded: { type: "boolean" }, consentAllowed: { type: "boolean" }, consentVersion: { type: "integer", minimum: 0 } }),
      PasswordChange: object({ currentPassword: { ...string, writeOnly: true }, newPassword: { ...string, minLength: 8, maxLength: 128, writeOnly: true }, confirmPassword: { ...string, writeOnly: true } }),
      Onboarding: object({ targetBand: { type: "string", enum: ["5.5", "6", "6.5", "7", "7.5", "8+"] }, selfLevel: { type: "string", enum: ["beginner", "intermediate", "advanced"] }, consent: { const: true } }),
      AccountDeletion: object({ password: { ...string, writeOnly: true }, confirmText: { const: "删除我的账号" } }),
      CreateSession: object({ mode: { type: "string", enum: ["level", "mock", "practice", "retry"] }, levelId: { ...string, maxLength: 10 }, mockSetId: { ...string, maxLength: 20 }, questionId: { ...string, maxLength: 40 }, sourceAnswerId: { ...string, maxLength: 60 }, fresh: { type: "boolean" } }, ["mode"]),
      SessionEvent: object({ eventId: { ...id, minLength: 8 }, type: { type: "string", enum: ["start", "pause", "part_start", "position", "skip", "finish", "interrupt", "heartbeat"] }, expectedVersion: { type: "integer", minimum: 0 }, startEventId: { ...id, minLength: 8 }, takeover: { type: "boolean" }, expectedActivationId: { type: ["string", "null"], minLength: 8, maxLength: 100 }, pendingUploads: { type: "array", maxItems: 100, items: ref("PendingUpload") }, part: { type: "integer" }, position: { type: "integer" }, planIndex: { type: "integer" }, reason: { type: "string", maxLength: 100 } }, ["eventId", "type"]),
      PendingUpload: object({ submissionId: { ...id, pattern: "^[A-Za-z0-9_-]{8,80}$" }, planIndex: { type: "integer", minimum: 0 }, kind: { type: "string", enum: ["main", "followup", "rounding"] }, followUpId: { type: ["string", "null"], maxLength: 60 }, consentVersion: { type: "integer", minimum: 0 } }, ["submissionId", "planIndex", "kind", "consentVersion"]),
      UploadTicket: object({ sessionId: { ...id, maxLength: 60 }, planIndex: { type: "integer", minimum: 0 }, kind: { type: "string", enum: ["main", "followup", "rounding"] }, followUpId: { type: ["string", "null"], maxLength: 60 }, activationId: { type: ["string", "null"], minLength: 8, maxLength: 100 }, fragmentCopy: { type: "boolean" }, submissionId: { ...id, minLength: 8, maxLength: 80 }, clientDurationMs: { type: "number", minimum: 0, maximum: 1800000 }, consentVersion: { type: "integer", minimum: 0 }, interrupted: { type: "boolean" } }, ["sessionId", "planIndex", "kind", "submissionId", "clientDurationMs", "consentVersion"]),
      GenerateThought: object({ sourceText: { ...string, minLength: 3, maxLength: 2000 }, requestId: { ...string, format: "uuid" } }),
      EditThought: object({ revision: { type: "integer", minimum: 0 }, title: { ...string, minLength: 1, maxLength: 80 }, sourceText: { ...string, minLength: 3, maxLength: 2000 }, simple: { ...string, minLength: 3, maxLength: 1200 }, natural: { ...string, minLength: 3, maxLength: 2000 }, nuanced: { ...string, minLength: 3, maxLength: 2800 } }),
      ThoughtReview: { oneOf: [object({ action: { enum: ["enroll", "remove"] }, revision: { type: "integer", minimum: 0 } }), object({ action: { const: "practice" }, revision: { type: "integer", minimum: 0 }, requestId: { ...string, format: "uuid" }, outcome: { enum: ["practice", "again", "remembered"] }, recalledText: { ...string, maxLength: 2800 }, durationSeconds: { type: "number", minimum: 0, maximum: 300 } }, ["action", "revision", "requestId", "outcome"])] },
      SaveVocabulary: object({ thoughtId: { ...string, format: "uuid" }, revision: { type: "integer", minimum: 0 }, indices: { type: "array", minItems: 1, maxItems: 8, items: { type: "integer", minimum: 0, maximum: 7 } } }),
      VocabularyEdit: object({ term: { ...string, minLength: 3, maxLength: 100 }, meaning: { ...string, minLength: 1, maxLength: 300 }, example: { ...string, maxLength: 800 } }),
      RewardAction: { oneOf: [object({ action: { const: "checkin" } }), object({ action: { const: "redeem" }, requestId: { ...id, pattern: "^[A-Za-z0-9_-]{8,100}$" }, offer: object({ cost: { type: "integer" }, minutes: { type: "integer" }, days: { type: "integer" } }) }, ["action", "requestId"]), object({ action: { const: "review" }, answerId: id })] },
    },
  },
};
