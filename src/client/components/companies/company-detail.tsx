import { useEffect, useState } from "react";
import { ArrowLeft, Mail, Star, LayoutGrid, Activity as ActivityIcon, Phone, Globe, Building2, Tag, AtSign, Users, StickyNote, Calendar, Clock, CheckSquare } from "lucide-react";
import { useCrm } from "@/context";
import { EntityIcon, CategoryBadge } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { InlineField } from "@/components/ui/inline-field";
import { RecordTopBar, Attr, DetailsSection, Tile, RecordTabs, FutureSection } from "@/components/record-page";
import type { Company, Activity } from "@/types";

function formatTimestamp(createdAt: string): string {
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? createdAt : d.toLocaleString();
}

// The company record page: same anatomy as a contact (DESIGN.md → Record
// pages), with the company's own attributes and tiles. Every value is the
// control; there is no edit mode.
export function CompanyDetail({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const { fetchCompany, updateCompany, fetchActivities, setError } = useCrm();
  const [company, setCompany] = useState<Company | null | undefined>(undefined);
  const [activities, setActivities] = useState<Activity[]>([]);

  const saveField = async (patch: Partial<Company>) => {
    if (!company) return;
    try {
      await updateCompany(company.id, patch);
      const fresh = await fetchCompany(company.id);
      if (fresh) setCompany(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  };

  useEffect(() => {
    let alive = true;
    setCompany(undefined);
    fetchCompany(id).then((c) => { if (alive) setCompany(c); });
    fetchActivities("company", id).then((a) => { if (alive) setActivities(a); });
    return () => { alive = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (company === undefined) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (company === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
        <p className="text-sm text-muted-foreground">Company not found.</p>
        <Button size="sm" variant="outline" onClick={() => navigate("/companies")}><ArrowLeft className="size-4" /> Back to companies</Button>
      </div>
    );
  }

  const recent = [...activities].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const noteCount = activities.filter((a) => a.type === "note").length;
  const emailCount = activities.filter((a) => a.type === "email").length;
  const host = (company.domain || "").replace(/^https?:\/\//i, "").replace(/\/.*$/, "");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RecordTopBar onClose={() => navigate("/companies")} crumb="Companies" />

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[31.25rem] shrink-0 flex-col overflow-y-auto border-r border-border">
          <div className="flex items-center gap-3 px-4 pt-4">
            <EntityIcon name={company.name} domain={company.domain} className="size-9 rounded-md text-sm" />
            <div className="min-w-0 flex-1">
              <InlineField value={company.name} placeholder="Company name" onSave={(v) => saveField({ name: v })} className="h-8 w-auto px-1.5 text-base font-semibold" />
            </div>
            <Button variant="ghost" size="icon" aria-label="Favourite" title="Favourite"><Star className="size-4" /></Button>
          </div>

          <div className="flex flex-wrap gap-2 px-4 pt-3 pb-4">
            <Button variant="outline" size="sm" disabled={!company.email} asChild={!!company.email}>
              {company.email ? <a href={`mailto:${company.email}`}><Mail className="size-4" /> Compose email</a> : <span><Mail className="size-4" /> Compose email</span>}
            </Button>
            <Button variant="outline" size="sm" onClick={() => navigate(`/contacts?company=${encodeURIComponent(company.id)}`)}>
              <Users className="size-4" /> Contacts {company.contact_count ? <span className="rounded-xs bg-secondary px-1.5 text-xs tabular text-muted-foreground">{company.contact_count}</span> : null}
            </Button>
          </div>

          <DetailsSection title="Record details">
            <dl className="flex flex-col">
              <Attr icon={Globe} label="Domains">
                <InlineField value={company.domain} placeholder="Set domain…" onSave={(v) => saveField({ domain: v })}
                  render={(v) => <a href={`https://${v.replace(/^https?:\/\//i, "")}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-info hover:underline">{v}</a>} />
              </Attr>
              <Attr icon={Building2} label="Name"><span className="px-2 text-sm">{company.name}</span></Attr>
              <Attr icon={Tag} label="Industry">
                {company.industry ? <span className="px-2"><CategoryBadge value={company.industry} /></span>
                  : <InlineField value="" placeholder="Set industry…" onSave={(v) => saveField({ industry: v })} />}
              </Attr>
              <Attr icon={AtSign} label="Email">
                <InlineField type="email" value={company.email} placeholder="Set email…" onSave={(v) => saveField({ email: v })}
                  render={(v) => <a href={`mailto:${v}`} onClick={(e) => e.stopPropagation()} className="text-info hover:underline">{v}</a>} />
              </Attr>
              <Attr icon={Phone} label="Phone">
                <InlineField type="tel" value={company.phone} placeholder="Set phone…" onSave={(v) => saveField({ phone: v })} className="tabular" />
              </Attr>
              <Attr icon={StickyNote} label="Description">
                <InlineField value={company.notes} placeholder="Set description…" onSave={(v) => saveField({ notes: v })} />
              </Attr>
            </dl>
            <button type="button" className="mt-1 h-8 text-[0.8125rem] text-muted-foreground hover:text-foreground">View all values</button>
          </DetailsSection>

          <DetailsSection title="Lists" action={<button type="button" className="hover:text-foreground">Add to list</button>}>
            <p className="py-1 text-sm text-faint">This record has not been added to any lists</p>
          </DetailsSection>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <RecordTabs tabs={[
            { key: "overview", label: "Overview", icon: LayoutGrid },
            { key: "activity", label: "Activity", icon: ActivityIcon, count: activities.length },
            { key: "emails", label: "Emails", icon: Mail, count: emailCount },
            { key: "team", label: "Team", icon: Users, count: company.contact_count ?? 0 },
            { key: "notes", label: "Notes", icon: StickyNote, count: noteCount },
            { key: "tasks", label: "Tasks", icon: CheckSquare, count: 0 },
          ]} />

          <div className="flex flex-col gap-8 p-6">
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium">Highlights</h2>
              <div className="grid grid-cols-3 gap-3">
                <Tile icon={Globe} label="Domain" empty="No domain" value={host && <a href={`https://${host}`} target="_blank" rel="noreferrer" className="text-info hover:underline">{host}</a>} />
                <Tile icon={Users} label="Team" empty="No team" value={company.contact_count ? `${company.contact_count} ${company.contact_count === 1 ? "person" : "people"}` : undefined} />
                <Tile icon={Tag} label="Industry" empty="No industry" value={company.industry} />
                <Tile icon={AtSign} label="Email" empty="No email address" value={company.email} />
                <Tile icon={Clock} label="Last activity" empty="No activity" value={recent[0] ? formatTimestamp(recent[0].created_at) : undefined} />
                <Tile icon={Calendar} label="Created" empty="Unknown" value={formatTimestamp(company.created_at)} />
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Activity</h2>
                <button type="button" className="text-[0.8125rem] text-muted-foreground hover:text-foreground">View all</button>
              </div>
              {recent.length === 0 ? (
                <p className="text-sm text-faint">No activity yet.</p>
              ) : (
                <ul className="flex flex-col rounded-md bg-card shadow-edge">
                  {recent.slice(0, 6).map((a) => (
                    <li key={a.id} className="flex items-start gap-3 px-3.5 py-2.5 [&+li]:border-t [&+li]:border-border">
                      <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"><StickyNote className="size-3" /></span>
                      <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm">{a.body}</p>
                      <span className="shrink-0 tabular text-xs text-muted-foreground">{formatTimestamp(a.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <FutureSection label="Emails" count={emailCount} />
            <FutureSection label="Notes" count={noteCount} />
            <FutureSection label="Tasks" count={0} />
          </div>
        </main>
      </div>
    </div>
  );
}
