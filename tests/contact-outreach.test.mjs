import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";

// Compile the real server into a temporary sibling directory so its .js imports
// resolve without adding a test loader or changing the production build.
const root = new URL("../", import.meta.url);
let compiled, db, app, purge, failWrites = null;
const env = { STORAGE: { async query(sql, params = []) {
  if (failWrites?.test(sql)) throw new Error("fixture write failed");
  const rows = db.prepare(sql).all(...params);
  const meta = db.prepare("SELECT changes() AS changes, last_insert_rowid() AS last_row_id").get();
  return { rows, meta };
} } };

before(async () => {
  compiled = await mkdtemp(fileURLToPath(new URL(".outreach-test-", root)));
  for (const file of await readdir(new URL("src/server/", root))) {
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(new URL(`src/server/${file}`, root), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } });
    await writeFile(`${compiled}/${file.replace(/\.ts$/, ".js")}`, outputText);
  }
  app = (await import(pathToFileURL(`${compiled}/index.js`))).default;
  ({ purge } = await import(pathToFileURL(`${compiled}/email-sync.js`)));
  db = new DatabaseSync(":memory:");
  db.exec(await readFile(new URL("src/server/schema.sql", root), "utf8"));
});
beforeEach(() => {
  failWrites = null;
  db.exec("DELETE FROM activities; DELETE FROM email_message_contacts; DELETE FROM email_messages; DELETE FROM email_accounts; DELETE FROM contacts;");
  db.prepare("INSERT INTO contacts (id, first_name, email) VALUES (?, ?, ?)").run("fixture-contact", "Fixture", "person@example.test");
});
after(async () => { db?.close(); if (compiled) await rm(compiled, { recursive: true, force: true }); });

async function request(path, body, bindings = env) {
  return app.request(path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }, bindings);
}
const log = (fields = {}) => request("/api/activities", {
  entity_type: "contact", entity_id: "fixture-contact", type: "email", body: "Follow-up sent externally", ...fields,
});
async function lastContacted() {
  const response = await request("/api/contacts/fixture-contact");
  assert.equal(response.status, 200);
  return (await response.json()).contact.last_contacted_at;
}
function synced(at, mailbox = "mailbox@example.test") {
  db.prepare("INSERT INTO email_message_contacts (mailbox, message_id, contact_id, sent_at) VALUES (?, ?, ?, ?)")
    .run(mailbox, crypto.randomUUID(), "fixture-contact", at);
}

test("dated external emails keep their event time, order, and newest last-contacted", async () => {
  assert.equal((await log({ at: "2020-06-15T11:30:00-04:00" })).status, 201);
  assert.equal(await lastContacted(), "2020-06-15T15:30:00.000Z");
  assert.equal((await log({ at: "2020-06-14T23:00:00Z", body: "Earlier touch" })).status, 201);
  assert.equal(await lastContacted(), "2020-06-15T15:30:00.000Z");
  const { activities } = await (await request("/api/activities?entity_type=contact&entity_id=fixture-contact")).json();
  assert.deepEqual(activities.map(a => a.created_at), ["2020-06-15 15:30:00", "2020-06-14 23:00:00"]);
});

test("an omitted date defaults to now; notes and scheduled meetings do not count as email outreach", async () => {
  await log({ type: "note" });
  await log({ type: "meeting" });
  assert.equal(await lastContacted(), null);
  const start = Date.now() - 1000;
  assert.equal((await log()).status, 201);
  const at = Date.parse(await lastContacted());
  assert.ok(at >= start && at <= Date.now());
});

test("a calendar day is accepted and stored consistently with dated deal updates", async () => {
  assert.equal((await log({ at: "2020-02-29" })).status, 201);
  assert.equal(await lastContacted(), "2020-02-29T12:00:00.000Z");
});

test("bad dates and missing contacts fail without recording outreach", async () => {
  for (const at of ["nonsense", "2020-02-30", "2020-02-30T10:00:00Z", "2020-06-15T10:00:00", "2999-01-01T00:00:00Z", "", null, 42]) {
    assert.equal((await log({ at })).status, 400, String(at));
  }
  assert.equal((await log({ entity_id: "missing" })).status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activities").get().n, 0);
  assert.equal(await lastContacted(), null);
});

test("newer synced mail wins, and purging it falls back to the logged outreach date", async () => {
  synced("2020-06-20T09:00:00.123Z");
  assert.equal((await log({ at: "2020-06-15T12:00:00Z" })).status, 201);
  assert.equal(await lastContacted(), "2020-06-20T09:00:00.123Z");
  await purge("mailbox@example.test");
  assert.equal(await lastContacted(), "2020-06-15T12:00:00.000Z");
});

test("sync recomputation cannot replace newer logged outreach with older mail", async () => {
  synced("2020-06-10T09:00:00.000Z", "keep@example.test");
  synced("2020-06-12T09:00:00.000Z");
  await log({ at: "2020-06-15T12:00:00Z" });
  await purge("mailbox@example.test");
  assert.equal(await lastContacted(), "2020-06-15T12:00:00.000Z");
});

test("purging mail still clears recency when there is no logged email", async () => {
  synced("2020-06-10T09:00:00.000Z");
  await log({ type: "note" }); // initializes the real DB adapter
  await purge("mailbox@example.test");
  assert.equal(await lastContacted(), null);
});

test("explicit logging reports storage failure instead of false success", async () => {
  failWrites = /INSERT INTO activities/i;
  const response = await log({ at: "2020-06-15T12:00:00Z" });
  assert.equal(response.status, 500);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activities").get().n, 0);
  failWrites = /UPDATE contacts SET last_contacted_at/i;
  assert.equal((await log({ at: "2020-06-15T12:00:00Z" })).status, 500);
  // The adapter uses separate writes: report failure even if the activity saved.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activities").get().n, 1);
});

test("CRM-sent email also updates last-contacted without waiting for Gmail sync", async () => {
  const calls = [];
  const response = await request("/api/integrations/email", { contact_id: "fixture-contact", subject: "Fixture", body: "Synthetic message" }, {
    ...env, CLAWNIFY_ORG_ID: "fixture-org", CREDENTIALS: {
      listConnected: async () => ["gmail"],
      executeTool: async (...args) => { calls.push(args); return { successful: true, data: {} }; },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], "GMAIL_SEND_EMAIL");
  assert.ok(Date.parse(await lastContacted()) >= Date.now() - 5000);
});
