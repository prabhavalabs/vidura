type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

const actions: Record<string, { label: string; variant: BadgeVariant }> = {
  "auth.signin": { label: "Signed in", variant: "secondary" },
  "auth.signin_refused": { label: "Sign-in refused", variant: "destructive" },
  "auth.password_set": { label: "Password set", variant: "secondary" },
  "auth.signout": { label: "Signed out", variant: "outline" },
  "user.updated": { label: "User changed", variant: "default" },
  "user.deleted": { label: "User deleted", variant: "destructive" },
  "invite.created": { label: "Invited", variant: "default" },
  "invite.deleted": { label: "Invite removed", variant: "outline" },
  "ai.connect_started": {
    label: "ChatGPT sign-in started",
    variant: "outline",
  },
  "ai.connected": { label: "ChatGPT connected", variant: "default" },
  "ai.connect_failed": {
    label: "ChatGPT sign-in failed",
    variant: "destructive",
  },
  "ai.disconnected": { label: "ChatGPT disconnected", variant: "outline" },
  "device.pairing_code": { label: "Pairing code created", variant: "outline" },
  "device.paired": { label: "Mac paired", variant: "default" },
  "device.pair_refused": { label: "Pairing refused", variant: "destructive" },
  "device.revoked": { label: "Mac revoked", variant: "destructive" },
  "settings.updated": { label: "Settings changed", variant: "secondary" },
  "device.engine_install": {
    label: "Model download started",
    variant: "outline",
  },
  "video.added": { label: "Video added", variant: "secondary" },
  "video.deleted": { label: "Video deleted", variant: "destructive" },
  "job.requested": { label: "Run requested", variant: "secondary" },
  "job.cancelled": { label: "Run cancelled", variant: "outline" },
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
