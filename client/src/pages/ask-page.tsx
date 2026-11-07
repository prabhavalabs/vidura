import * as React from "react"
import {
  EllipsisIcon,
  HistoryIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { cn } from "cn"
import { useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import { LibraryChat } from "@/components/chat/library-chat"
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage } from "@/lib/api"
import { ago } from "@/lib/format"
import { useLocale } from "@/lib/i18n"
import { useChats, useDeleteChat, useRenameChat } from "@/lib/queries"
import type { Thread } from "@/lib/types"

/** Questions about the whole library, kept as separate chats. */
export function AskPage() {
  const { t } = useLocale()
  const { id } = useParams()
  const navigate = useNavigate()
  const [historyOpen, setHistoryOpen] = React.useState(false)

  // The page fills the window (see AppLayout); the chats list and the
  // conversation each scroll inside themselves.
  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <aside className="hidden w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-card lg:flex">
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b pr-2 pl-4">
          <h2 className="text-sm font-medium">{t.chat.history}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/ask")}
            disabled={!id}
          >
            <PlusIcon />
            {t.chat.newChat}
          </Button>
        </div>
        <History current={id} />
      </aside>
      <section className="mx-auto flex min-h-0 w-full max-w-3xl min-w-0 flex-1 flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
              {t.chat.askTitle}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t.chat.askSubtitle}
            </p>
          </div>
          <div className="flex shrink-0 gap-1 lg:hidden">
            <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="lg:hidden"
                  aria-label={t.chat.history}
                >
                  <HistoryIcon />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="gap-0">
                <SheetHeader>
                  <SheetTitle>{t.chat.history}</SheetTitle>
                </SheetHeader>
                <div className="flex min-h-0 flex-1 flex-col px-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
                  <History current={id} onPick={() => setHistoryOpen(false)} />
                </div>
              </SheetContent>
            </Sheet>
            <Button
              variant="outline"
              onClick={() => navigate("/ask")}
              disabled={!id}
              aria-label={t.chat.newChat}
            >
              <PlusIcon />
              <span className="hidden sm:inline">{t.chat.newChat}</span>
            </Button>
          </div>
        </div>
        <LibraryChat
          key={id ?? "new"}
          threadId={id}
          onThreadCreated={(thread) =>
            navigate(`/ask/${thread}`, { replace: true })
          }
        />
      </section>
    </div>
  )
}

function History({
  current,
  onPick,
}: {
  current?: string
  onPick?: () => void
}) {
  const { t, locale } = useLocale()
  const navigate = useNavigate()
  const chats = useChats()
  const [renaming, setRenaming] = React.useState<Thread | null>(null)
  const [deleting, setDeleting] = React.useState<Thread | null>(null)

  if (chats.isPending) {
    return (
      <div className="flex flex-col gap-2 p-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }
  const threads = chats.data ?? []
  return (
    <>
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]]:overscroll-contain">
        {threads.length === 0 ? (
          <Empty className="p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle className="text-sm">{t.chat.noChats}</EmptyTitle>
              <EmptyDescription>{t.chat.noChatsBody}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-0.5 p-2" role="list">
            {threads.map((thread) => (
              <li key={thread.id} className="group/thread relative">
                <Item
                  asChild
                  size="sm"
                  className={cn(
                    "cursor-pointer py-2 pr-11 hover:bg-muted",
                    thread.id === current && "bg-muted"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      navigate(`/ask/${thread.id}`)
                      onPick?.()
                    }}
                    aria-current={thread.id === current ? "page" : undefined}
                  >
                    <ItemMedia variant="icon" className="text-muted-foreground">
                      <MessageSquareIcon />
                    </ItemMedia>
                    <ItemContent className="min-w-0 gap-0.5">
                      <ItemTitle className="w-full">
                        <span className="truncate">
                          {thread.title || t.chat.newChat}
                        </span>
                      </ItemTitle>
                      <ItemDescription className="text-xs">
                        {ago(thread.updatedAt, locale)}
                      </ItemDescription>
                    </ItemContent>
                  </button>
                </Item>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      // Mice see it on hover; touch screens always see it.
                      className="absolute top-1/2 right-1.5 -translate-y-1/2 data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within/thread:opacity-100 [@media(hover:hover)]:group-hover/thread:opacity-100"
                      aria-label={t.actions.more}
                    >
                      <EllipsisIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setRenaming(thread)}>
                      <PencilIcon />
                      {t.chat.rename}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleting(thread)}
                    >
                      <Trash2Icon />
                      {t.chat.delete}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
      <RenameDialog thread={renaming} onClose={() => setRenaming(null)} />
      <DeleteDialog
        thread={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(id) => {
          if (id === current) navigate("/ask", { replace: true })
        }}
      />
    </>
  )
}

function RenameDialog({
  thread,
  onClose,
}: {
  thread: Thread | null
  onClose: () => void
}) {
  const { t } = useLocale()
  const rename = useRenameChat()
  const [title, setTitle] = React.useState("")
  const [seen, setSeen] = React.useState<string | null>(null)
  if (thread && thread.id !== seen) {
    setSeen(thread.id)
    setTitle(thread.title)
  }
  return (
    <Dialog open={Boolean(thread)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!thread || !title.trim()) return
            rename.mutate(
              { id: thread.id, title: title.trim() },
              {
                onSuccess: onClose,
                onError: (error) => toast.error(errorMessage(error)),
              }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>{t.chat.renameTitle}</DialogTitle>
          </DialogHeader>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={80}
            autoFocus
            aria-label={t.chat.renameTitle}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={!title.trim() || rename.isPending}>
              {t.chat.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DeleteDialog({
  thread,
  onClose,
  onDeleted,
}: {
  thread: Thread | null
  onClose: () => void
  onDeleted: (id: string) => void
}) {
  const { t } = useLocale()
  const remove = useDeleteChat()
  return (
    <AlertDialog
      open={Boolean(thread)}
      onOpenChange={(open) => !open && onClose()}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.chat.deleteTitle}</AlertDialogTitle>
          <AlertDialogDescription>{t.chat.deleteBody}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (!thread) return
              remove.mutate(thread.id, {
                onSuccess: () => {
                  onDeleted(thread.id)
                  onClose()
                },
                onError: (error) => toast.error(errorMessage(error)),
              })
            }}
          >
            {t.chat.delete}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
