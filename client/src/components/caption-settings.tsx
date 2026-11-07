import { RotateCcwIcon } from "lucide-react"
import { cn } from "cn"

import { Caption } from "@/components/caption"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useT } from "@/lib/i18n"
import {
  captionFonts,
  resetPrefs,
  setPrefs,
  usePrefs,
  type CaptionFont,
  type CaptionLanguage,
  type CaptionOutline,
  type CaptionPlacement,
} from "@/lib/prefs"

const textColors = ["#ffffff", "#fde047", "#67e8f9", "#86efac", "#f9a8d4"]
const backgroundColors = ["#000000", "#1f2937", "#1e3a8a", "#ffffff"]

/** Caption preferences with a live preview, saved in this browser. */
export function CaptionSettings({ preview = true }: { preview?: boolean }) {
  const t = useT()
  const prefs = usePrefs()
  const off = !prefs.captions

  return (
    <FieldGroup>
      {preview && (
        <div
          className="relative flex aspect-[21/9] items-end justify-center overflow-hidden rounded-lg bg-gradient-to-br from-slate-500 via-slate-700 to-slate-900 p-3"
          aria-label={t.captions.preview}
        >
          {prefs.captions && (
            <div
              className="absolute inset-x-0 flex justify-center px-3"
              style={{
                bottom:
                  prefs.placement === "overlay" ? `${prefs.position}%` : "6%",
              }}
            >
              <Caption
                sinhala={t.captions.previewSi}
                english={t.captions.previewEn}
                prefs={{ ...prefs, size: Math.min(prefs.size, 28) }}
              />
            </div>
          )}
        </div>
      )}

      <Field orientation="horizontal">
        <FieldLabel htmlFor="captions-on" className="flex-1">
          {t.captions.show}
        </FieldLabel>
        <Switch
          id="captions-on"
          checked={prefs.captions}
          onCheckedChange={(captions) => setPrefs({ captions })}
        />
      </Field>

      <Field>
        <FieldLabel>{t.captions.language}</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          value={prefs.language}
          onValueChange={(value) =>
            value && setPrefs({ language: value as CaptionLanguage })
          }
          disabled={off}
        >
          <ToggleGroupItem value="si" className="flex-1">
            {t.captions.sinhala}
          </ToggleGroupItem>
          <ToggleGroupItem value="both" className="flex-1">
            {t.captions.both}
          </ToggleGroupItem>
          <ToggleGroupItem value="en" className="flex-1">
            {t.captions.english}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <Field>
        <FieldLabel>{t.captions.placement}</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          value={prefs.placement}
          onValueChange={(value) =>
            value && setPrefs({ placement: value as CaptionPlacement })
          }
          disabled={off}
        >
          <ToggleGroupItem value="overlay" className="flex-1">
            {t.captions.overlay}
          </ToggleGroupItem>
          <ToggleGroupItem value="below" className="flex-1">
            {t.captions.below}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      {prefs.placement === "overlay" && (
        <Field>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor="caption-position">
              {t.captions.position}
            </FieldLabel>
            <span className="text-sm text-muted-foreground tabular-nums">
              {prefs.position}%
            </span>
          </div>
          <Slider
            id="caption-position"
            min={0}
            max={85}
            step={1}
            value={[prefs.position]}
            onValueChange={([position]) => setPrefs({ position })}
            disabled={off}
          />
        </Field>
      )}

      <Field>
        <FieldLabel htmlFor="caption-font">{t.captions.font}</FieldLabel>
        <Select
          value={prefs.font}
          onValueChange={(value) => setPrefs({ font: value as CaptionFont })}
          disabled={off}
        >
          <SelectTrigger id="caption-font" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(captionFonts).map(([key, font]) => (
              <SelectItem key={key} value={key}>
                <span style={{ fontFamily: font.family }}>
                  {font.label} · සිංහල
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor="caption-size">{t.captions.size}</FieldLabel>
          <span className="text-sm text-muted-foreground tabular-nums">
            {prefs.size}px
          </span>
        </div>
        <Slider
          id="caption-size"
          min={14}
          max={48}
          step={1}
          value={[prefs.size]}
          onValueChange={([size]) => setPrefs({ size })}
          disabled={off}
        />
      </Field>

      <ColorField
        label={t.captions.color}
        value={prefs.color}
        swatches={textColors}
        onChange={(color) => setPrefs({ color })}
        disabled={off}
      />

      <Field>
        <FieldLabel>{t.captions.outline}</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          value={prefs.outline}
          onValueChange={(value) =>
            value && setPrefs({ outline: value as CaptionOutline })
          }
          disabled={off}
        >
          <ToggleGroupItem value="none" className="flex-1">
            {t.captions.outlineNone}
          </ToggleGroupItem>
          <ToggleGroupItem value="shadow" className="flex-1">
            {t.captions.outlineShadow}
          </ToggleGroupItem>
          <ToggleGroupItem value="stroke" className="flex-1">
            {t.captions.outlineStroke}
          </ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <ColorField
        label={t.captions.backgroundColor}
        value={prefs.backgroundColor}
        swatches={backgroundColors}
        onChange={(backgroundColor) => setPrefs({ backgroundColor })}
        disabled={off}
      />

      <Field>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor="caption-background">
            {t.captions.background}
          </FieldLabel>
          <span className="text-sm text-muted-foreground tabular-nums">
            {prefs.background}%
          </span>
        </div>
        <Slider
          id="caption-background"
          min={0}
          max={100}
          step={5}
          value={[prefs.background]}
          onValueChange={([background]) => setPrefs({ background })}
          disabled={off}
        />
      </Field>

      <Button variant="outline" onClick={resetPrefs} className="self-start">
        <RotateCcwIcon />
        {t.captions.reset}
      </Button>
    </FieldGroup>
  )
}

function ColorField({
  label,
  value,
  swatches,
  onChange,
  disabled,
}: {
  label: string
  value: string
  swatches: string[]
  onChange: (color: string) => void
  disabled?: boolean
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          value={swatches.includes(value) ? value : ""}
          onValueChange={(color) => color && onChange(color)}
          disabled={disabled}
          aria-label={label}
        >
          {swatches.map((color) => (
            <ToggleGroupItem
              key={color}
              value={color}
              aria-label={color}
              className="px-2.5"
            >
              <span
                className="size-4 rounded-full border border-black/20"
                style={{ backgroundColor: color }}
              />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          aria-label={label}
          className={cn(
            "h-9 w-12 cursor-pointer p-1",
            !swatches.includes(value) && "ring-2 ring-ring"
          )}
        />
      </div>
    </Field>
  )
}
