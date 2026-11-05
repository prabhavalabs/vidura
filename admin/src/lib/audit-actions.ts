type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

const actions: Record<string, { label: string; variant: BadgeVariant }> = {
  "auth.signin": { label: "Signed in", variant: "secondary" },
  "auth.signin_refused": { label: "Sign-in refused", variant: "destructive" },
  "auth.signout": { label: "Signed out", variant: "outline" },
  "user.updated": { label: "User changed", variant: "default" },
  "user.deleted": { label: "User deleted", variant: "destructive" },
  "invite.created": { label: "Invited", variant: "default" },
  "invite.deleted": { label: "Invite removed", variant: "outline" },
}

export const auditActionOptions = Object.entries(actions).map(
  ([value, { label }]) => ({ value, label })
)

export function describeAction(action: string): {
  label: string
  variant: BadgeVariant
} {
  return actions[action] ?? { label: action, variant: "outline" }
}
