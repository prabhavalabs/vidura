import * as React from "react"
import {
  HomeIcon,
  LanguagesIcon,
  LogOutIcon,
  MessageCircleQuestionIcon,
  SettingsIcon,
  WifiOffIcon,
  type LucideIcon,
} from "lucide-react"
import { cn } from "cn"
import {
  Link,
  matchPath,
  Navigate,
  NavLink,
  Outlet,
  useLocation,
} from "react-router"

import { NotificationBell } from "@/components/notification-bell"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { ApiError } from "@/lib/api"
import { initials } from "@/lib/format"
import { useLocale, useT, type Locale, type Messages } from "@/lib/i18n"
import { useMe, useSetLocale, useSignOut } from "@/lib/queries"

type NavItem = {
  to: string
  label: (t: Messages) => string
  icon: LucideIcon
  end?: boolean
}

// Pages that fill the window and scroll inside their own panels (the player
// and transcript, a chat) instead of scrolling the whole page.
const fillRoutes = ["/watch/:id", "/ask", "/ask/:id", "/chats/*"]

const navItems: NavItem[] = [
  { to: "/", label: (t) => t.nav.videos, icon: HomeIcon, end: true },
  { to: "/ask", label: (t) => t.nav.ask, icon: MessageCircleQuestionIcon },
  { to: "/settings", label: (t) => t.nav.settings, icon: SettingsIcon },
]

/** Signed-in family members get the portal; everyone else signs in. */
export function AppLayout() {
  const t = useT()
  const me = useMe()
  const location = useLocation()
  const { locale, setLocale } = useLocale()

  // Once signed in, the account's language wins over this browser's.
  const serverLocale = me.data?.locale
  React.useEffect(() => {
    if (serverLocale && serverLocale !== locale) setLocale(serverLocale)
    // Only when the account's language arrives or changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverLocale])

  if (me.isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Spinner className="size-6" />
      </div>
    )
  }

  if (me.error instanceof ApiError && me.error.status === 401) {
    const next = `${location.pathname}${location.search}`
    const to =
      next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`
    return <Navigate to={to} replace />
  }

  if (me.isError || !me.data) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <WifiOffIcon />
            </EmptyMedia>
            <EmptyTitle>{t.offline.title}</EmptyTitle>
            <EmptyDescription>{t.offline.body}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => me.refetch()}>{t.common.tryAgain}</Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  const fill = fillRoutes.some((pattern) =>
    matchPath(pattern, location.pathname)
  )

  return (
    <div
      className={cn(
        "flex flex-col",
        fill ? "h-dvh overflow-hidden" : "min-h-dvh"
      )}
    >
      <header className="sticky top-0 z-40 shrink-0 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur supports-backdrop-filter:bg-background/70">
        <div className="mx-auto flex h-14 w-full max-w-[90rem] items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/vidura-icon.svg" alt="" className="size-7 rounded-md" />
            Vidura
          </Link>
          <nav className="hidden flex-1 items-center gap-1 sm:flex">
            {navItems.map((item) => (
              <Button key={item.to} variant="ghost" size="sm" asChild>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className="aria-[current=page]:bg-muted"
                >
                  {item.label(t)}
                </NavLink>
              </Button>
            ))}
          </nav>
          <div className="flex-1 sm:hidden" />
          <NotificationBell />
          <LanguageMenu />
          <AccountMenu />
        </div>
      </header>
      <main
        className={cn(
          "mx-auto w-full max-w-[90rem] flex-1 px-4 sm:px-6",
          fill
            ? // The page gets exactly the space between the header and the
              // tab bar (phones) or the window's bottom edge.
              "flex min-h-0 flex-col pt-4 pb-[calc(4.75rem+env(safe-area-inset-bottom))] sm:py-5"
            : "pt-5 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:pt-6 sm:pb-10"
        )}
      >
        <Outlet />
      </main>
      <BottomNav />
    </div>
  )
}

/** The tab bar on phones. */
function BottomNav() {
  const t = useT()
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-backdrop-filter:bg-background/80 sm:hidden"
      aria-label="Vidura"
    >
      <ul className="mx-auto flex max-w-md">
        {navItems.map((item) => (
          <li key={item.to} className="flex-1">
            <NavLink
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-[color,transform] duration-150 active:scale-95",
                  isActive && "text-foreground"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      "flex h-7 w-14 items-center justify-center rounded-full transition-colors",
                      isActive && "bg-muted"
                    )}
                  >
                    <item.icon className="size-5" />
                  </span>
                  {item.label(t)}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function LanguageMenu() {
  const t = useT()
  const { locale, setLocale } = useLocale()
  const save = useSetLocale()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t.settings.language}>
          <LanguagesIcon />
          <span className="text-xs font-semibold uppercase">
            {locale === "si" ? "සිං" : "EN"}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel>{t.settings.language}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(value) => {
            setLocale(value as Locale)
            save.mutate(value as Locale)
          }}
        >
          <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="si">සිංහල</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AccountMenu() {
  const t = useT()
  const me = useMe()
  const signOut = useSignOut()
  const user = me.data
  if (!user) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t.nav.account}
        >
          <Avatar className="size-8">
            {user.imageUrl && <AvatarImage src={user.imageUrl} alt="" />}
            <AvatarFallback>{initials(user.name, user.email)}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="flex flex-col">
          <span className="truncate">{user.name || user.email}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">
            {user.email}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <SettingsIcon />
            {t.nav.settings}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => signOut.mutate()}>
          <LogOutIcon />
          {t.common.signOut}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
