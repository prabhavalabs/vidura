import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClientProvider } from "@tanstack/react-query"
import { createBrowserRouter, RouterProvider } from "react-router"

import "./index.css"
import { AdminLayout } from "@/components/admin-layout"
import { RouteError } from "@/components/route-error"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { queryClient } from "@/lib/queries"
import { LoginPage } from "@/pages/login-page"
import { NotFoundPage } from "@/pages/not-found-page"

// Pages load on first visit, so the charts library only downloads when a
// page with charts opens.
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
    element: <AdminLayout />,
    errorElement: <RouteError />,
    children: [
      {
        index: true,
        lazy: page(() => import("@/pages/dashboard-page"), "DashboardPage"),
      },
      {
        path: "videos",
        lazy: page(() => import("@/pages/videos-page"), "VideosPage"),
      },
      {
        path: "videos/:id",
        lazy: page(() => import("@/pages/video-page"), "VideoPage"),
      },
      {
        path: "processing",
        lazy: page(() => import("@/pages/processing-page"), "ProcessingPage"),
      },
      {
        path: "users",
        lazy: page(() => import("@/pages/users-page"), "UsersPage"),
      },
      {
        path: "audit",
        lazy: page(() => import("@/pages/audit-page"), "AuditPage"),
      },
      {
        path: "settings",
        lazy: page(() => import("@/pages/settings-page"), "SettingsPage"),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
])

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster richColors position="top-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
