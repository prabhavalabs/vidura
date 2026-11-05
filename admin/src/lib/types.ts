export type Role = "superuser" | "member"
export type UserStatus = "active" | "disabled"

export type User = {
  id: string
  email: string
  name: string
  imageUrl: string
  role: Role
  status: UserStatus
  /** Configured in VIDURA_SUPERUSER_EMAILS; can't be changed from the portal. */
  owner: boolean
  createdAt: string
  lastSeenAt: string | null
}

export type AdminUser = User & { activeSessions: number }

export type Invite = {
  email: string
  createdAt: string
  invitedBy: { id: string; email: string; name: string } | null
  accepted: boolean
}

export type AuditEntry = {
  id: string
  at: string
  actorId: string
  actorEmail: string
  action: string
  target: string
  detail: Record<string, unknown> | null
  ip: string
}

export type AuditPage = { entries: AuditEntry[]; nextCursor: string | null }

export type Overview = {
  accounts: {
    users: number
    active: number
    disabled: number
    superusers: number
    pendingInvites: number
    activeSessions: number
  }
  server: {
    version: string
    env: string
    startedAt: string
    uptimeSec: number
  }
}
