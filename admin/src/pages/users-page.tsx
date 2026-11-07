import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import {
  BanIcon,
  CheckCircle2Icon,
  MailPlusIcon,
  MoreHorizontalIcon,
  ShieldCheckIcon,
  ShieldIcon,
  Trash2Icon,
  UserIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"
import { toast } from "sonner"

import {
  DataTable,
  facetFilter,
  SortableHeader,
  useTableUrl,
} from "@/components/data-table"
import { Page } from "@/components/site-header"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { errorMessage } from "@/lib/api"
import { formatDateTime, initials, timeAgo } from "@/lib/format"
import {
  useCreateInvite,
  useDeleteInvite,
  useDeleteUser,
  useInvites,
  useMe,
  useUpdateUser,
  useUsers,
} from "@/lib/queries"
import type { AdminUser, Invite } from "@/lib/types"

// --- confirmations ----------------------------------------------------------

type PendingAction =
  | { kind: "role"; user: AdminUser }
  | { kind: "status"; user: AdminUser }
  | { kind: "delete"; user: AdminUser }
  | { kind: "revoke"; invite: Invite }

function ConfirmDialog({
  pending,
  onClose,
}: {
  pending: PendingAction | null
  onClose: () => void
}) {
  const updateUser = useUpdateUser()
  const deleteUser = useDeleteUser()
  const deleteInvite = useDeleteInvite()
  const busy =
    updateUser.isPending || deleteUser.isPending || deleteInvite.isPending

  // Keep the last action so the dialog's content doesn't vanish while it
  // animates closed.
  const [shown, setShown] = React.useState<PendingAction | null>(pending)
  if (pending && pending !== shown) setShown(pending)
  const action = pending ?? shown
  if (!action) return null

  const copy = (() => {
    switch (action.kind) {
      case "role": {
        const promote = action.user.role === "member"
        return {
          title: promote
            ? `Make ${action.user.email} a superuser?`
            : `Make ${action.user.email} a member?`,
          description: promote
            ? "Superusers can use this admin portal: they can invite, change and delete other users and see the audit log."
            : "They’ll lose access to the admin portal but can keep using Vidura.",
          confirm: promote ? "Make superuser" : "Make member",
          destructive: false,
        }
      }
      case "status": {
        const disable = action.user.status === "active"
        return {
          title: disable
            ? `Disable ${action.user.email}?`
            : `Re-enable ${action.user.email}?`,
          description: disable
            ? "They’ll be signed out everywhere straight away and won’t be able to sign in again until you re-enable them. Their videos and notes are kept."
            : "They’ll be able to sign in with Google again.",
          confirm: disable ? "Disable account" : "Re-enable account",
          destructive: disable,
        }
      }
      case "delete":
        return {
          title: `Delete ${action.user.email}?`,
          description:
            "This permanently deletes the account and everything it owns, and removes their invite. It can’t be undone. To keep their data, disable the account instead.",
          confirm: "Delete account",
          destructive: true,
        }
      case "revoke":
        return {
          title: `Remove the invite for ${action.invite.email}?`,
          description: action.invite.accepted
            ? "They’ve already signed in, so this doesn’t remove their access. Disable or delete the user to do that."
            : "They won’t be able to sign in with this email.",
          confirm: "Remove invite",
          destructive: true,
        }
    }
  })()

  const run = () => {
    const done = {
      onSuccess: () => onClose(),
      onError: (error: unknown) => toast.error(errorMessage(error)),
    }
    switch (action.kind) {
      case "role":
        updateUser.mutate(
          {
            id: action.user.id,
            role: action.user.role === "member" ? "superuser" : "member",
          },
          {
            ...done,
            onSuccess: () => {
              toast.success("Role updated")
              onClose()
            },
          }
        )
        break
      case "status":
        updateUser.mutate(
          {
            id: action.user.id,
            status: action.user.status === "active" ? "disabled" : "active",
          },
          {
            ...done,
            onSuccess: () => {
              toast.success(
                action.user.status === "active"
                  ? "Account disabled"
                  : "Account re-enabled"
              )
              onClose()
            },
          }
        )
        break
      case "delete":
        deleteUser.mutate(action.user.id, {
          ...done,
          onSuccess: () => {
            toast.success("Account deleted")
            onClose()
          },
        })
        break
      case "revoke":
        deleteInvite.mutate(action.invite.email, {
          ...done,
          onSuccess: () => {
            toast.success("Invite removed")
            onClose()
          },
        })
        break
    }
  }

  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => !open && !busy && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={copy.destructive ? "destructive" : "default"}
            disabled={busy}
            onClick={(event) => {
              event.preventDefault() // stay open until the request finishes
              run()
            }}
          >
            {busy && <Spinner />}
            {copy.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// --- invite dialog ----------------------------------------------------------

function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const createInvite = useCreateInvite()
  const [email, setEmail] = React.useState("")

  const close = (next: boolean) => {
    if (!next) {
      setEmail("")
      createInvite.reset()
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            createInvite.mutate(email, {
              onSuccess: (data) => {
                toast.success(`Invited ${data.invite.email}`, {
                  description:
                    "They can now sign in to Vidura with that Google account.",
                })
                close(false)
              },
            })
          }}
          className="flex flex-col gap-6"
        >
          <DialogHeader>
            <DialogTitle>Invite a family member</DialogTitle>
            <DialogDescription>
              They’ll be able to sign in with the Google account for this email
              address. New accounts are members; you can make them a superuser
              afterwards.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={createInvite.isError || undefined}>
              <FieldLabel htmlFor="invite-email">
                Google email address
              </FieldLabel>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                placeholder="name@gmail.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                  if (createInvite.isError) createInvite.reset()
                }}
                aria-invalid={createInvite.isError || undefined}
                required
                autoFocus
              />
              {createInvite.isError ? (
                <FieldError>{errorMessage(createInvite.error)}</FieldError>
              ) : (
                <FieldDescription>
                  Use the exact address of their Google account.
                </FieldDescription>
              )}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createInvite.isPending || !email.trim()}
            >
              {createInvite.isPending ? <Spinner /> : <MailPlusIcon />}
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- tables -----------------------------------------------------------------

function RoleBadge({ user }: { user: AdminUser }) {
  return user.role === "superuser" ? (
    <Badge>
      <ShieldCheckIcon />
      Superuser
    </Badge>
  ) : (
    <Badge variant="secondary">
      <UserIcon />
      Member
    </Badge>
  )
}

function StatusBadge({ user }: { user: AdminUser }) {
  return user.status === "active" ? (
    <Badge variant="outline">
      <CheckCircle2Icon className="text-emerald-600 dark:text-emerald-400" />
      Active
    </Badge>
  ) : (
    <Badge variant="destructive">
      <BanIcon />
      Disabled
    </Badge>
  )
}

function UserActions({
  user,
  selfId,
  onAction,
}: {
  user: AdminUser
  selfId: string
  onAction: (action: PendingAction) => void
}) {
  const locked = user.owner || user.id === selfId
  const reason = user.owner
    ? "Owner accounts are set in the server configuration."
    : "You can’t change your own account."

  if (locked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled
              aria-label={`Actions for ${user.email}`}
            >
              <MoreHorizontalIcon />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${user.email}`}
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="truncate">{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => onAction({ kind: "role", user })}>
          {user.role === "member" ? <ShieldCheckIcon /> : <ShieldIcon />}
          {user.role === "member" ? "Make superuser" : "Make member"}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onAction({ kind: "status", user })}>
          {user.status === "active" ? <BanIcon /> : <CheckCircle2Icon />}
          {user.status === "active" ? "Disable account" : "Re-enable account"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => onAction({ kind: "delete", user })}
        >
          <Trash2Icon />
          Delete account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function useUserColumns(
  selfId: string,
  onAction: (action: PendingAction) => void
): ColumnDef<AdminUser>[] {
  return React.useMemo(
    () => [
      {
        id: "user",
        accessorFn: (user) => `${user.name} ${user.email}`,
        header: ({ column }) => <SortableHeader column={column} title="User" />,
        cell: ({ row }) => {
          const user = row.original
          return (
            <div className="flex min-w-0 items-center gap-3">
              <Avatar className="size-8">
                <AvatarImage
                  src={user.imageUrl || undefined}
                  alt=""
                  referrerPolicy="no-referrer"
                />
                <AvatarFallback>
                  {initials(user.name, user.email)}
                </AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <span className="flex items-center gap-2 truncate font-medium">
                  {user.name || user.email.split("@")[0]}
                  {user.owner && <Badge variant="outline">Owner</Badge>}
                  {user.id === selfId && <Badge variant="outline">You</Badge>}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {user.email}
                </span>
              </div>
            </div>
          )
        },
      },
      {
        accessorKey: "role",
        filterFn: facetFilter,
        header: ({ column }) => <SortableHeader column={column} title="Role" />,
        cell: ({ row }) => <RoleBadge user={row.original} />,
      },
      {
        accessorKey: "status",
        filterFn: facetFilter,
        header: ({ column }) => (
          <SortableHeader column={column} title="Status" />
        ),
        cell: ({ row }) => <StatusBadge user={row.original} />,
      },
      {
        accessorKey: "lastSeenAt",
        header: ({ column }) => (
          <SortableHeader column={column} title="Last seen" />
        ),
        sortingFn: "datetime",
        sortUndefined: "last",
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger className="text-sm text-muted-foreground">
              {timeAgo(row.original.lastSeenAt)}
            </TooltipTrigger>
            <TooltipContent>
              {formatDateTime(row.original.lastSeenAt)}
            </TooltipContent>
          </Tooltip>
        ),
      },
      {
        accessorKey: "activeSessions",
        header: ({ column }) => (
          <SortableHeader column={column} title="Sessions" />
        ),
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.activeSessions}</span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <SortableHeader column={column} title="Joined" />
        ),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatDateTime(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <UserActions
              user={row.original}
              selfId={selfId}
              onAction={onAction}
            />
          </div>
        ),
      },
    ],
    [selfId, onAction]
  )
}

function useInviteColumns(
  onAction: (action: PendingAction) => void
): ColumnDef<Invite>[] {
  return React.useMemo(
    () => [
      {
        accessorKey: "email",
        header: ({ column }) => (
          <SortableHeader column={column} title="Email" />
        ),
        cell: ({ row }) => (
          <span className="font-medium">{row.original.email}</span>
        ),
      },
      {
        id: "state",
        accessorFn: (invite) => (invite.accepted ? "joined" : "pending"),
        header: ({ column }) => (
          <SortableHeader column={column} title="Status" />
        ),
        cell: ({ row }) =>
          row.original.accepted ? (
            <Badge variant="outline">
              <CheckCircle2Icon className="text-emerald-600 dark:text-emerald-400" />
              Joined
            </Badge>
          ) : (
            <Badge variant="secondary">Pending</Badge>
          ),
      },
      {
        id: "invitedBy",
        accessorFn: (invite) => invite.invitedBy?.email ?? "",
        header: ({ column }) => (
          <SortableHeader column={column} title="Invited by" />
        ),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.invitedBy?.name ||
              row.original.invitedBy?.email ||
              "—"}
          </span>
        ),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <SortableHeader column={column} title="Invited" />
        ),
        cell: ({ row }) => (
          <Tooltip>
            <TooltipTrigger className="text-sm text-muted-foreground">
              {timeAgo(row.original.createdAt)}
            </TooltipTrigger>
            <TooltipContent>
              {formatDateTime(row.original.createdAt)}
            </TooltipContent>
          </Tooltip>
        ),
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onAction({ kind: "revoke", invite: row.original })}
            >
              <XIcon />
              Remove
            </Button>
          </div>
        ),
      },
    ],
    [onAction]
  )
}

// --- page -------------------------------------------------------------------

export function UsersPage() {
  const url = useTableUrl()
  const tab = url.get("tab") === "invites" ? "invites" : "users"
  const me = useMe()
  const users = useUsers()
  const invites = useInvites()
  const [inviteOpen, setInviteOpen] = React.useState(false)
  const [pending, setPending] = React.useState<PendingAction | null>(null)
  const onAction = React.useCallback(
    (action: PendingAction) => setPending(action),
    []
  )

  const userColumns = useUserColumns(me.data?.id ?? "", onAction)
  const inviteColumns = useInviteColumns(onAction)
  const pendingCount =
    invites.data?.filter((invite) => !invite.accepted).length ?? 0

  const inviteButton = (
    <Button onClick={() => setInviteOpen(true)}>
      <MailPlusIcon />
      Invite
    </Button>
  )

  return (
    <Page
      crumbs={[{ label: "Access" }, { label: "Users" }]}
      title="Users"
      description="Everyone who can sign in to Vidura. Invite family members by their Google email address."
      actions={inviteButton}
    >
      <Tabs
        value={tab}
        onValueChange={(value) =>
          url.update({ tab: value === "users" ? null : value })
        }
        className="gap-3"
      >
        <TabsList>
          <TabsTrigger value="users">
            <UsersIcon />
            Users
            {users.data && (
              <Badge variant="secondary">{users.data.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="invites">
            <MailPlusIcon />
            Invites
            {pendingCount > 0 && (
              <Badge variant="secondary">{pendingCount} pending</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="users">
          {users.isError ? (
            <LoadError
              message={errorMessage(users.error)}
              retry={() => users.refetch()}
            />
          ) : (
            <DataTable
              columns={userColumns}
              data={users.data ?? []}
              loading={users.isPending}
              urlPrefix="u."
              getRowId={(user) => user.id}
              facets={[
                {
                  column: "role",
                  title: "Role",
                  options: [
                    { value: "superuser", label: "Superuser" },
                    { value: "member", label: "Member" },
                  ],
                },
                {
                  column: "status",
                  title: "Status",
                  options: [
                    { value: "active", label: "Active" },
                    { value: "disabled", label: "Disabled" },
                  ],
                },
              ]}
              searchPlaceholder="Search name or email…"
              empty={
                <NoRows
                  title="No users yet"
                  description="Invite someone to get started."
                  action={inviteButton}
                />
              }
            />
          )}
        </TabsContent>

        <TabsContent value="invites">
          {invites.isError ? (
            <LoadError
              message={errorMessage(invites.error)}
              retry={() => invites.refetch()}
            />
          ) : (
            <DataTable
              columns={inviteColumns}
              data={invites.data ?? []}
              loading={invites.isPending}
              urlPrefix="i."
              searchPlaceholder="Search invites…"
              empty={
                <NoRows
                  title="No invites"
                  description="Invited emails appear here until you remove them."
                  action={inviteButton}
                />
              }
            />
          )}
        </TabsContent>
      </Tabs>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <ConfirmDialog pending={pending} onClose={() => setPending(null)} />
    </Page>
  )
}

function NoRows({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action: React.ReactNode
}) {
  return (
    <Empty className="border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <UsersIcon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{action}</EmptyContent>
    </Empty>
  )
}

function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>Couldn’t load this list</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={retry}>
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  )
}
