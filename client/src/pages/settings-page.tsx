import { LogOutIcon } from "lucide-react"

import { CaptionSettings } from "@/components/caption-settings"
import { InstallCard } from "@/components/install-app"
import { NotificationsCard } from "@/components/notification-settings"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldLabel } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLocale, type Locale } from "@/lib/i18n"
import { useMe, useSetLocale, useSignOut } from "@/lib/queries"

export function SettingsPage() {
  const { t, locale, setLocale } = useLocale()
  const me = useMe()
  const signOut = useSignOut()
  const saveLocale = useSetLocale()
  const { theme, setTheme } = useTheme()

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        {t.settings.title}
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.language}</CardTitle>
          <CardDescription>{t.settings.languageHint}</CardDescription>
        </CardHeader>
        <CardContent>
          <ToggleGroup
            type="single"
            variant="outline"
            value={locale}
            onValueChange={(value) => {
              if (!value) return
              setLocale(value as Locale)
              saveLocale.mutate(value as Locale)
            }}
            className="w-full"
          >
            <ToggleGroupItem value="en" className="flex-1">
              English
            </ToggleGroupItem>
            <ToggleGroupItem value="si" className="flex-1">
              සිංහල
            </ToggleGroupItem>
          </ToggleGroup>
        </CardContent>
      </Card>

      <NotificationsCard />
      <InstallCard />

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.subtitles}</CardTitle>
          <CardDescription>{t.settings.subtitlesHint}</CardDescription>
        </CardHeader>
        <CardContent>
          <CaptionSettings />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.appearance}</CardTitle>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel>{t.settings.theme}</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={theme}
              onValueChange={(value) =>
                value && setTheme(value as "light" | "dark" | "system")
              }
            >
              <ToggleGroupItem value="light" className="flex-1">
                {t.settings.light}
              </ToggleGroupItem>
              <ToggleGroupItem value="dark" className="flex-1">
                {t.settings.dark}
              </ToggleGroupItem>
              <ToggleGroupItem value="system" className="flex-1">
                {t.settings.system}
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.settings.account}</CardTitle>
          <CardDescription>
            {t.settings.signedInAs(me.data?.email ?? "")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            <LogOutIcon />
            {t.common.signOut}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
