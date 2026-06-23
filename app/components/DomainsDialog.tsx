import { useEffect, useMemo, useState } from "react";
import {
  Globe,
  Search,
  ArrowLeft,
  Forward,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Inbox,
  Send,
  Lock,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  useDomains,
  useDomainDetail,
  useSetDomainCatchAll,
  useConnectReceiving,
  useConnectSending,
  useDomainRules,
  useAddDestination,
  useDomainSettings,
  useSetDomainSettings,
} from "@/lib/queries";
import {
  describeMatcher,
  describeAction,
  routingBadge,
  receivingState,
  sendingState,
} from "@/lib/domains";
import { cn } from "@/lib/utils";
import type { DomainSummary, DomainDetail, RuleActionKind } from "@/lib/types";

export interface DomainsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Section heading inside the detail pane. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
        {title}
      </p>
      {children}
    </div>
  );
}

/** A confirm-then-act button (AlertDialog) used for the live routing writes. */
function ConfirmButton({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive,
  disabled,
}: {
  trigger: React.ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild disabled={disabled}>
        {trigger}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * One-click onboarding cards: connect a domain's receiving (catch-all → this
 * Worker) and sending (Email Sending onboarding) with a single confirmed action
 * each. Receiving is locked for zones whose apex MX points at another provider.
 */
function ConnectCards({ detail, inboxWorker }: { detail: DomainDetail; inboxWorker?: string | null }) {
  const rec = receivingState(detail, inboxWorker ?? undefined);
  const snd = sendingState(detail);
  const connectReceiving = useConnectReceiving();
  const connectSending = useConnectSending();
  const routingActive = !!detail.routing?.enabled && detail.routing.status === "ready";

  const receiveDescription = routingActive
    ? `All mail to *@${detail.name} will land in this inbox. The current catch-all is replaced — reversible any time.`
    : `Email Routing will be turned on for ${detail.name} (Cloudflare adds its receiving MX + SPF records — this domain has no other mail provider), and all mail to *@${detail.name} will land in this inbox.`;

  const sendDescription =
    `${detail.name} will be onboarded for Email Sending. Cloudflare adds bounce/auth DNS records under cf-bounce.${detail.name} ` +
    `(a DMARC record is added only if the domain has none AND its mail isn't hosted elsewhere), ` +
    `and "anything@${detail.name}" appears in the compose From picker.`;

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {/* Receiving */}
      <div className="space-y-2 rounded-lg border px-3 py-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
          <Inbox className="h-3.5 w-3.5" /> Receiving
        </p>
        {rec.kind === "inbox" && (
          <p className="flex items-start gap-1.5 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
            <span>
              All <span className="font-medium">@{detail.name}</span> mail lands in this inbox.
            </span>
          </p>
        )}
        {rec.kind === "forward" && (
          <p className="text-sm text-muted-foreground">Forwarding all mail to {rec.to || "—"}.</p>
        )}
        {rec.kind === "drop" && <p className="text-sm text-muted-foreground">Mail is being dropped.</p>}
        {rec.kind === "off" && <p className="text-sm text-muted-foreground">Not receiving mail.</p>}
        {rec.kind === "external" && (
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Mail for {detail.name} is handled by another provider (its MX records point elsewhere).
              Receiving here is locked so that mail keeps working — sending can still be enabled.
            </span>
          </p>
        )}
        {rec.kind === "inbox" && <ForwardCopySetting detail={detail} />}
        {rec.kind !== "inbox" && rec.kind !== "external" && (
          <ConfirmButton
            disabled={connectReceiving.isPending}
            trigger={
              <Button size="sm" className="h-9 text-xs max-md:h-11">
                <Inbox className="h-3.5 w-3.5" /> Receive in this inbox
              </Button>
            }
            title={`Receive ${detail.name} mail here?`}
            description={receiveDescription}
            confirmLabel="Receive here"
            onConfirm={() =>
              connectReceiving.mutate(
                { zoneId: detail.zoneId, mode: "inbox" },
                {
                  onSuccess: () => toast.success(`@${detail.name} now delivers to this inbox`),
                  onError: (e) =>
                    toast.error(e instanceof Error ? e.message : "Couldn't connect receiving"),
                },
              )
            }
          />
        )}
      </div>

      {/* Sending */}
      <div className="space-y-2 rounded-lg border px-3 py-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
          <Send className="h-3.5 w-3.5" /> Sending
        </p>
        {snd.kind === "apex" && (
          <p className="flex items-start gap-1.5 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
            <span>
              Send as <span className="font-medium">anything@{detail.name}</span>.
            </span>
          </p>
        )}
        {snd.kind === "subdomain" && (
          <p className="text-sm text-muted-foreground">
            Sending via {snd.via} (recipients see that subdomain in From).
          </p>
        )}
        {snd.kind === "off" && <p className="text-sm text-muted-foreground">Sending not enabled.</p>}
        {snd.kind !== "off" && <SenderNameSetting detail={detail} />}
        {snd.kind !== "apex" && (
          <ConfirmButton
            disabled={connectSending.isPending}
            trigger={
              <Button size="sm" className="h-9 text-xs max-md:h-11">
                <Send className="h-3.5 w-3.5" />
                {snd.kind === "subdomain" ? `Upgrade to @${detail.name}` : "Enable sending"}
              </Button>
            }
            title={`Send as @${detail.name}?`}
            description={sendDescription}
            confirmLabel="Enable sending"
            onConfirm={() =>
              connectSending.mutate(
                { zoneId: detail.zoneId, variant: "apex" },
                {
                  onSuccess: (r) => {
                    const dnsNote = r.dns.errors.length
                      ? ` — ${r.dns.errors.length} DNS record(s) need attention`
                      : "";
                    toast.success(`Sending enabled for ${detail.name}${dnsNote}`);
                  },
                  onError: (e) =>
                    toast.error(e instanceof Error ? e.message : "Couldn't enable sending"),
                },
              )
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * Per-address forwarding rules editor: add a rule (local@domain → inbox /
 * verified destination / drop), toggle, delete. The address is always scoped
 * to this domain — only the local part is editable.
 */
function RulesEditor({ detail }: { detail: DomainDetail }) {
  const rules = useDomainRules();
  const verified = detail.destinations.filter((d) => d.verified);
  const [local, setLocal] = useState("");
  const [action, setAction] = useState<RuleActionKind>("inbox");
  const [dest, setDest] = useState("");
  const chosenDest = dest || verified[0]?.email || "";

  function add() {
    rules.create.mutate(
      {
        zoneId: detail.zoneId,
        local: local.trim().toLowerCase(),
        action,
        forwardTo: action === "forward" ? chosenDest : undefined,
      },
      {
        onSuccess: () => {
          setLocal("");
          toast.success("Rule added");
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add rule"),
      },
    );
  }

  return (
    <div className="space-y-2">
      {detail.rules.length ? (
        <ul className="space-y-2">
          {detail.rules.map((r) => (
            <li key={r.id} className="rounded-md border px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-medium">{r.name || "(unnamed rule)"}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={rules.toggle.isPending || !r.id}
                    onClick={() =>
                      rules.toggle.mutate(
                        { zoneId: detail.zoneId, ruleId: r.id, enabled: !r.enabled },
                        { onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't update rule") },
                      )
                    }
                  >
                    {r.enabled ? "On" : "Off"}
                  </Button>
                  <ConfirmButton
                    disabled={rules.remove.isPending || !r.id}
                    trigger={
                      <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive">
                        Delete
                      </Button>
                    }
                    title="Delete this rule?"
                    description={`Mail matched by "${r.name}" will fall through to the catch-all instead. This changes live routing.`}
                    confirmLabel="Delete rule"
                    destructive
                    onConfirm={() =>
                      rules.remove.mutate(
                        { zoneId: detail.zoneId, ruleId: r.id },
                        {
                          onSuccess: () => toast.success("Rule deleted"),
                          onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't delete rule"),
                        },
                      )
                    }
                  />
                </span>
              </div>
              <div className="mt-1 [overflow-wrap:anywhere] text-muted-foreground">
                {r.matchers.map(describeMatcher).join(", ") || "—"}
                <span className="px-1.5">→</span>
                {r.actions.map(describeAction).join("; ") || "—"}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No address rules yet.</p>
      )}

      {/* Add-rule form */}
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-2">
        <div className="flex min-w-0 items-baseline">
          <Input
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            placeholder="sales"
            aria-label="Rule address local part"
            className="h-9 w-28"
          />
          <span className="shrink-0 pl-1 text-xs text-muted-foreground">@{detail.name}</span>
        </div>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as RuleActionKind)}
          aria-label="Rule action"
          className="h-9 rounded border bg-background px-2 text-xs"
        >
          <option value="inbox">Deliver to this inbox</option>
          <option value="forward" disabled={!verified.length}>
            Forward to…
          </option>
          <option value="drop">Drop</option>
        </select>
        {action === "forward" && (
          <select
            value={chosenDest}
            onChange={(e) => setDest(e.target.value)}
            aria-label="Rule forward destination"
            className="h-9 min-w-0 rounded border bg-background px-2 text-xs"
          >
            {verified.map((d) => (
              <option key={d.email} value={d.email}>
                {d.email}
              </option>
            ))}
          </select>
        )}
        <Button
          type="button"
          size="sm"
          className="h-9 text-xs"
          disabled={rules.create.isPending || !local.trim() || (action === "forward" && !chosenDest)}
          onClick={add}
        >
          Add rule
        </Button>
      </div>
    </div>
  );
}

/** Add a new account-level forwarding destination (Cloudflare emails a verification link). */
function AddDestination({ zoneId }: { zoneId: string }) {
  const add = useAddDestination(zoneId);
  const [email, setEmail] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-2">
      <Input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        type="email"
        inputMode="email"
        aria-label="New destination address"
        className="h-9 w-56 max-w-full"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-9 text-xs"
        disabled={add.isPending || !email.includes("@")}
        onClick={() =>
          add.mutate(email.trim(), {
            onSuccess: () => {
              toast.success(`Verification email sent to ${email.trim()}`);
              setEmail("");
            },
            onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add destination"),
          })
        }
      >
        Add &amp; verify
      </Button>
      <span className="text-xs text-muted-foreground">New addresses must confirm a verification email.</span>
    </div>
  );
}

/**
 * Per-domain forward-copy setting: keep delivering a copy of inbound mail to a
 * real mailbox (default), a specific verified destination, or nowhere.
 */
function ForwardCopySetting({ detail }: { detail: DomainDetail }) {
  const settings = useDomainSettings(detail.zoneId);
  const save = useSetDomainSettings();
  const verified = detail.destinations.filter((d) => d.verified);
  if (!settings.data) return null;
  const { forwardCopyTo, forwardCopyDefault } = settings.data;
  const value = forwardCopyTo === null ? "__default" : forwardCopyTo === "" ? "__off" : forwardCopyTo;

  function onChange(next: string) {
    const forwardCopyTo = next === "__default" ? null : next === "__off" ? "" : next;
    save.mutate(
      { zoneId: detail.zoneId, patch: { forwardCopyTo } },
      {
        onSuccess: () => toast.success("Copy setting saved"),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save setting"),
      },
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="text-xs text-muted-foreground">Also copy inbound mail to:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={save.isPending}
        aria-label="Forward copy destination"
        className="h-8 min-w-0 rounded border bg-background px-2 text-xs"
      >
        <option value="__default">
          {forwardCopyDefault ? `Default (${forwardCopyDefault})` : "Default (off)"}
        </option>
        <option value="__off">No copy</option>
        {verified.map((d) => (
          <option key={d.email} value={d.email}>
            {d.email}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Sending profile: the From display name recipients see on mail sent as this
 * domain. Empty = the derived default ("Example" for example.com). Saved to the
 * domain registry; compose prefills it and allows a per-message override.
 */
function SenderNameSetting({ detail }: { detail: DomainDetail }) {
  const settings = useDomainSettings(detail.zoneId);
  const save = useSetDomainSettings();
  // null = untouched → mirror the saved value; a string = local edit in flight.
  const [draft, setDraft] = useState<string | null>(null);
  if (!settings.data) return null;
  const { displayName, displayNameDefault } = settings.data;
  const value = draft ?? displayName ?? "";
  const dirty = draft !== null && draft.trim() !== (displayName ?? "");

  function saveName() {
    const trimmed = (draft ?? "").trim();
    save.mutate(
      // "" clears the profile back to the derived default (stored as null).
      { zoneId: detail.zoneId, patch: { displayName: trimmed || null } },
      {
        onSuccess: () => {
          toast.success("Sender name saved");
          setDraft(null);
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save sender name"),
      },
    );
  }

  return (
    <div className="space-y-1 pt-1">
      <label htmlFor={`sender-name-${detail.zoneId}`} className="text-xs text-muted-foreground">
        From name on outgoing mail:
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`sender-name-${detail.zoneId}`}
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty && !save.isPending) {
              e.preventDefault();
              saveName();
            }
          }}
          placeholder={displayNameDefault}
          aria-label="Sender display name"
          className="h-8 w-44 max-w-full text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={save.isPending || !dirty}
          onClick={saveName}
        >
          Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {`Recipients see “${value.trim() || displayNameDefault} <hello@${detail.name}>”.`}
      </p>
    </div>
  );
}

/** Set the catch-all to forward to a verified destination, or to drop. */
function CatchAllEditor({ detail }: { detail: DomainDetail }) {
  const setCatchAll = useSetDomainCatchAll();
  const verified = detail.destinations.filter((d) => d.verified);
  const [target, setTarget] = useState("");
  // Default the select to the current forward target if there is one.
  const currentForward = detail.catchAll?.actions.find((a) => a.type === "forward")?.value?.[0] ?? "";
  const chosen = target || currentForward || verified[0]?.email || "";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border/70 px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground">Set catch-all:</span>
      {verified.length > 0 ? (
        <>
          <select
            value={chosen}
            onChange={(e) => setTarget(e.target.value)}
            aria-label="Forward destination"
            className="h-9 min-w-0 max-w-full rounded border bg-background px-2 text-xs"
          >
            {verified.map((d) => (
              <option key={d.email} value={d.email}>
                {d.email}
              </option>
            ))}
          </select>
          <ConfirmButton
            disabled={setCatchAll.isPending || !chosen}
            trigger={
              <Button size="sm" className="h-9 text-xs max-md:h-11">
                Forward
              </Button>
            }
            title={`Forward all mail for ${detail.name}?`}
            description={`Every address at ${detail.name} will be caught and forwarded to ${chosen}. This changes live routing.`}
            confirmLabel="Forward here"
            onConfirm={() =>
              setCatchAll.mutate(
                { zoneId: detail.zoneId, action: "forward", forwardTo: chosen },
                {
                  onSuccess: () => toast.success(`Catch-all → ${chosen}`),
                  onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't update catch-all"),
                },
              )
            }
          />
        </>
      ) : (
        <span className="text-xs text-muted-foreground">No verified destinations — add one in Cloudflare first.</span>
      )}
      <ConfirmButton
        disabled={setCatchAll.isPending}
        trigger={
          <Button size="sm" variant="outline" className="h-9 text-xs max-md:h-11">
            Drop
          </Button>
        }
        title={`Drop all mail for ${detail.name}?`}
        description={`The catch-all will DISCARD every message sent to ${detail.name} that no other rule matches. This changes live routing.`}
        confirmLabel="Drop mail"
        destructive
        onConfirm={() =>
          setCatchAll.mutate(
            { zoneId: detail.zoneId, action: "drop" },
            {
              onSuccess: () => toast.success(`Catch-all set to drop for ${detail.name}`),
              onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't update catch-all"),
            },
          )
        }
      />
    </div>
  );
}

/** The routing detail for one selected zone (with live edit controls). */
function DomainDetailPane({ zone, inboxWorker }: { zone: DomainSummary; inboxWorker?: string | null }) {
  const { data, isPending, isError, refetch, isFetching } = useDomainDetail(zone.zoneId, zone.name);
  const detail = data?.detail;

  if (isPending) {
    return <p className="p-6 text-sm text-muted-foreground">Loading {zone.name}…</p>;
  }
  if (isError || !detail) {
    return (
      <div className="space-y-3 p-6">
        <p className="text-sm text-muted-foreground">Couldn't load routing for {zone.name}.</p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4" /> Retry
        </Button>
      </div>
    );
  }

  const badge = routingBadge(detail.routing);

  return (
    <div className="space-y-6 p-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 truncate text-base font-semibold">
            <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
            {detail.name}
          </h3>
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      {/* One-click onboarding */}
      <Section title="This inbox">
        <ConnectCards key={`connect-${detail.zoneId}`} detail={detail} inboxWorker={inboxWorker} />
      </Section>

      {/* Catch-all */}
      <Section title="Catch-all">
        <CatchAllEditor key={detail.zoneId} detail={detail} />
        {detail.catchAll ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <Forward className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>
              {detail.catchAll.actions.length
                ? detail.catchAll.actions.map(describeAction).join("; ")
                : "No action"}
            </span>
            <Badge variant={detail.catchAll.enabled ? "secondary" : "outline"} className="ml-auto">
              {detail.catchAll.enabled ? "On" : "Off"}
            </Badge>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Not configured.</p>
        )}
      </Section>

      {/* Per-address rules (editable) */}
      <Section title={`Address rules (${detail.rules.length})`}>
        <RulesEditor key={`rules-${detail.zoneId}`} detail={detail} />
      </Section>

      {/* Verified destinations (account-wide) */}
      <Section title="Forwarding destinations">
        {detail.destinations.length ? (
          <ul className="space-y-1">
            {detail.destinations.map((d) => (
              <li key={d.email} className="flex items-center gap-2 text-sm">
                {d.verified ? (
                  <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500" />
                ) : (
                  <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
                )}
                <span className="min-w-0 truncate">{d.email}</span>
                {!d.verified && <span className="shrink-0 text-xs text-muted-foreground">(verification pending)</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None yet.</p>
        )}
        <AddDestination zoneId={detail.zoneId} />
      </Section>

      {/* MX records */}
      <Section title="MX records">
        {detail.mx.length ? (
          <ul className="space-y-1 font-mono text-xs">
            {detail.mx
              .slice()
              .sort((a, b) => a.priority - b.priority)
              .map((mx, i) => (
                <li key={`${mx.content}-${i}`} className="flex gap-2">
                  <span className="w-8 shrink-0 text-right text-muted-foreground">{mx.priority}</span>
                  <span className="min-w-0 truncate">{mx.content}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No MX records.</p>
        )}
      </Section>

      {isFetching && <p className="text-xs text-muted-foreground">Refreshing…</p>}
    </div>
  );
}

/**
 * Read-only "Domains" admin dashboard: lists the account's zones and, per zone,
 * shows Email Routing settings, forwarding rules, the catch-all, verified
 * destinations, and MX records. View-only by design — no mutations.
 */
export default function DomainsDialog({ open, onOpenChange }: DomainsDialogProps) {
  const { data, isPending, isError, refetch } = useDomains(open);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Reset transient state each time the dialog opens.
  useEffect(() => {
    if (open) {
      setFilter("");
      setSelectedId(null);
    }
  }, [open]);

  const domains = data?.domains ?? [];
  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? domains.filter((d) => d.name.toLowerCase().includes(f)) : domains;
  }, [domains, filter]);

  const selected = domains.find((d) => d.zoneId === selectedId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col gap-0 overflow-hidden p-0 max-md:h-[100dvh] max-md:max-h-[100dvh] max-md:max-w-full max-md:rounded-none sm:max-w-3xl lg:max-w-4xl">
        <DialogHeader className="space-y-1 border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" /> Domains
          </DialogTitle>
          <DialogDescription>
            Connect any of your {domains.length || ""} domains for receiving and sending, and manage forwarding.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Master list. On mobile it hides once a domain is selected. */}
          <div
            className={cn(
              "flex w-full min-w-0 flex-col border-r sm:w-64 sm:shrink-0",
              selected && "hidden sm:flex",
            )}
          >
            <div className="border-b p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter domains…"
                  aria-label="Filter domains"
                  className="h-9 pl-8"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {isPending && <p className="p-4 text-sm text-muted-foreground">Loading domains…</p>}
              {isError && (
                <div className="space-y-3 p-4">
                  <p className="text-sm text-muted-foreground">Couldn't load domains.</p>
                  <Button size="sm" variant="outline" onClick={() => refetch()}>
                    <RefreshCw className="h-4 w-4" /> Retry
                  </Button>
                </div>
              )}
              {!isPending && !isError && filtered.length === 0 && (
                <p className="p-4 text-sm text-muted-foreground">No matching domains.</p>
              )}
              <ul>
                {filtered.map((d) => (
                  <li key={d.zoneId}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(d.zoneId)}
                      aria-current={d.zoneId === selectedId ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50",
                        d.zoneId === selectedId && "bg-accent text-accent-foreground",
                      )}
                    >
                      <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{d.name}</span>
                      {d.paused && (
                        <Badge variant="outline" className="text-[0.7rem]">
                          paused
                        </Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Detail pane. */}
          <div className={cn("min-w-0 flex-1 overflow-y-auto", !selected && "hidden sm:block")}>
            {selected ? (
              <>
                {/* Mobile back-to-list bar. */}
                <div className="flex items-center gap-1 border-b px-2 py-2 sm:hidden">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="max-md:h-11"
                    onClick={() => setSelectedId(null)}
                    aria-label="Back to domains"
                  >
                    <ArrowLeft className="h-4 w-4" /> Domains
                  </Button>
                </div>
                <DomainDetailPane zone={selected} inboxWorker={data?.inboxWorker} />
              </>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                Select a domain to view its routing.
              </div>
            )}
          </div>
        </div>

        <Separator />
        <p className="px-5 py-2 text-xs text-muted-foreground">
          Changes apply to live Email Routing immediately. DNS records beyond email setup are managed in
          the Cloudflare dashboard.
        </p>
      </DialogContent>
    </Dialog>
  );
}
