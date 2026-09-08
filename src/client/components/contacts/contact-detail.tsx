import { useEffect, useState } from "react";
import { ArrowLeft, Mail, Calendar, StickyNote, MessageSquare, Trophy, Star, LayoutGrid, Activity as ActivityIcon, Phone, Building2, Briefcase, AtSign, User, Clock, CheckSquare } from "lucide-react";
import { useCrm } from "@/context";
import { Avatar, CategoryBadge, EntityIcon } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { InlineField } from "@/components/ui/inline-field";
import { RecordTopBar, Attr, DetailsSection, Tile, RecordTabs, FutureSection } from "@/components/record-page";
import { Separator } from "@/components/ui/separator";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { Contact, Activity } from "@/types";

type FormKind = "email" | "meeting" | "note";

const ACTIVITY_STYLE: Record<string, { icon: typeof Mail; className: string }> = {
  email: { icon: Mail, className: "bg-primary/10 text-primary" },
  meeting: { icon: Calendar, className: "bg-cat-4-tint text-cat-4-text" },
  note: { icon: StickyNote, className: "bg-secondary text-muted-foreground" },
  slack: { icon: MessageSquare, className: "bg-cat-1-tint text-cat-1-text" },
  stage_change: { icon: Trophy, className: "bg-success-tint text-success" },
};

function parseMeta(meta: string): Record<string, unknown> {
  try {
    const v = JSON.parse(meta);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function metaLine(meta: Record<string, unknown>): string | null {
  if (typeof meta.to === "string" && meta.to) return `to ${meta.to}`;
  if (typeof meta.channel === "string" && meta.channel) return `#${meta.channel}`;
  return null;
}

function formatTimestamp(createdAt: string): string {
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? createdAt : d.toLocaleString();
}

export function ContactDetail({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const { fetchContact, fetchActivities, updateContact, emailContact, scheduleMeeting, addNote, connections, setError } = useCrm();

  const [contact, setContact] = useState<Contact | null | undefined>(undefined);
  const [activities, setActivities] = useState<Activity[]>([]);

  const [openForm, setOpenForm] = useState<FormKind | null>(null);
  const [busy, setBusy] = useState(false);

  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingStart, setMeetingStart] = useState("");
  const [meetingDuration, setMeetingDuration] = useState("30");
  const [noteBody, setNoteBody] = useState("");

  // Click-to-edit saves one field, then re-reads the record so derived columns
  // (company name, custom flat fields) stay consistent with the server.
  const saveField = async (patch: Partial<Contact>) => {
    if (!contact) return;
    try {
      await updateContact(contact.id, patch);
      const fresh = await fetchContact(contact.id);
      if (fresh) setContact(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };

  useEffect(() => {
    let alive = true;
    setContact(undefined);
    fetchContact(id).then((c) => {
      if (alive) setContact(c);
    });
    fetchActivities("contact", id).then((a) => {
      if (alive) setActivities(a);
    });
    return () => {
      alive = false;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadActivities = async () => {
    setActivities(await fetchActivities("contact", id));
  };

  if (contact === undefined) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (contact === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
        <p className="text-sm text-muted-foreground">Contact not found.</p>
        <Button size="sm" variant="outline" onClick={() => navigate("/contacts")}>
          <ArrowLeft className="size-4" />
          Back to contacts
        </Button>
      </div>
    );
  }

  const fullName = `${contact.first_name} ${contact.last_name}`.trim() || "Contact";

  const openFormKind = (kind: FormKind) => {
    if (openForm === kind) {
      setOpenForm(null);
      return;
    }
    setOpenForm(kind);
    if (kind === "email") {
      setSubject("");
      setEmailBody("");
    } else if (kind === "meeting") {
      setMeetingTitle(`Meeting with ${fullName}`);
      setMeetingStart("");
      setMeetingDuration("30");
    } else {
      setNoteBody("");
    }
  };

  const afterAction = async () => {
    setOpenForm(null);
    await reloadActivities();
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await emailContact(contact.id, subject, emailBody);
      await afterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setBusy(false);
    }
  };

  const submitMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await scheduleMeeting(contact.id, {
        summary: meetingTitle,
        start_datetime: meetingStart.slice(0, 19),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        duration_minutes: Number(meetingDuration),
      });
      await afterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule meeting");
    } finally {
      setBusy(false);
    }
  };

  const submitNote = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await addNote("contact", contact.id, noteBody);
      await afterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setBusy(false);
    }
  };

  const noteCount = activities.filter((a) => a.type === "note").length;
  const emailCount = activities.filter((a) => a.type === "email").length;
  const recent = [...activities].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const tabs: Array<{ key: string; label: string; icon: typeof Mail; count?: number }> = [
    { key: "overview", label: "Overview", icon: LayoutGrid },
    { key: "activity", label: "Activity", icon: ActivityIcon, count: activities.length },
    { key: "emails", label: "Emails", icon: Mail, count: emailCount },
    { key: "notes", label: "Notes", icon: StickyNote, count: noteCount },
    { key: "tasks", label: "Tasks", icon: CheckSquare, count: 0 },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top bar: same height and rule as the sidebar brand row, so the line runs across. */}
      <RecordTopBar onClose={() => navigate("/contacts")} crumb="Contacts" />

      <div className="flex min-h-0 flex-1">
        {/* Left column: identity, actions, record details. */}
        <aside className="flex w-[31.25rem] shrink-0 flex-col overflow-y-auto border-r border-border">
          <div className="flex items-center gap-3 px-4 pt-4">
            <Avatar firstName={contact.first_name} lastName={contact.last_name} className="size-9 text-xs" />
            <div className="flex min-w-0 flex-1 items-center">
              <InlineField value={contact.first_name} placeholder="First name" onSave={(v) => saveField({ first_name: v })} className="h-8 w-auto px-1.5 text-base font-semibold" />
              <InlineField value={contact.last_name} placeholder="Last name" onSave={(v) => saveField({ last_name: v })} className="h-8 w-auto px-1.5 text-base font-semibold" />
            </div>
            <Button variant="ghost" size="icon" aria-label="Favourite" title="Favourite"><Star className="size-4" /></Button>
          </div>

          <div className="flex flex-wrap gap-2 px-4 pt-3 pb-4">
            <Button variant="outline" size="sm" onClick={() => openFormKind("email")} disabled={!connections.email} title={connections.email ? undefined : "Connect Gmail in Clawnify"}>
              <Mail className="size-4" /> Compose email
            </Button>
            <Button variant="outline" size="sm" onClick={() => openFormKind("meeting")} disabled={!connections.meeting} title={connections.meeting ? undefined : "Connect Google Calendar in Clawnify"} aria-label="Schedule meeting">
              <Calendar className="size-4" /> Meeting
            </Button>
            <Button variant="outline" size="icon" onClick={() => openFormKind("note")} aria-label="Add note" title="Add note">
              <StickyNote className="size-4" />
            </Button>
          </div>

          {openForm === "email" && (
            <form onSubmit={submitEmail} className="mx-4 mb-4 flex flex-col gap-3 rounded-md p-4 shadow-edge">
              <div className="flex flex-col gap-1.5"><Label htmlFor="email-subject">Subject</Label><Input id="email-subject" required value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
              <div className="flex flex-col gap-1.5"><Label htmlFor="email-body">Message</Label><Textarea id="email-body" required value={emailBody} onChange={(e) => setEmailBody(e.target.value)} /></div>
              <div className="flex justify-end"><Button type="submit" size="sm" disabled={busy}>{busy ? "Sending…" : "Send email"}</Button></div>
            </form>
          )}
          {openForm === "meeting" && (
            <form onSubmit={submitMeeting} className="mx-4 mb-4 flex flex-col gap-3 rounded-md p-4 shadow-edge">
              <div className="flex flex-col gap-1.5"><Label htmlFor="meeting-title">Title</Label><Input id="meeting-title" required value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5"><Label htmlFor="meeting-start">Start</Label><Input id="meeting-start" type="datetime-local" required value={meetingStart} onChange={(e) => setMeetingStart(e.target.value)} /></div>
                <div className="flex flex-col gap-1.5"><Label htmlFor="meeting-duration">Duration</Label>
                  <Select value={meetingDuration} onValueChange={setMeetingDuration}>
                    <SelectTrigger id="meeting-duration"><SelectValue /></SelectTrigger>
                    <SelectContent>{["15", "30", "45", "60"].map((m) => <SelectItem key={m} value={m}>{m} min</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end"><Button type="submit" size="sm" disabled={busy}>{busy ? "Scheduling…" : "Schedule meeting"}</Button></div>
            </form>
          )}
          {openForm === "note" && (
            <form onSubmit={submitNote} className="mx-4 mb-4 flex flex-col gap-3 rounded-md p-4 shadow-edge">
              <div className="flex flex-col gap-1.5"><Label htmlFor="note-body">Note</Label><Textarea id="note-body" required value={noteBody} onChange={(e) => setNoteBody(e.target.value)} /></div>
              <div className="flex justify-end"><Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Add note"}</Button></div>
            </form>
          )}

          <DetailsSection title="Record details">
            <dl className="flex flex-col">
              <Attr icon={User} label="Name"><span className="px-2 text-sm">{fullName}</span></Attr>
              <Attr icon={AtSign} label="Email addresses">
                <InlineField type="email" value={contact.email} placeholder="Set email…" onSave={(v) => saveField({ email: v })}
                  render={(v) => <a href={`mailto:${v}`} onClick={(e) => e.stopPropagation()} className="text-info hover:underline">{v}</a>} />
              </Attr>
              <Attr icon={Phone} label="Phone numbers">
                <InlineField type="tel" value={contact.phone} placeholder="Set phone…" onSave={(v) => saveField({ phone: v })} className="tabular" />
              </Attr>
              <Attr icon={Building2} label="Company">
                {contact.company_name ? (
                  <span className="inline-flex h-8 items-center gap-1.5 px-2 text-sm"><EntityIcon name={contact.company_name} domain={contact.company_domain} className="size-4" /> {contact.company_name}</span>
                ) : <span className="inline-flex h-8 items-center px-2 text-sm text-faint">Set company…</span>}
              </Attr>
              <Attr icon={Briefcase} label="Job title">
                <InlineField value={contact.title} placeholder="Set job title…" onSave={(v) => saveField({ title: v })} />
              </Attr>
              <Attr icon={Clock} label="Status"><span className="px-2"><CategoryBadge value={contact.status} /></span></Attr>
            </dl>
            <button type="button" className="mt-1 h-8 text-[0.8125rem] text-muted-foreground hover:text-foreground">View all values</button>
          </DetailsSection>

          <DetailsSection title="Lists" action={<button type="button" className="hover:text-foreground">Add to list</button>}>
            <p className="py-1 text-sm text-faint">This record has not been added to any lists</p>
          </DetailsSection>
        </aside>

        {/* Main column: tabs, highlights, activity, and the sections that will grow. */}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <RecordTabs tabs={tabs} />

          <div className="flex flex-col gap-8 p-6">
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Highlights</h2>
              <div className="grid grid-cols-3 gap-3">
                <Tile icon={AtSign} label="Email addresses" empty="No email address" value={contact.email && <a href={`mailto:${contact.email}`} className="text-info hover:underline">{contact.email}</a>} />
                <Tile icon={Phone} label="Phone numbers" empty="No phone number" value={contact.phone} />
                <Tile icon={Building2} label="Company" empty="No company" value={contact.company_name} />
                <Tile icon={Briefcase} label="Job title" empty="No job title" value={contact.title} />
                <Tile icon={Clock} label="Last activity" empty="No activity" value={recent[0] ? formatTimestamp(recent[0].created_at) : undefined} />
                <Tile icon={Calendar} label="Created" empty="Unknown" value={formatTimestamp(contact.created_at)} />
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Activity</h2>
                <button type="button" className="text-[0.8125rem] text-muted-foreground hover:text-foreground">View all</button>
              </div>
              {recent.length === 0 ? (
                <p className="text-sm text-faint">No activity yet. Send an email, schedule a meeting, or add a note.</p>
              ) : (
                <ul className="flex flex-col rounded-md bg-card shadow-edge">
                  {recent.slice(0, 6).map((a) => {
                    const style = ACTIVITY_STYLE[a.type] ?? ACTIVITY_STYLE.note;
                    const Icon = style.icon;
                    const meta = metaLine(parseMeta(a.meta));
                    return (
                      <li key={a.id} className="flex items-start gap-3 px-3.5 py-2.5 [&+li]:border-t [&+li]:border-border">
                        <span className={cn("mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full", style.className)}><Icon className="size-3" /></span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          {a.body && <p className="whitespace-pre-wrap text-sm">{a.body}</p>}
                          {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
                        </div>
                        <span className="shrink-0 tabular text-xs text-muted-foreground">{formatTimestamp(a.created_at)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <FutureSection label="Emails" count={emailCount} onAdd={() => openFormKind("email")} />
            <FutureSection label="Notes" count={noteCount} onAdd={() => openFormKind("note")} />
            <FutureSection label="Tasks" count={0} />
          </div>
        </main>
      </div>
    </div>
  );
}
