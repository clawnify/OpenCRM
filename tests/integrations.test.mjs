import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { connectionStatus, mailConnection, calendarConnection } from "../src/server/integrations.ts";

function rpc(services) {
  return {
    CLAWNIFY_ORG_ID: "fixture-org",
    CREDENTIALS: { listConnected: async (org) => {
      assert.equal(org, "fixture-org");
      return services;
    } },
  };
}

async function broker(reply, fn) {
  const server = createServer(reply);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await fn({
      CLAWNIFY_TOKEN: "synthetic-test-token",
      CLAWNIFY_ORG_ID: "fixture-org",
      CLAWNIFY_API_URL: `http://127.0.0.1:${server.address().port}/`,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("successful discovery keeps dedicated Google services and Workspace fallback", async () => {
  const env = rpc(["gmail", "googlecalendar", "googlesuper", "slack", "granola"]);
  assert.deepEqual(await connectionStatus(env), { email: true, meeting: true, slack: true, notes: true });
  assert.equal((await mailConnection(env)).service, "gmail");
  assert.equal((await calendarConnection(env)).service, "googlecalendar");
  assert.deepEqual(await connectionStatus(rpc(["googlesuper"])), { email: true, meeting: true, slack: false, notes: false });
  assert.equal((await mailConnection(rpc(["googlesuper"]))).service, "googlesuper");
  assert.equal((await calendarConnection(rpc(["gmail", "googlesuper"]))).service, "googlesuper");
});

test("an empty successful lookup and unconfigured local development remain disconnected", async () => {
  const empty = { email: false, meeting: false, slack: false, notes: false };
  assert.deepEqual(await connectionStatus(rpc([])), empty);
  assert.deepEqual(await connectionStatus({}), empty);
});

test("a credentials RPC failure is an error, not evidence that everything is disconnected", async () => {
  const env = rpc([]);
  env.CREDENTIALS.listConnected = async () => { throw new Error("private broker diagnostic"); };
  await assert.rejects(connectionStatus(env), (error) => {
    assert.match(error.message, /Could not check connections/);
    assert.doesNotMatch(error.message, /private broker diagnostic/);
    return true;
  });
  await assert.rejects(mailConnection(env), /Could not check connections/);
});

test("partially configured deployments report the missing binding or organization", async () => {
  await assert.rejects(connectionStatus({ CREDENTIALS: { listConnected: async () => {
    assert.fail("Must not look up another organization");
  } } }), /CLAWNIFY_ORG_ID/);
  await assert.rejects(connectionStatus({ CLAWNIFY_ORG_ID: "fixture-org" }), /CREDENTIALS or CLAWNIFY_TOKEN/);
});

test("HTTP discovery sends the configured auth and organization and keeps normal results", async () => {
  const organizations = [];
  await broker((req, res) => {
    assert.equal(req.url, "/v1/connections/connected");
    assert.equal(req.headers.authorization, "Bearer synthetic-test-token");
    organizations.push(req.headers["x-org-id"]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ services: ["gmail", "granola"] }));
  }, async (env) => {
    assert.deepEqual(await connectionStatus(env), { email: true, meeting: false, slack: false, notes: true });
    // An organization-scoped service token does not need an explicit org ID.
    assert.deepEqual(await connectionStatus({ ...env, CLAWNIFY_ORG_ID: undefined }), { email: true, meeting: false, slack: false, notes: true });
  });
  assert.deepEqual(organizations, ["fixture-org", undefined]);
});

test("HTTP authentication and service failures remain errors without exposing response bodies", async () => {
  for (const status of [401, 503]) {
    await broker((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "private upstream diagnostic" }));
    }, async (env) => {
      await assert.rejects(connectionStatus(env), (error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /private upstream diagnostic|synthetic-test-token/);
        return true;
      });
    });
  }
});

test("malformed successful responses cannot masquerade as disconnected", async () => {
  for (const payload of ["not JSON", JSON.stringify({ error: "not a service list" }), JSON.stringify({ services: [null] })]) {
    await broker((_req, res) => { res.writeHead(200); res.end(payload); }, async (env) => {
      await assert.rejects(connectionStatus(env), /Invalid connection status response/);
    });
  }
});

test("an interrupted HTTP lookup reports an error", async () => {
  await broker((req) => req.socket.destroy(), async (env) => {
    await assert.rejects(connectionStatus(env), /Could not check connections/);
  });
});
