import * as React from "react"
import { ClipboardPasteIcon, LinkIcon, PlusIcon } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Field, FieldError } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/api"
import { useT } from "@/lib/i18n"
import { useAddVideo } from "@/lib/queries"

/** Paste a YouTube link; the video opens while it's being processed. */
export function AddVideoForm() {
  const t = useT()
  const navigate = useNavigate()
  const add = useAddVideo()
  const [url, setUrl] = React.useState("")
  const canPaste = typeof navigator.clipboard?.readText === "function"

  function submit(link: string) {
    if (!link.trim()) return
    add.mutate(link, {
      onSuccess: (result) => {
        setUrl("")
        if (!result.created) toast(t.add.already)
        navigate(`/watch/${result.video.id}`)
      },
    })
  }

  async function paste() {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (text) {
        setUrl(text)
        submit(text)
      }
    } catch {
      toast(t.add.clipboard)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit(url)
      }}
    >
      <Field data-invalid={add.isError || undefined}>
        <div className="flex gap-2">
          <InputGroup className="h-10">
            <InputGroupAddon>
              <LinkIcon />
            </InputGroupAddon>
            <InputGroupInput
              type="url"
              inputMode="url"
              placeholder={t.add.placeholder}
              aria-label={t.add.label}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value)
                if (add.isError) add.reset()
              }}
              aria-invalid={add.isError || undefined}
              autoComplete="off"
              enterKeyHint="go"
            />
            {canPaste && !url && (
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="sm" onClick={paste}>
                  <ClipboardPasteIcon />
                  {t.add.paste}
                </InputGroupButton>
              </InputGroupAddon>
            )}
          </InputGroup>
          <Button
            type="submit"
            className="h-10"
            disabled={!url.trim() || add.isPending}
          >
            {add.isPending ? <Spinner /> : <PlusIcon />}
            <span className="hidden sm:inline">{t.add.add}</span>
            <span className="sm:hidden">{t.add.addShort}</span>
          </Button>
        </div>
        {add.isError && <FieldError>{errorMessage(add.error)}</FieldError>}
      </Field>
    </form>
  )
}
