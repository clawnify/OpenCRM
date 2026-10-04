// Clawnify integrations — one place that wraps @clawnify/connections so the rest
// of the app never thinks about credentials or brokers. Every capability routes
// through connect(service, env).run(ACTION, args): the platform injects the
// CREDENTIALS binding + CLAWNIFY_ORG_ID at build time, resolves the org's
// connection, and executes the managed action. Off-platform (local `pnpm dev`)
// there's no binding, so nothing reads as connected and the UI disables the
// buttons instead of failing.
//
// Action slugs + argument shapes verified against docs.composio.dev/toolkits/*.
// Keeping the (service, action) pairs here means a Composio rename is a one-line
// edit, not a hunt across the codebase.

import { connect, describe, type ConnectionsEnv } from "@clawnify/connections";

// Canonical service ids (never invent these — they come from the Clawnify
// connections catalog). Mail goes through Gmail and meetings through Google
// Calendar; Google Workspace (googlesuper) covers both, and stands in for
// whichever of the two the org hasn't connected. slack = Slack. All
// Composio-managed.
export const SERVICES = {
  email: "gmail",
  meeting: "googlecalendar",
  google: "googlesuper",
  slack: "slack",
} as const;

export interface ConnectionStatus {
  email: boolean;
  meeting: boolean;
  slack: boolean;
}

/**
 * A connected Google service. Composio names every action <TOOLKIT>_<ACTION>,
 * and Google Workspace carries Gmail's and Calendar's actions under the same
 * names with the same arguments (GMAIL_FETCH_EMAILS = GOOGLESUPER_FETCH_EMAILS),
 * so callers name the action without its toolkit: mail.run("FETCH_EMAILS", …).
 */
export interface GoogleConnection {
  service: string;
  run(action: string, args: Record<string, unknown>): Promise<unknown>;
}

/** The services the org has connected, in one call to the broker. */
async function connectedServices(env: ConnectionsEnv): Promise<Set<string>> {
  const all = await describe(env, undefined, Object.values(SERVICES).map((service) => ({ service, as: "integration" as const })));
  return new Set(all.filter((s) => s.connected).map((s) => s.id));
}

/** The service that does `own`'s job: itself when connected, else Google Workspace. */
function serviceFor(connected: Set<string>, own: string): string | null {
  if (connected.has(own)) return own;
  return connected.has(SERVICES.google) ? SERVICES.google : null;
}

function google(env: ConnectionsEnv, connected: Set<string>, own: string): GoogleConnection | null {
  const service = serviceFor(connected, own);
  if (!service) return null;
  const client = connect(service, env);
  const toolkit = service.toUpperCase();
  return { service, run: (action, args) => client.run(`${toolkit}_${action}`, args) };
}

/** Which integrations the org has connected right now (drives UI enable/disable). */
export async function connectionStatus(env: ConnectionsEnv): Promise<ConnectionStatus> {
  const connected = await connectedServices(env);
  return {
    email: !!serviceFor(connected, SERVICES.email),
    meeting: !!serviceFor(connected, SERVICES.meeting),
    slack: connected.has(SERVICES.slack),
  };
}

/** The org's mail: Gmail, or Google Workspace when Gmail isn't connected. */
export async function mailConnection(env: ConnectionsEnv): Promise<GoogleConnection | null> {
  return google(env, await connectedServices(env), SERVICES.email);
}

/** Who an email goes to. `to` holds at least one address. */
export interface Recipients {
  to: string[];
  cc?: string[];
  bcc?: string[];
}

async function mail(env: ConnectionsEnv): Promise<GoogleConnection> {
  const m = await mailConnection(env);
  if (!m) throw new Error("Connect Gmail in Clawnify first.");
  return m;
}

/** Composio takes the first "To" alone and the rest as extra_recipients. */
function addressing(r: Recipients) {
  return {
    recipient_email: r.to[0],
    ...(r.to.length > 1 ? { extra_recipients: r.to.slice(1) } : {}),
    ...(r.cc?.length ? { cc: r.cc } : {}),
    ...(r.bcc?.length ? { bcc: r.bcc } : {}),
  };
}

/** Send a new email from the org's mailbox (Composio GMAIL_SEND_EMAIL). */
export async function sendEmail(
  env: ConnectionsEnv,
  args: Recipients & { subject: string; body: string; isHtml?: boolean },
): Promise<unknown> {
  return (await mail(env)).run("SEND_EMAIL", {
    ...addressing(args),
    subject: args.subject,
    body: args.body,
    is_html: args.isHtml ?? false,
  });
}

/** Reply inside a Gmail thread, which keeps the thread's subject (GMAIL_REPLY_TO_THREAD). */
export async function replyToThread(
  env: ConnectionsEnv,
  args: Recipients & { threadId: string; body: string; isHtml?: boolean },
): Promise<unknown> {
  return (await mail(env)).run("REPLY_TO_THREAD", {
    ...addressing(args),
    thread_id: args.threadId,
    message_body: args.body,
    is_html: args.isHtml ?? false,
  });
}

/** Forward one Gmail message, with an optional note above it (GMAIL_FORWARD_MESSAGE). */
export async function forwardMessage(
  env: ConnectionsEnv,
  args: Recipients & { messageId: string; note: string },
): Promise<unknown> {
  return (await mail(env)).run("FORWARD_MESSAGE", {
    message_id: args.messageId,
    recipients: args.to,
    ...(args.cc?.length ? { cc: args.cc } : {}),
    ...(args.bcc?.length ? { bcc: args.bcc } : {}),
    ...(args.note ? { additional_text: args.note } : {}),
  });
}

/** Create a Google Calendar event (Composio GOOGLECALENDAR_CREATE_EVENT), through
 *  Google Workspace when Calendar isn't connected. */
export async function createMeeting(
  env: ConnectionsEnv,
  args: {
    summary: string;
    startDatetime: string; // e.g. "2026-07-16T13:00:00" (no offset — timezone is separate)
    timezone: string; // e.g. "America/New_York"
    durationHour?: number;
    durationMinutes?: number;
    attendees?: string[]; // email strings
    description?: string;
  },
): Promise<unknown> {
  const calendar = google(env, await connectedServices(env), SERVICES.meeting);
  if (!calendar) throw new Error("Connect Google Calendar in Clawnify first.");
  return calendar.run("CREATE_EVENT", {
    summary: args.summary,
    start_datetime: args.startDatetime,
    timezone: args.timezone,
    event_duration_hour: args.durationHour ?? 0,
    event_duration_minutes: args.durationMinutes ?? 30,
    ...(args.attendees?.length ? { attendees: args.attendees } : {}),
    ...(args.description ? { description: args.description } : {}),
  });
}

/** Post a message to a Slack channel (Composio SLACK_SEND_MESSAGE). */
export async function notifySlack(
  env: ConnectionsEnv,
  args: { channel: string; text: string },
): Promise<unknown> {
  return connect(SERVICES.slack, env).run("SLACK_SEND_MESSAGE", {
    channel: args.channel,
    markdown_text: args.text,
  });
}
