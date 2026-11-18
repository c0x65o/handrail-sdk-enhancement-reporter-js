import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createRequestScopedEnhancementReporter,
  createSameOriginEnhancementReporterHandler,
} from "../dist/server.js";

test("package has no MCP install or runtime dependency", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const serverBundle = await readFile(new URL("../dist/server.js", import.meta.url), "utf8");
  assert.equal(manifest.dependencies?.["@handrail/mcp"], undefined);
  assert.equal(manifest.peerDependencies?.["@handrail/mcp"], undefined);
  assert.equal(manifest.devDependencies?.["@handrail/mcp"], undefined);
  assert.doesNotMatch(serverBundle, /@handrail\/mcp/u);
});

function setup(session = "session-1") {
  const calls = [];
  const client = {
    discover: async () => ({ contract_version: "v1", policy: { delivery_ceiling: "work_request" } }),
    list: async (input) => { calls.push(["list", input]); return { contract_version: "v1", requests: [], pagination: { limit: 20, offset: 0, total: 0, has_more: false } }; },
    lookup: async ({ request_id }) => ({ id: request_id, status: "needs_attention", terminal: false }),
    releaseStatus: async ({ request_id }) => ({ contract_version: "v1", request_id }),
    dismiss: async ({ request_id }) => { calls.push(["dismiss", { request_id }]); return { contract_version: "v1", request_id, dismissed_at: "2026-08-13T20:00:00.000Z", underlying_request_preserved: true }; },
    restore: async ({ request_id }) => { calls.push(["restore", { request_id }]); return { contract_version: "v1", request_id, dismissed: false, dismissed_at: null, underlying_request_preserved: true }; },
    dismissSucceeded: async () => { calls.push(["dismissSucceeded"]); return { contract_version: "v1", dismissed_count: 2, underlying_requests_preserved: true }; },
    cancel: async ({ request_id }) => ({ id: request_id, status: "cancelled", terminal: true }),
    subscribe: async ({ request_id, reporter_notification }) => {
      calls.push(["subscribe", { request_id, reporter_notification }]);
      return {
        contract_version: "v1",
        notification_subscription: {
          active: true,
          created: true,
          recipient_hint: "r***@example.com",
          subscribed_at: "2026-08-25T12:00:00.000Z",
        },
      };
    },
    answerInformationRequest: async (input) => {
      calls.push(["answerInformationRequest", input]);
      return { contract_version: "v1", answered: true, replayed: false, information_request_id: input.information_request_id, assessment_id: "assessment-2", assessment_status: "queued", warning: null, implementation_authority: false, deployment_authority: false };
    },
    submit: async (input) => { calls.push(["submit", input]); return { request: { id: "enhancement-1", status: "received", terminal: false, linked_work_request: null }, replayed: false }; },
    downloadAttachment: async () => ({ data: Uint8Array.from([1, 2, 3]), filename: "screen.png", mime_type: "image/png", size_bytes: 3 }),
  };
  const resolved = [];
  const handler = createSameOriginEnhancementReporterHandler({
    apiUrl: "https://handrail.example/api/enhancement-reporting/v1",
    projectId: "project-1",
    capabilityId: "capability-1",
    token: "secret",
    resolveApplicationSessionToken: async (request) => { resolved.push(request.url); return session; },
    createClient: (token) => { assert.equal(token, session); return client; },
  });
  return { handler, calls, resolved };
}

test("handler requires an authenticated Known User session", async () => {
  const { handler } = setup("");
  const response = await handler(new Request("https://app.example/api/handrail-enhancements"));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "enhancement_user_authentication_required");
});

test("handler fails closed when the exact runtime is disabled", async () => {
  let resolved = false;
  let created = false;
  const handler = createSameOriginEnhancementReporterHandler({
    enabled: false,
    apiUrl: "https://handrail.example/api/enhancement-reporting/v1",
    projectId: "project-1",
    capabilityId: "capability-1",
    token: "secret",
    resolveApplicationSessionToken: async () => {
      resolved = true;
      return "known-user-session";
    },
    createClient: () => {
      created = true;
      throw new Error("disabled runtime must not create a transport");
    },
  });

  const response = await handler(new Request("https://app.example/api/handrail-enhancements"));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "enhancement_reporting_disabled");
  assert.equal(resolved, false);
  assert.equal(created, false);
});

test("request-scoped transport requires and forwards only the current Known User session", async () => {
  const calls = [];
  const factory = createRequestScopedEnhancementReporter({
    apiUrl: "https://handrail.example/api/enhancement-reporting/v1",
    projectId: "project-1",
    capabilityId: "capability-1",
    token: "transport-secret",
    resolveApplicationSessionToken: async (request) => request.session,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        contract_version: "v1",
        enhancement_reporting: { enabled: true },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(
    () => factory.forRequest({ session: null }),
    { code: "enhancement_user_authentication_required" },
  );
  const client = await factory.forRequest({ session: "fresh-session" });
  await client.discover();
  assert.equal(calls[0].init.headers["x-handrail-application-session"], "fresh-session");
  assert.equal(calls[0].init.headers.authorization, "Bearer transport-secret");
  assert.doesNotMatch(JSON.stringify(await client.discover()), /fresh-session|transport-secret/u);
});

test("default server transport stands alone without the MCP package", async () => {
  const calls = [];
  const handler = createSameOriginEnhancementReporterHandler({
    apiUrl: "https://handrail.example/api/enhancement-reporting/v1",
    projectId: "project-1",
    capabilityId: "capability-1",
    token: "server-secret",
    resolveApplicationSessionToken: async () => "known-user-session",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        contract_version: "v1",
        request_id: "enhancement-1",
        dismissed_at: "2026-08-14T14:00:00.000Z",
        underlying_request_preserved: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await handler(new Request("https://app.example/api/handrail-enhancements/requests/enhancement-1/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example" },
    body: "{}",
  }));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).underlying_request_preserved, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://handrail.example/api/enhancement-reporting/v1/requests/enhancement-1/dismiss");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "{}");
  assert.equal(calls[0].init.headers.authorization, "Bearer server-secret");
  assert.equal(calls[0].init.headers["x-handrail-api-contract-version"], "v1");
  assert.equal(calls[0].init.headers["x-handrail-application-session"], "known-user-session");
});

test("handler strips every browser-supplied execution field and forwards intake only", async () => {
  const { handler, calls } = setup();
  const response = await handler(new Request("https://app.example/api/handrail-enhancements", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example" },
    body: JSON.stringify({
      idempotency_key: "intent-1",
      external_conversation_id: "conversation-1",
      title: "Saved views",
      description: "Let me save filters.",
      requested_delivery_ceiling: "production",
      auto_deploy_env: "production",
      run_codex: true,
      automation_requests: { run_work_request: true, deploy_staging: true, unexpected: true },
      attachments: [],
    }),
  }));
  assert.equal(response.status, 201);
  const payload = calls[0][1];
  assert.equal(payload.submission_kind, "enhancement");
  assert.equal(payload.source, "web_enhancement_reporter");
  assert.equal("requested_delivery_ceiling" in payload, false);
  assert.equal("run_codex" in payload, false);
  assert.equal("auto_deploy_env" in payload, false);
  assert.equal("automation_requests" in payload, false);
  assert.equal(payload.reporter_sdk.package, "@handrail/enhancement-reporter");
});

test("handler validates and forwards report-scoped notification consent", async () => {
  const { handler, calls } = setup();
  const response = await handler(new Request(
    "https://app.example/api/handrail-enhancements/requests/enhancement-1/subscription",
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({
        reporter_notification: {
          notify_on_resolution: true,
        },
      }),
    },
  ));
  assert.equal(response.status, 201);
  assert.deepEqual(calls[0], ["subscribe", {
    request_id: "enhancement-1",
    reporter_notification: {
      notify_on_resolution: true,
      consent_version: "v1",
    },
  }]);
  assert.equal((await response.json()).notification_subscription.active, true);
});

test("history controls and image downloads remain on the authenticated same-origin route", async () => {
  const { handler, calls } = setup();
  const list = await handler(new Request("https://app.example/api/handrail-enhancements?limit=10&search=calendar&status_group=succeeded&sort=oldest&visibility=dismissed"));
  assert.equal(list.status, 200);
  assert.deepEqual(calls[0], ["list", {
    limit: "10",
    offset: undefined,
    search: "calendar",
    status_group: "succeeded",
    sort: "oldest",
    visibility: "dismissed",
  }]);
  const image = await handler(new Request("https://app.example/api/handrail-enhancements/requests/enhancement-1/attachments/image-1"));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3]);
  const dismissed = await handler(new Request("https://app.example/api/handrail-enhancements/requests/enhancement-1/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example" },
    body: "{}",
  }));
  assert.equal(dismissed.status, 200);
  assert.equal((await dismissed.json()).underlying_request_preserved, true);
  assert.deepEqual(calls.at(-1), ["dismiss", { request_id: "enhancement-1" }]);
  const restored = await handler(new Request("https://app.example/api/handrail-enhancements/requests/enhancement-1/dismiss", {
    method: "DELETE",
    headers: { origin: "https://app.example" },
  }));
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).dismissed, false);
  assert.deepEqual(calls.at(-1), ["restore", { request_id: "enhancement-1" }]);
  const cleared = await handler(new Request("https://app.example/api/handrail-enhancements/requests/dismiss-succeeded", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.example" },
    body: "{}",
  }));
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).dismissed_count, 2);
  assert.deepEqual(calls.at(-1), ["dismissSucceeded"]);
});

test("cross-site submissions are rejected before session resolution", async () => {
  const { handler, resolved } = setup();
  const response = await handler(new Request("https://app.example/api/handrail-enhancements", { headers: { origin: "https://evil.example" } }));
  assert.equal(response.status, 403);
  assert.equal(resolved.length, 0);
});

function answerRequest(body, { method = "POST", path = "requests/enhancement-1/clarifications" } = {}) {
  return new Request(`https://app.example/api/handrail-enhancements/${path}`, {
    method,
    headers: { "content-type": "application/json", origin: "https://app.example" },
    ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

test("handler forwards information request answers with exactly the contract keys", async () => {
  const { handler, calls } = setup();
  const response = await handler(answerRequest({ information_request_id: "ir-1", option: "Only visible columns", answer: "  Keep the sort order.  " }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).answered, true);
  assert.deepEqual(calls.at(-1), ["answerInformationRequest", {
    request_id: "enhancement-1",
    information_request_id: "ir-1",
    option: "Only visible columns",
    answer: "Keep the sort order.",
  }]);
  const written = await handler(answerRequest({ information_request_id: "ir-1", option: null, answer: "Only totals." }));
  assert.equal(written.status, 200);
  assert.deepEqual(calls.at(-1), ["answerInformationRequest", { request_id: "enhancement-1", information_request_id: "ir-1", answer: "Only totals." }]);
});

test("handler rejects malformed answers and unknown clarification routes before forwarding", async () => {
  const { handler, calls } = setup();
  for (const body of [
    { information_request_id: "ir-1", answer: "Yes", implementation_authority: true },
    { information_request_id: "ir-1", answer: "Yes", request_id: "other" },
    { information_request_id: "ir-1" },
    { information_request_id: "ir-1", answer: "   " },
    { information_request_id: "", answer: "Yes" },
    { answer: "Yes" },
    { information_request_id: "ir-1", option: 2 },
    { information_request_id: "ir-1", answer: "x".repeat(4_001) },
    "not json",
    [],
  ]) {
    const response = await handler(answerRequest(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).code, "information_request_answer_invalid");
  }
  assert.equal((await handler(answerRequest(null, { method: "GET" }))).status, 405);
  assert.equal((await handler(answerRequest({ information_request_id: "ir-1", answer: "Yes" }, { method: "PUT" }))).status, 405);
  assert.equal((await handler(answerRequest({ information_request_id: "ir-1", answer: "Yes" }, { path: "requests/enhancement-1/clarify" }))).status, 405);
  assert.equal((await handler(answerRequest({ information_request_id: "ir-1", answer: "Yes" }, { path: "requests/enhancement-1/clarifications/extra" }))).status, 405);
  assert.equal(calls.length, 0);
});

test("default transport posts answers to Handrail and relays its errors", async () => {
  const calls = [];
  let reply = { status: 200, body: { contract_version: "v1", answered: true, replayed: true, information_request_id: "ir-1", assessment_id: null, assessment_status: null, warning: null, implementation_authority: false, deployment_authority: false } };
  const handler = createSameOriginEnhancementReporterHandler({
    apiUrl: "https://handrail.example/api/enhancement-reporting/v1",
    projectId: "project-1",
    capabilityId: "capability-1",
    token: "server-secret",
    resolveApplicationSessionToken: async () => "known-user-session",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    },
  });
  const response = await handler(answerRequest({ information_request_id: "ir-1", option: "Every column" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).replayed, true);
  assert.equal(calls[0].url, "https://handrail.example/api/enhancement-reporting/v1/requests/enhancement-1/clarifications");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { information_request_id: "ir-1", option: "Every column" });
  assert.equal(calls[0].init.headers.authorization, "Bearer server-secret");
  assert.equal(calls[0].init.headers["x-handrail-api-contract-version"], "v1");
  assert.equal(calls[0].init.headers["x-handrail-application-session"], "known-user-session");
  assert.equal(calls[0].init.headers["content-type"], "application/json");

  reply = { status: 409, body: { error: "This question is no longer open.", code: "information_request_closed" } };
  const rejected = await handler(answerRequest({ information_request_id: "ir-1", answer: "Yes" }));
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: "This question is no longer open.", code: "information_request_closed" });
});
