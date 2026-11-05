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
import { AuditPage } from "@/pages/audit-page"
import { DashboardPage } from "@/pages/dashboard-page"
import { LoginPage } from "@/pages/login-page"
import { NotFoundPage } from "@/pages/not-found-page"
import { UsersPage } from "@/pages/users-page"

const router = createBrowserRouter(
  [
    { path: "/login", element: <LoginPage />, errorElement: <RouteError /> },
    {
      path: "/",
      element: <AdminLayout />,
      errorElement: <RouteError />,
      children: [
        { index: true, element: <DashboardPage /> },
        { path: "users", element: <UsersPage /> },
        { path: "audit", element: <AuditPage /> },
        { path: "*", element: <NotFoundPage /> },
      ],
    },
  ],
  { basename: "/admin" }
)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster richColors position="top-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
