import { Inbox, Star, Send, Mails, Trash2, Globe, Download, Bell, BellRing, Filter, AtSign, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useMe } from "@/lib/queries";
import { useInstallPrompt } from "@/lib/useInstallPrompt";
import { useNotifications } from "@/lib/useNotifications";
import ThemeToggle from "@/components/ThemeToggle";
import type { NavView, ViewCounts } from "@/lib/types";

const NAV: { id: NavView; label: string; icon: typeof Inbox }[] = [
  { id: "inbox",   label: "Inbox",    icon: Inbox },
  { id: "starred", label: "Starred",  icon: Star },
  { id: "drafts",  label: "Drafts",   icon: FileText },
  { id: "sent",    label: "Sent",     icon: Send },
  { id: "all",     label: "All Mail", icon: Mails },
  { id: "trash",   label: "Trash",    icon: Trash2 },
];

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
      <nav className="flex flex-1 flex-col gap-1 p-2">
        {NAV.map(({ id, label, icon: Icon }) => {
          const badge = navBadge(id, counts);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onView(id)}
              aria-current={view === id ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors md:min-h-0",
                view === id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="flex-1 text-left">{label}</span>
              {badge > 0 && (
                <Badge className="h-5 min-w-5 px-1.5 tabular-nums">{badge}</Badge>
              )}
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
                "flex min-h-11 items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors md:min-h-0",
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
                  "flex min-h-11 items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors md:min-h-0",
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

/** Desktop sidebar aside (md+). Hidden below `md` — the drawer replaces it. */
export default function Sidebar(props: SidebarProps) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r bg-muted/30 md:flex">
      <SidebarContent {...props} />
    </aside>
  );
}
