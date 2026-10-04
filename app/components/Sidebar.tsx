import { Inbox, Star, Send, Mails, Trash2, Globe, Download, Bell, BellRing, Filter, AtSign, FileText, OctagonAlert, AlarmClock, Settings, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useMe } from "@/lib/queries";
import { useInstallPrompt } from "@/lib/useInstallPrompt";
import { useNotifications } from "@/lib/useNotifications";
import { useIsDesktop, useIsWide } from "@/lib/useMediaQuery";
import ThemeToggle from "@/components/ThemeToggle";
import type { NavView, ViewCounts } from "@/lib/types";

const NAV: { id: NavView; label: string; icon: typeof Inbox }[] = [
  { id: "inbox",   label: "Inbox",    icon: Inbox },
  { id: "starred", label: "Starred",  icon: Star },
  { id: "snoozed", label: "Snoozed",  icon: AlarmClock },
  { id: "drafts",  label: "Drafts",   icon: FileText },
  { id: "sent",    label: "Sent",     icon: Send },
  { id: "all",     label: "All Mail", icon: Mails },
  { id: "spam",    label: "Junk",     icon: OctagonAlert },
  { id: "trash",   label: "Trash",    icon: Trash2 },
];

/**
 * The one view whose count is a filled badge: the Inbox, where the number is
 * unread mail. A badge reads as "needs your attention"; everywhere else the
 * number is only how much is there, and is shown as a plain figure.
 */
const BADGED = new Set<NavView>(["inbox"]);

export interface SidebarProps {
  view: NavView;
  onView: (view: NavView) => void;
  /** Per-view counts for badges. */
  counts: ViewCounts;
  /** Active identity-domain filter (null = all inboxes). */
  domainFilter?: string | null;
  /** Pick a domain to filter the views by (null = all inboxes). */
  onDomainFilter?: (domain: string | null) => void;
  /** Open the read-only Domains (Email Routing) admin dashboard. */
  onOpenDomains?: () => void;
  /** Open the inbox rules manager. */
  onOpenFilters?: () => void;
  /** Open the per-browser settings (undo send, email links). */
  onOpenSettings?: () => void;
  /** Open the full menu as a drawer (the rail's first button). */
  onOpenMenu?: () => void;
}

/**
 * Returns the badge number to display for a given nav item.
 * Inbox shows unread count; others show thread count. 0 = no badge.
 */
function navBadge(id: NavView, counts: ViewCounts): number {
  if (id === "inbox") return counts.inboxUnread;
  if (id === "drafts") return counts.drafts ?? 0;
  if (id === "starred") return counts.starred;
  if (id === "sent") return counts.sent;
  if (id === "all") return counts.all;
  if (id === "trash") return counts.trash;
  if (id === "spam") return counts.spam ?? 0;
  if (id === "snoozed") return counts.snoozed ?? 0;
  return 0;
}

/**
 * The view nav + theme toggle + signed-in email. Shared by the desktop
 * `<Sidebar/>` aside and the mobile drawer (Sheet) so there's a single source of
 * truth for both layouts. `showBrand` adds the wordmark header (desktop only —
 * the Sheet provides its own title). Touch targets are bumped to ≥44px below
 * `md` for comfortable tapping.
 */
export function SidebarContent({
  view,
  onView,
  counts,
  domainFilter,
  onDomainFilter,
  onOpenDomains,
  onOpenFilters,
  onOpenSettings,
  showBrand = true,
}: SidebarProps & { showBrand?: boolean }) {
  const me = useMe();
  const email =
    me.data?.email && me.data.email.includes("@") ? me.data.email : null;
  const { canInstall, promptInstall } = useInstallPrompt();
  const notifications = useNotifications();

  return (
    <div className="flex h-full flex-col">
      {showBrand && (
        <>
          <div className="flex h-14 items-center gap-2 px-4 text-lg font-semibold">
            <span aria-hidden>📨</span>
            <span>Mailcove</span>
          </div>
          <Separator />
        </>
      )}
      {/* min-h-0 + its own scroll: on a short screen (a phone's drawer, with
          several inboxes listed) the views scroll and the buttons under them
          stay on screen. Without it they were pushed off the bottom, out of
          reach. */}
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {NAV.map(({ id, label, icon: Icon }) => {
          const badge = navBadge(id, counts);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onView(id)}
              aria-current={view === id ? "page" : undefined}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors md:min-h-0",
                view === id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">{label}</span>
              {badge > 0 &&
                (!BADGED.has(id) ? (
                  <span className="px-1 text-xs tabular-nums text-muted-foreground">{badge}</span>
                ) : (
                  <Badge className="h-5 min-w-5 px-1.5 tabular-nums">{badge}</Badge>
                ))}
            </button>
          );
        })}
        {view === "trash" && (
          <p className="px-3 pt-1 text-xs text-muted-foreground">
            Auto-deletes after 30 days
          </p>
        )}

        {/* Per-domain inbox switcher — only once more than one domain delivers here. */}
        {onDomainFilter && (counts.domains?.length ?? 0) > 1 && (
          <>
            <p className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
              Inboxes
            </p>
            <button
              type="button"
              onClick={() => onDomainFilter(null)}
              aria-current={domainFilter == null ? "true" : undefined}
              className={cn(
                "flex min-h-11 shrink-0 items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors md:min-h-0",
                domainFilter == null
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Mails className="h-4 w-4" />
              <span className="flex-1 truncate text-left">All inboxes</span>
            </button>
            {counts.domains!.map((d) => (
              <button
                key={d.domain}
                type="button"
                onClick={() => onDomainFilter(d.domain)}
                aria-current={domainFilter === d.domain ? "true" : undefined}
                className={cn(
                  "flex min-h-11 shrink-0 items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors md:min-h-0",
                  domainFilter === d.domain
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <AtSign className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate text-left">{d.domain}</span>
                {d.unread > 0 && (
                  <Badge className="h-5 min-w-5 px-1.5 tabular-nums">{d.unread}</Badge>
                )}
              </button>
            ))}
          </>
        )}
      </nav>
      <Separator />
      <div className="flex flex-col gap-1 p-2">
        {canInstall && (
          <button
            type="button"
            onClick={() => void promptInstall()}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground md:min-h-0"
          >
            <Download className="h-4 w-4" />
            <span className="flex-1 text-left">Install app</span>
          </button>
        )}
        {notifications.available && (
          <button
            type="button"
            onClick={() => void notifications.toggle()}
            disabled={notifications.busy}
            aria-pressed={notifications.enabled}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50 md:min-h-0"
          >
            {notifications.enabled ? (
              <BellRing className="h-4 w-4 text-primary" />
            ) : (
              <Bell className="h-4 w-4" />
            )}
            <span className="flex-1 text-left">
              {notifications.enabled ? "Notifications on" : "Notifications"}
            </span>
          </button>
        )}
        {onOpenFilters && (
          <button
            type="button"
            onClick={onOpenFilters}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground md:min-h-0"
          >
            <Filter className="h-4 w-4" />
            <span className="flex-1 text-left">Rules</span>
          </button>
        )}
        {onOpenDomains && (
          <button
            type="button"
            onClick={onOpenDomains}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground md:min-h-0"
          >
            <Globe className="h-4 w-4" />
            <span className="flex-1 text-left">Domains</span>
          </button>
        )}
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground md:min-h-0"
          >
            <Settings className="h-4 w-4" />
            <span className="flex-1 text-left">Settings</span>
          </button>
        )}
        <ThemeToggle />
        {email && (
          <div
            className="truncate px-2 pt-1 text-xs text-muted-foreground"
            title={email}
          >
            {email}
          </div>
        )}
      </div>
    </div>
  );
}

/** One icon button of the rail: 44px, named and titled by what it opens. */
const RAIL_BUTTON =
  "relative flex size-11 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * The sidebar as a column of icons, for widths where the full one would
 * squeeze the message out (see useIsWide). Views and the dialogs only; the
 * first button opens the drawer, which has everything the full sidebar has
 * (the per-domain inboxes, notifications, the signed-in address).
 */
function SidebarRail({ view, onView, counts, domainFilter, onOpenDomains, onOpenFilters, onOpenSettings, onOpenMenu }: SidebarProps) {
  const idle = "text-muted-foreground hover:bg-accent/50 hover:text-foreground";
  return (
    <div className="flex h-full flex-col items-center">
      <div className="flex h-14 items-center">
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="Open menu"
          title={domainFilter ? `Menu (showing ${domainFilter})` : "Menu"}
          className={cn(RAIL_BUTTON, idle)}
        >
          <Menu className="h-5 w-5" />
          {/* A domain filter is on and its switcher is not on screen: say so. */}
          {domainFilter && <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-primary" />}
        </button>
      </div>
      <Separator />
      <nav aria-label="Folders" className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
        {NAV.map(({ id, label, icon: Icon }) => {
          const badge = BADGED.has(id) ? navBadge(id, counts) : 0;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onView(id)}
              aria-current={view === id ? "page" : undefined}
              aria-label={badge > 0 ? `${label}, ${badge} unread` : label}
              title={label}
              className={cn(RAIL_BUTTON, "shrink-0", view === id ? "bg-accent text-accent-foreground" : idle)}
            >
              <Icon className="h-4 w-4" />
              {badge > 0 && (
                <Badge aria-hidden className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 text-[0.625rem] tabular-nums">
                  {badge > 99 ? "99+" : badge}
                </Badge>
              )}
            </button>
          );
        })}
      </nav>
      <Separator />
      <div className="flex flex-col items-center gap-1 py-2">
        {onOpenFilters && (
          <button type="button" onClick={onOpenFilters} aria-label="Rules" title="Rules" className={cn(RAIL_BUTTON, idle)}>
            <Filter className="h-4 w-4" />
          </button>
        )}
        {onOpenDomains && (
          <button type="button" onClick={onOpenDomains} aria-label="Domains" title="Domains" className={cn(RAIL_BUTTON, idle)}>
            <Globe className="h-4 w-4" />
          </button>
        )}
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} aria-label="Settings" title="Settings" className={cn(RAIL_BUTTON, idle)}>
            <Settings className="h-4 w-4" />
          </button>
        )}
        <ThemeToggle compact />
      </div>
    </div>
  );
}

/**
 * Desktop sidebar aside (md+). Hidden below `md`, where the drawer replaces
 * it. From `md` up to useIsWide it is the icon rail.
 */
export default function Sidebar(props: SidebarProps) {
  const rail = useIsDesktop() && !useIsWide();
  return (
    <aside data-print-hide className={cn("hidden shrink-0 flex-col border-r bg-muted/30 md:flex", rail ? "w-14" : "w-56")}>
      {rail ? <SidebarRail {...props} /> : <SidebarContent {...props} />}
    </aside>
  );
}
