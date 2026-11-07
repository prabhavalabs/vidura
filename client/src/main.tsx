import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createBrowserRouter, RouterProvider } from "react-router"

import "./index.css"
import { AppLayout } from "@/components/app-layout"
import { RouteError } from "@/components/route-error"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LocaleProvider } from "@/lib/i18n"
import {
  registerServiceWorker,
  syncThemeColor,
  watchInstallPrompt,
} from "@/lib/pwa"
import { queryClient } from "@/lib/queries"
import { LibraryPage } from "@/pages/library-page"
import { LoginPage } from "@/pages/login-page"
import { NotFoundPage } from "@/pages/not-found-page"

// The watch and settings pages load on first visit.
const page =
  <K extends string>(
    load: () => Promise<Record<K, React.ComponentType>>,
    name: K
  ) =>
  async () => ({ Component: (await load())[name] })

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage />, errorElement: <RouteError /> },
  {
    path: "/",
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <LibraryPage /> },
      // v1's addresses, so old links and home-screen shortcuts still work.
      { path: "library", element: <LibraryPage /> },
      {
        path: "watch/:id",
        lazy: page(() => import("@/pages/watch-page"), "WatchPage"),
      },
      {
        path: "ask",
        lazy: page(() => import("@/pages/ask-page"), "AskPage"),
      },
      {
        path: "ask/:id",
        lazy: page(() => import("@/pages/ask-page"), "AskPage"),
      },
      // v1's chat addresses.
      {
        path: "chats/*",
        lazy: page(() => import("@/pages/ask-page"), "AskPage"),
      },
      {
        path: "settings",
        lazy: page(() => import("@/pages/settings-page"), "SettingsPage"),
      },
      // The installed app's "Add video" shortcut, and where links shared to
      // Vidura from another app land (manifest share_target).
      {
        path: "add",
        lazy: page(() => import("@/pages/add-page"), "AddPage"),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
])

watchInstallPrompt()
syncThemeColor()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system">
      <LocaleProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <RouterProvider router={router} />
            <Toaster richColors position="top-center" />
          </TooltipProvider>
        </QueryClientProvider>
      </LocaleProvider>
    </ThemeProvider>
  </StrictMode>
)

// The service worker gives the installed app its offline shell, update
// prompt and notifications. It also takes over from v1's worker on this
// address, which cached the old site.
registerServiceWorker()
