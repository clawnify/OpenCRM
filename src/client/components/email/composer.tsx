import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { MailPlus, Maximize2, Minimize2, Minus, SendHorizontal, Trash2, X } from "lucide-react";
import { useCrm } from "@/context";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/shared";
import { cn } from "@/lib/utils";
import type { Contact, EmailAddress } from "@/types";

/**
 * One email being written: a new one, a reply inside a synced thread, or a
 * forward of a synced email. `ref` names the email a reply or forward is about.
 */
export interface Draft {
  mode: "new" | "reply" | "forward";
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  body: string;
  ref?: { mailbox: string; id: string };
  /** One line saying what a reply or forward is about ("Replying to Ada, 3 Oct"). */
  about?: string;
}

type Size = "docked" | "minimized" | "expanded";

const ComposerContext = createContext<{ compose: (draft?: Partial<Draft>) => void; avoid: (el: HTMLElement | null) => void } | null>(null);

/** Open the composer: compose() for a blank email, or with recipients, a reply or a forward. */
export function useComposer() {
  const ctx = useContext(ComposerContext);
  if (!ctx) throw new Error("useComposer must be used inside <ComposerProvider>");
  return { compose: ctx.compose };
}

/** A ref for a side panel the docked composer must not cover: it docks to the panel's left instead. */
export function useComposerAvoid() {
  return useContext(ComposerContext)?.avoid ?? (() => {});
}

const GAP = 12;
const MIN_DOCK = 420;

/**
 * How far from the window's right edge the docked composer sits: just left of
 * the panel it avoids, when there is room for it there (and the panel sits
 * beside the page, md and up), else the usual 12px.
 */
function useDockRight(el: HTMLElement | null): number | undefined {
  const [right, setRight] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!el) return setRight(undefined);
    const measure = () => {
      const left = el.getBoundingClientRect().left;
      const wide = window.matchMedia("(min-width: 768px)").matches;
      setRight(wide && left - GAP >= MIN_DOCK ? window.innerWidth - left + GAP : undefined);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [el]);
  return right;
}

let drafts = 0;
const blank = (d: Partial<Draft> = {}): Draft & { key: number } => ({ mode: "new", to: [], cc: [], bcc: [], subject: "", body: "", ...d, key: ++drafts });
const dirty = (d: Draft) => !!d.body.trim() || (d.mode === "new" && !!d.subject.trim());

/**
 * The composer lives above every page, docked bottom-right like Gmail's, so a
 * draft survives moving around the CRM. One draft at a time: starting another
 * while this one has text asks before discarding it.
 */
export function ComposerProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<(Draft & { key: number }) | null>(null);
  const [next, setNext] = useState<(Draft & { key: number }) | null>(null);
  const [size, setSize] = useState<Size>("docked");
  const [avoiding, setAvoiding] = useState<HTMLElement | null>(null);
  const right = useDockRight(avoiding);

  const compose = useCallback((d?: Partial<Draft>) => {
    const fresh = blank(d);
    setSize((s) => (s === "minimized" ? "docked" : s));
    setDraft((cur) => {
      if (cur && dirty(cur)) {
        setNext(fresh);
        return cur;
      }
      return fresh;
    });
  }, []);

  return (
    <ComposerContext.Provider value={{ compose, avoid: setAvoiding }}>
      {children}
      {draft && (
        <ComposerWindow
          key={draft.key}
          draft={draft}
          onChange={(d) => setDraft({ ...d, key: draft.key })}
          size={size}
          onSize={setSize}
          right={right}
          next={next}
          onNext={(take) => {
            if (take && next) setDraft(next);
            setNext(null);
          }}
          onDone={() => {
            setDraft(null);
            setNext(null);
            setSize("docked");
          }}
        />
      )}
    </ComposerContext.Provider>
  );
}

function ComposerWindow({ draft, onChange, size, onSize, right, next, onNext, onDone }: {
  draft: Draft;
  onChange: (d: Draft) => void;
  size: Size;
  onSize: (s: Size) => void;
  right: number | undefined;
  next: Draft | null;
  onNext: (take: boolean) => void;
  onDone: () => void;
}) {
  const { connections, recordsChanged } = useCrm();
  const [showCopies, setShowCopies] = useState(draft.cc.length > 0 || draft.bcc.length > 0);
  const [confirmClose, setConfirmClose] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const set = (patch: Partial<Draft>) => {
    setError(null);
    onChange({ ...draft, ...patch });
  };
  const title = draft.mode === "reply" ? "Reply" : draft.mode === "forward" ? "Forward" : "New email";

  // A reply or forward already knows who it's about, so the cursor starts in the text.
  useEffect(() => {
    if (draft.mode !== "new" && size !== "minimized") bodyRef.current?.focus();
  }, [draft.mode, draft.ref?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => (dirty(draft) ? setConfirmClose(true) : onDone());

  const send = async () => {
    if (sending) return;
    // Text left in a recipient field that isn't an address would otherwise be dropped silently.
    const bad = formRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]');
    if (bad) {
      bad.focus();
      return setError(`"${bad.value.trim()}" isn't an email address.`);
    }
    if (!draft.to.length) return setError("Add at least one recipient.");
    setSending(true);
    setError(null);
    try {
      await api("POST", "/api/integrations/email", {
        to: draft.to.map((r) => r.email),
        cc: draft.cc.map((r) => r.email),
        bcc: draft.bcc.map((r) => r.email),
        subject: draft.subject,
        body: draft.body,
        ...(draft.mode === "reply" ? { reply_to: draft.ref } : draft.mode === "forward" ? { forward: draft.ref } : {}),
      });
      onDone();
      void recordsChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send this email");
    } finally {
      setSending(false);
    }
  };

  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => onSize(size === "minimized" ? "docked" : "minimized")}>
        <MailPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-sm font-medium">{size === "minimized" && draft.subject ? draft.subject : title}</span>
      </button>
      <Button type="button" variant="ghost" size="icon" aria-label={size === "minimized" ? "Restore" : "Minimize"} title={size === "minimized" ? "Restore" : "Minimize"}
        onClick={() => onSize(size === "minimized" ? "docked" : "minimized")}>
        <Minus />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={size === "expanded" ? "Dock" : "Expand"} title={size === "expanded" ? "Dock" : "Expand"}
        onClick={() => onSize(size === "expanded" ? "docked" : "expanded")}>
        {size === "expanded" ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Close" title="Close" onClick={close}>
        <X />
      </Button>
    </div>
  );

  // The footer asks before a draft with text is thrown away: on close, on the
  // bin, and when another email is started on top of it.
  const asking = next ? "Discard this draft and start the new email?" : confirmClose ? "Discard this draft?" : null;
  const footer = asking ? (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-2.5" role="alert">
      <span className="mr-auto text-sm">{asking}</span>
      <Button type="button" variant="outline" onClick={() => (next ? onNext(false) : setConfirmClose(false))}>Keep editing</Button>
      <Button type="button" variant="destructive" onClick={() => (next ? onNext(true) : onDone())}>Discard</Button>
    </div>
  ) : (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-3 py-2.5">
      {error && <span className="mr-auto min-w-0 truncate text-sm text-destructive" title={error}>{error}</span>}
      <Button type="button" variant="ghost" size="icon" aria-label="Discard draft" title="Discard draft" onClick={close}>
        <Trash2 />
      </Button>
      <Button type="submit" disabled={sending} title="Send (⌘↵)">
        <SendHorizontal /> {sending ? "Sending…" : "Send"}
      </Button>
    </div>
  );

  return (
    <>
      {size === "expanded" && <div className="fixed inset-0 z-40 hidden bg-black/20 sm:block" onClick={() => onSize("docked")} aria-hidden />}
      <section
        role="dialog"
        aria-label={title}
        style={right !== undefined && size !== "expanded" ? { right, maxWidth: `calc(100vw - ${right + GAP}px)` } : undefined}
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-[var(--shadow-popover)]",
          size === "minimized"
            ? "bottom-3 right-3 w-72"
            : "inset-x-0 bottom-0 top-12 rounded-b-none sm:inset-x-auto sm:top-auto sm:rounded-b-xl",
          size === "docked" && "sm:bottom-3 sm:right-3 sm:h-[min(34rem,calc(100vh-1.5rem))] sm:w-[36rem]",
          size === "expanded" && "sm:inset-0 sm:m-auto sm:h-[min(46rem,calc(100vh-4rem))] sm:w-[min(60rem,calc(100vw-4rem))]",
        )}
      >
        {header}
        {/* Minimized hides the form rather than unmounting it, so half-typed fields survive. */}
        <form
          ref={formRef}
          className={cn("flex min-h-0 flex-1 flex-col", size === "minimized" && "hidden")}
          onSubmit={(e) => { e.preventDefault(); void send(); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
        >
          <div className="flex shrink-0 flex-col px-4 py-1.5 text-sm">
            <Row label="From">
              <span className={cn("truncate", !connections.mailbox && "text-muted-foreground")}>{connections.mailbox || "Your connected Gmail"}</span>
            </Row>
            <RecipientField label="To" value={draft.to} onChange={(to) => set({ to })} autoFocus={draft.mode !== "reply"}
              trailing={!showCopies && (
                <button type="button" className="shrink-0 text-[0.8125rem] text-muted-foreground hover:text-foreground" onClick={() => setShowCopies(true)}>Cc / Bcc</button>
              )} />
            {showCopies && <RecipientField label="Cc" value={draft.cc} onChange={(cc) => set({ cc })} />}
            {showCopies && <RecipientField label="Bcc" value={draft.bcc} onChange={(bcc) => set({ bcc })} />}
            <Row label="Subject" htmlFor="compose-subject">
              {draft.mode === "new" ? (
                <input id="compose-subject" value={draft.subject} onChange={(e) => set({ subject: e.target.value })}
                  className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" placeholder="Subject" />
              ) : (
                <span className="truncate">{draft.subject}</span>
              )}
            </Row>
          </div>
          {draft.about && <p className="shrink-0 px-4 pb-1 text-[0.8125rem] text-muted-foreground">{draft.about}</p>}
          <textarea
            ref={bodyRef}
            aria-label={draft.mode === "forward" ? "Note" : "Message"}
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
            placeholder={draft.mode === "forward" ? "Add a note above the forwarded email (optional)" : "Write your message…"}
            className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-sm leading-6 outline-none placeholder:text-faint"
          />
          {footer}
        </form>
      </section>
    </>
  );
}

function Row({ label, htmlFor, children, trailing }: { label: string; htmlFor?: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 py-0.5">
      <label htmlFor={htmlFor} className="w-14 shrink-0 text-muted-foreground">{label}</label>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      {trailing}
    </div>
  );
}

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

const nameParts = (r: EmailAddress) => {
  const [first = "", ...rest] = (r.name || r.email).split(" ");
  return { first, last: rest.join(" ") };
};

/**
 * Who an email goes to, as chips. Typing searches contacts by name or address;
 * Enter, comma or Tab (or leaving the field) adds what was typed when it's an
 * address. Backspace on an empty field takes the last chip off.
 */
function RecipientField({ label, value, onChange, autoFocus, trailing }: {
  label: string;
  value: EmailAddress[];
  onChange: (v: EmailAddress[]) => void;
  autoFocus?: boolean;
  trailing?: ReactNode;
}) {
  const id = `compose-${label.toLowerCase()}`;
  const [text, setText] = useState("");
  const [matches, setMatches] = useState<EmailAddress[]>([]);
  const [active, setActive] = useState(0);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) return setMatches([]);
    const t = setTimeout(() => {
      api<{ contacts: Contact[] }>("GET", `/api/contacts?limit=6&search=${encodeURIComponent(q)}`)
        .then((r) => {
          const taken = new Set(value.map((v) => v.email));
          setMatches(r.contacts
            .filter((c) => c.email && !taken.has(c.email.toLowerCase()))
            .map((c) => ({ email: c.email.toLowerCase(), name: `${c.first_name} ${c.last_name}`.trim() || null })));
          setActive(0);
        }, () => setMatches([]));
    }, 150);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (r: EmailAddress) => {
    if (!value.some((v) => v.email === r.email)) onChange([...value, r]);
    setText("");
    setMatches([]);
    setInvalid(false);
  };

  /** Add what's typed as an address. False when it isn't one. */
  const commit = () => {
    const raw = text.trim().replace(/[,;]$/, "").toLowerCase();
    if (!raw) return true;
    if (!EMAIL_RE.test(raw)) {
      setInvalid(true);
      return false;
    }
    add({ email: raw, name: null });
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
    } else if (e.key === "Enter" || e.key === "," || e.key === ";" || (e.key === "Tab" && text.trim())) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) return; // ⌘↵ sends
      if (!text.trim()) return;
      e.preventDefault();
      if (matches.length && e.key !== "," && e.key !== ";") add(matches[active]);
      else commit();
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape" && matches.length) {
      e.stopPropagation();
      setMatches([]);
    }
  };

  return (
    <Row label={label} htmlFor={id} trailing={trailing}>
      <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1">
        {value.map((r) => {
          const { first, last } = nameParts(r);
          return (
            <span key={r.email} title={r.email} className="inline-flex max-w-full items-center gap-1.5 rounded-sm bg-secondary py-0.5 pl-1 pr-0.5">
              <Avatar firstName={first} lastName={last} className="size-5 text-[0.5625rem]" />
              <span className="truncate">{r.name || r.email}</span>
              <button type="button" aria-label={`Remove ${r.name || r.email}`} onClick={() => onChange(value.filter((v) => v.email !== r.email))}
                className="rounded-xs p-0.5 text-muted-foreground hover:bg-border/60 hover:text-foreground">
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          id={id}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => { setText(e.target.value); setInvalid(false); }}
          onKeyDown={onKeyDown}
          onBlur={() => { setTimeout(() => setMatches([]), 120); commit(); }}
          aria-invalid={invalid || undefined}
          aria-autocomplete="list"
          aria-controls={matches.length ? `${id}-list` : undefined}
          aria-activedescendant={matches.length ? `${id}-opt-${active}` : undefined}
          className={cn("h-7 min-w-24 flex-1 bg-transparent outline-none", invalid && "text-destructive")}
        />
        {matches.length > 0 && (
          <ul id={`${id}-list`} role="listbox" className="absolute left-0 top-full z-10 mt-1 w-72 rounded-lg border border-border bg-popover p-1 shadow-[var(--shadow-popover)]">
            {matches.map((m, i) => {
              const { first, last } = nameParts(m);
              return (
                <li key={m.email} id={`${id}-opt-${i}`} role="option" aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); add(m); }}
                  onMouseEnter={() => setActive(i)}
                  className={cn("flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5", i === active && "bg-secondary")}>
                  <Avatar firstName={first} lastName={last} className="size-6 text-[0.5625rem]" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{m.name || m.email}</span>
                    {m.name && <span className="truncate text-xs text-muted-foreground">{m.email}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Row>
  );
}
