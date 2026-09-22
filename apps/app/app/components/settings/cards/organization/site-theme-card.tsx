import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	CUSTOM_SITE_FONT_ID,
	SITE_BASE_COLORS,
	SITE_FONT_IDS,
	SITE_FONTS,
	SITE_THEME_COLORS,
	SITE_THEME_MODES,
	SITE_THEME_RADII,
	SITE_THEME_RADIUS_VALUES,
	getBaseColorMeta,
	getSiteFont,
	getThemeColorMeta,
	resolveSiteThemePresetTokens,
	siteFontDisplayName,
	siteFontFormatFromExtension,
	type SiteFontSelection,
	type SiteThemeConfig,
	type SiteThemeMode,
	type SiteThemeRadius,
} from '@repo/common/site-theme'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@repo/ui/tooltip'
import { type ChangeEvent, useRef, useState } from 'react'
import { z } from 'zod'

export const SiteThemeSchema = z.object({
	baseColor: z.enum(SITE_BASE_COLORS),
	theme: z.enum(SITE_THEME_COLORS),
	radius: z.enum(SITE_THEME_RADII),
	mode: z.enum(SITE_THEME_MODES),
	headingFont: z.union([z.enum(SITE_FONT_IDS), z.literal(CUSTOM_SITE_FONT_ID)]),
	bodyFont: z.union([z.enum(SITE_FONT_IDS), z.literal(CUSTOM_SITE_FONT_ID)]),
	cssVars: z
		.preprocess((value) => {
			if (value == null || value === '') return undefined
			if (typeof value !== 'string') return value
			try {
				const parsed = JSON.parse(value) as unknown
				return parsed && typeof parsed === 'object' ? parsed : undefined
			} catch {
				return value
			}
		}, z.record(z.string()).nullable().optional())
		.optional(),
	organizationId: z.string(),
})

export const siteThemeActionIntent = 'update-site-theme'
export const uploadSiteFontActionIntent = 'upload-site-font'
export const deleteSiteFontActionIntent = 'delete-site-font'

const MAX_FONT_SIZE = 1024 * 1024 * 2
const FONT_ACCEPT = '.woff2,.woff,.ttf,.otf'

const ACCENT_NEUTRALS = SITE_THEME_COLORS.filter((c) =>
	(SITE_BASE_COLORS as readonly string[]).includes(c),
)
const ACCENT_COLORS = SITE_THEME_COLORS.filter(
	(c) => !(SITE_BASE_COLORS as readonly string[]).includes(c),
)

const ignoredShadcnTokens = [
	'background',
	'foreground',
	'card',
	'card-foreground',
	'popover',
	'popover-foreground',
	'primary',
	'primary-foreground',
	'secondary',
	'secondary-foreground',
	'muted',
	'muted-foreground',
	'accent',
	'accent-foreground',
	'destructive',
	'destructive-foreground',
	'border',
	'input',
	'ring',
] as const satisfies ReadonlyArray<string>

function FieldLabel({ children }: { children: React.ReactNode }) {
	return <p className="text-muted-foreground text-xs font-medium">{children}</p>
}

function ColorSwatch({
	label,
	swatch,
	selected,
	disabled,
	onSelect,
}: {
	label: string
	swatch: string
	selected: boolean
	disabled?: boolean
	onSelect: () => void
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						disabled={disabled}
						onClick={onSelect}
						aria-label={label}
						aria-pressed={selected}
						className={cn(
							'size-6 rounded-full transition-[box-shadow,transform] duration-150 ease-out',
							'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
							'disabled:pointer-events-none disabled:opacity-50',
							selected
								? 'ring-foreground ring-offset-background scale-105 ring-2 ring-offset-2'
								: 'hover:ring-foreground/30 hover:ring-offset-background hover:ring-2 hover:ring-offset-2',
						)}
						style={{ backgroundColor: swatch }}
					/>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	)
}

function RadiusGlyph({
	radius,
	selected,
}: {
	radius: SiteThemeRadius
	selected: boolean
}) {
	const value = SITE_THEME_RADIUS_VALUES[radius]
	return (
		<span
			className={cn(
				'relative size-7 overflow-hidden border',
				selected
					? 'border-foreground/25 bg-muted/40'
					: 'border-border bg-muted/20',
			)}
			style={{ borderRadius: value || '0' }}
			aria-hidden
		>
			<span
				className={cn(
					'absolute inset-1.5 border-t-2 border-l-2',
					selected ? 'border-primary' : 'border-muted-foreground/50',
				)}
				style={{
					borderTopLeftRadius: value || '0',
					borderTopRightRadius: 0,
					borderBottomLeftRadius: 0,
					borderBottomRightRadius: 0,
				}}
			/>
		</span>
	)
}

function FontSelect({
	id,
	value,
	customLabel,
	disabled,
	onChange,
}: {
	id: string
	value: SiteFontSelection
	customLabel?: string | null
	disabled?: boolean
	onChange: (next: SiteFontSelection) => void
}) {
	const selected =
		value === CUSTOM_SITE_FONT_ID
			? {
					family: customLabel || 'Custom',
					fallback: 'sans-serif' as const,
				}
			: getSiteFont(value)
	const sansFonts = SITE_FONTS.filter((font) => font.fallback === 'sans-serif')
	const serifFonts = SITE_FONTS.filter((font) => font.fallback === 'serif')
	const monoFonts = SITE_FONTS.filter((font) => font.fallback === 'monospace')

	return (
		<Select
			value={value}
			onValueChange={(next) => {
				if (next) onChange(next as SiteFontSelection)
			}}
			disabled={disabled}
		>
			<SelectTrigger id={id} className="w-full">
				<SelectValue>
					<span
						style={{ fontFamily: `"${selected.family}", ${selected.fallback}` }}
					>
						{selected.family}
					</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="start" alignItemWithTrigger={false}>
				{customLabel ? (
					<SelectGroup>
						<SelectLabel>
							<Trans>Uploaded</Trans>
						</SelectLabel>
						<SelectItem value={CUSTOM_SITE_FONT_ID}>{customLabel}</SelectItem>
					</SelectGroup>
				) : null}
				<SelectGroup>
					<SelectLabel>
						<Trans>Sans</Trans>
					</SelectLabel>
					{sansFonts.map((font) => (
						<SelectItem key={font.id} value={font.id}>
							<span
								style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
							>
								{font.family}
							</span>
						</SelectItem>
					))}
				</SelectGroup>
				<SelectGroup>
					<SelectLabel>
						<Trans>Serif</Trans>
					</SelectLabel>
					{serifFonts.map((font) => (
						<SelectItem key={font.id} value={font.id}>
							<span
								style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
							>
								{font.family}
							</span>
						</SelectItem>
					))}
				</SelectGroup>
				<SelectGroup>
					<SelectLabel>
						<Trans>Mono</Trans>
					</SelectLabel>
					{monoFonts.map((font) => (
						<SelectItem key={font.id} value={font.id}>
							<span
								style={{ fontFamily: `"${font.family}", ${font.fallback}` }}
							>
								{font.family}
							</span>
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	)
}

function FontFileField({
	role,
	filename,
	disabled,
	onUpload,
	onRemove,
	onError,
}: {
	role: 'heading' | 'body'
	filename: string | null
	disabled?: boolean
	onUpload: (role: 'heading' | 'body', file: File) => void
	onRemove: (role: 'heading' | 'body') => void
	onError: (message: string) => void
}) {
	const inputRef = useRef<HTMLInputElement>(null)

	const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0]
		event.currentTarget.value = ''
		if (!file) return
		if (!siteFontFormatFromExtension(file.name)) {
			onError('Use a WOFF2, WOFF, TTF, or OTF file')
			return
		}
		if (file.size > MAX_FONT_SIZE) {
			onError('Font size must be less than 2MB')
			return
		}
		onUpload(role, file)
	}

	return (
		<div>
			<input
				ref={inputRef}
				type="file"
				accept={FONT_ACCEPT}
				className="sr-only"
				disabled={disabled}
				onChange={handleChange}
			/>
			{filename ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<p className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
						{filename}
					</p>
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={disabled}
						onClick={() => inputRef.current?.click()}
					>
						<Trans>Replace</Trans>
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="xs"
						className="text-destructive hover:text-destructive"
						disabled={disabled}
						onClick={() => onRemove(role)}
					>
						<Trans>Remove</Trans>
					</Button>
				</div>
			) : (
				<button
					type="button"
					disabled={disabled}
					onClick={() => inputRef.current?.click()}
					className={cn(
						'text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline',
						'focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none',
						'disabled:pointer-events-none disabled:opacity-50',
					)}
				>
					<Trans>Upload a font</Trans>
				</button>
			)}
		</div>
	)
}

type CssTokenKey = (typeof ignoredShadcnTokens)[number]

/** Purpose-grouped token order shown in the editor. */
const TOKEN_GROUPS: ReadonlyArray<{
	id: string
	label: string
	hint: string
	tokens: ReadonlyArray<CssTokenKey>
}> = [
	{
		id: 'surface',
		label: 'Surface',
		hint: 'Backgrounds, cards, and popovers',
		tokens: [
			'background',
			'foreground',
			'card',
			'card-foreground',
			'popover',
			'popover-foreground',
		],
	},
	{
		id: 'action',
		label: 'Action',
		hint: 'Primary buttons, links, and their text',
		tokens: [
			'primary',
			'primary-foreground',
			'secondary',
			'secondary-foreground',
		],
	},
	{
		id: 'muted',
		label: 'Muted',
		hint: 'Subdued surfaces and placeholder text',
		tokens: ['muted', 'muted-foreground', 'accent', 'accent-foreground'],
	},
	{
		id: 'border',
		label: 'Border & Input',
		hint: 'Form fields, dividers, and focus rings',
		tokens: ['border', 'input', 'ring'],
	},
	{
		id: 'status',
		label: 'Status',
		hint: 'Errors and destructive actions',
		tokens: ['destructive', 'destructive-foreground'],
	},
]

const TOKEN_LABELS: Record<CssTokenKey, string> = {
	background: 'Background',
	foreground: 'Foreground',
	card: 'Card',
	'card-foreground': 'Card text',
	popover: 'Popover',
	'popover-foreground': 'Popover text',
	primary: 'Primary',
	'primary-foreground': 'Primary text',
	secondary: 'Secondary',
	'secondary-foreground': 'Secondary text',
	muted: 'Muted',
	'muted-foreground': 'Muted text',
	accent: 'Accent',
	'accent-foreground': 'Accent text',
	destructive: 'Destructive',
	'destructive-foreground': 'Destructive text',
	border: 'Border',
	input: 'Input',
	ring: 'Focus ring',
}

/**
 * Best-effort normalization to a 7-char `#rrggbb` hex so the native
 * `<input type="color">` can read the value. The text input still accepts
 * any CSS color (oklch, hsl, named) — this only powers the picker swatch.
 */
function toHexForPicker(value: string | undefined): string {
	if (!value) return '#000000'
	const v = value.trim()
	if (/^#[0-9a-fA-F]{6}$/.test(v)) return v
	if (/^#[0-9a-fA-F]{3}$/.test(v)) {
		return (
			'#' +
			v
				.slice(1)
				.split('')
				.map((c) => c + c)
				.join('')
		)
	}
	return '#000000'
}

function isColorishValue(value: string | undefined): boolean {
	if (!value) return false
	const v = value.trim().toLowerCase()
	if (v.startsWith('#')) return true
	if (v.startsWith('rgb') || v.startsWith('hsl') || v.startsWith('oklch'))
		return true
	if (v.startsWith('oklab') || v.startsWith('lab') || v.startsWith('lch'))
		return true
	return false
}

function TokenSwatch({
	value,
	disabled,
	onPick,
	overridden,
}: {
	value: string | undefined
	disabled?: boolean
	onPick: (hex: string) => void
	overridden: boolean
}) {
	const hasColor = isColorishValue(value)

	return (
		<label
			className={cn(
				'border-border relative size-7 shrink-0 cursor-pointer rounded-md border',
				'focus-within:ring-ring focus-within:ring-2 focus-within:ring-offset-1',
				overridden && 'ring-foreground/20 ring-2 ring-offset-1',
				disabled && 'pointer-events-none opacity-50',
			)}
			style={
				hasColor
					? { backgroundColor: value!.trim() }
					: {
							backgroundImage:
								'conic-gradient(#e5e7eb 0 25%, #ffffff 0 50%, #e5e7eb 0 75%, #ffffff 0)',
							backgroundSize: '8px 8px',
						}
			}
		>
			<input
				type="color"
				className="absolute inset-0 size-full cursor-pointer opacity-0"
				disabled={disabled}
				value={toHexForPicker(value)}
				onChange={(e) => onPick(e.target.value)}
			/>
		</label>
	)
}

function TokenRow({
	token,
	tokenValue,
	presetValue,
	overridden,
	disabled,
	isFirst,
	onChange,
}: {
	token: CssTokenKey
	tokenValue: string
	presetValue: string
	overridden: boolean
	disabled?: boolean
	isFirst: boolean
	onChange: (token: CssTokenKey, next: string | undefined) => void
}) {
	const inputId = `css-var-${token}`
	const cssVar = `--${token}`

	return (
		<div
			className={cn(
				'flex flex-col gap-1.5 px-3 py-2 transition-colors',
				'hover:bg-muted/30 focus-within:bg-muted/30',
				!isFirst && 'border-border border-t',
				overridden && 'bg-foreground/2',
			)}
		>
			<div className="flex min-w-0 items-center gap-2">
				<TokenSwatch
					value={tokenValue}
					disabled={disabled}
					overridden={overridden}
					onPick={(hex) => onChange(token, hex)}
				/>
				<label
					htmlFor={inputId}
					className="text-foreground min-w-0 flex-1 truncate text-[12.5px] leading-tight"
					title={cssVar}
				>
					{TOKEN_LABELS[token]}
					<span className="sr-only"> ({cssVar})</span>
				</label>
				{overridden ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									type="button"
									disabled={disabled}
									onClick={() => onChange(token, undefined)}
									aria-label="Reset to preset"
									className={cn(
										'text-muted-foreground hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
										'hover:bg-background/60',
										'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
										'disabled:pointer-events-none disabled:opacity-50',
									)}
								>
									<Icon name="x" size="xs" />
								</button>
							}
						/>
						<TooltipContent className="max-w-56">
							<p>
								<Trans>Reset to preset</Trans>
							</p>
							{presetValue ? (
								<p className="mt-0.5 font-mono text-[10px] break-all opacity-70">
									{presetValue}
								</p>
							) : null}
						</TooltipContent>
					</Tooltip>
				) : null}
			</div>
			<Input
				id={inputId}
				type="text"
				spellCheck={false}
				autoComplete="off"
				className="h-7 w-full min-w-0 font-mono text-[11px]"
				placeholder={presetValue || 'Preset'}
				disabled={disabled}
				value={tokenValue}
				onChange={(e) => onChange(token, e.target.value)}
				title={tokenValue || presetValue}
			/>
		</div>
	)
}

function CssVarsEditor({
	value,
	disabled,
	onChange,
}: {
	value: SiteThemeConfig
	disabled?: boolean
	onChange: (next: SiteThemeConfig) => void
}) {
	const { _ } = useLingui()
	const [open, setOpen] = useState(false)
	const overrides = value.cssVars || {}
	const overrideCount = Object.keys(overrides).length
	const preset = resolveSiteThemePresetTokens(value)

	const setToken = (token: CssTokenKey, next: string | undefined) => {
		const trimmed = next?.trim() ?? ''
		const presetValue = preset[token] ?? ''
		// If the typed value matches the active preset, drop the override
		// so the user can experiment freely without leaving a redundant
		// "override that equals the preset" in storage.
		const newVars: Record<string, string> = { ...overrides }
		if (trimmed && trimmed !== presetValue) {
			newVars[token] = trimmed
		} else {
			delete newVars[token]
		}
		onChange({
			...value,
			cssVars: Object.keys(newVars).length > 0 ? newVars : undefined,
		})
	}

	const resetAll = () => {
		onChange({ ...value, cssVars: undefined })
	}

	return (
		<section className="space-y-3 pt-4">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				className={cn(
					'group/advanced border-border flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
					'hover:border-foreground/20 hover:bg-muted/40',
					'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
					open && 'border-foreground/20 bg-muted/30',
				)}
			>
				<span
					className={cn(
						'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors',
						open
							? 'bg-foreground/10 text-foreground'
							: 'bg-muted text-muted-foreground group-hover/advanced:text-foreground',
					)}
				>
					<Icon name="pocket-knife" size="xs" />
				</span>
				<span className="text-foreground min-w-0 flex-1 text-[13px] leading-snug">
					{_(msg`Custom colors`)}
				</span>
				{overrideCount > 0 ? (
					<span
						className={cn(
							'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5',
							'bg-foreground text-background text-[10px] tabular-nums',
						)}
					>
						{overrideCount}
					</span>
				) : null}
				<span
					className={cn(
						'text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-md transition-transform duration-200 ease-out',
						'group-hover/advanced:text-foreground',
						open && 'text-foreground rotate-180',
					)}
				>
					<Icon name="chevron-down" size="sm" />
				</span>
			</button>

			<div
				className={cn(
					'grid transition-[grid-template-rows] duration-300 ease-out',
					open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
				)}
			>
				<div className="overflow-hidden">
					<div className="space-y-5 pt-1">
						<div className="flex items-start justify-between gap-2">
							<p className="text-muted-foreground min-w-0 text-[11px] leading-relaxed">
								{_(
									msg`Change specific colors here. They start from Accent, Gray, and Appearance above, and work in both light and dark.`,
								)}
							</p>
							{overrideCount > 0 ? (
								<Button
									type="button"
									variant="ghost"
									size="xs"
									disabled={disabled}
									onClick={resetAll}
									className="text-muted-foreground hover:text-foreground self-start"
								>
									<Trans>Reset all</Trans>
								</Button>
							) : null}
						</div>

						<div className="space-y-5">
							{TOKEN_GROUPS.map((group) => (
								<div key={group.id} className="space-y-2">
									<div className="space-y-0.5">
										<h4 className="text-foreground text-[11px] tracking-tight uppercase">
											{group.label}
										</h4>
										<p className="text-muted-foreground text-[10.5px] leading-snug">
											{group.hint}
										</p>
									</div>
									<div className="border-border overflow-hidden rounded-md border">
										{group.tokens.map((token, i) => {
											const presetValue = preset[token] ?? ''
											const overridden = token in overrides
											const tokenValue = overridden
												? (overrides[token] ?? '')
												: presetValue
											return (
												<TokenRow
													key={token}
													token={token}
													tokenValue={tokenValue}
													presetValue={presetValue}
													overridden={overridden}
													disabled={disabled}
													isFirst={i === 0}
													onChange={setToken}
												/>
											)
										})}
									</div>
								</div>
							))}
						</div>
					</div>
				</div>
			</div>
		</section>
	)
}

export function SiteThemeFields({
	value,
	disabled,
	onChange,
	onUploadFont,
	onRemoveFont,
	onFontError,
	uploadingRole,
}: {
	value: SiteThemeConfig
	disabled?: boolean
	onChange: (next: SiteThemeConfig) => void
	onUploadFont?: (role: 'heading' | 'body', file: File) => void
	onRemoveFont?: (role: 'heading' | 'body') => void
	onFontError?: (message: string) => void
	uploadingRole?: 'heading' | 'body' | null
}) {
	const { _ } = useLingui()

	const modeLabels: Record<SiteThemeMode, string> = {
		light: _(msg`Light`),
		dark: _(msg`Dark`),
	}

	const modeIcons = {
		light: 'sun',
		dark: 'moon',
	} as const

	const radiusLabels: Record<SiteThemeRadius, string> = {
		default: _(msg`Medium`),
		none: _(msg`None`),
		small: _(msg`Small`),
		medium: _(msg`Medium`),
		large: _(msg`Large`),
		full: _(msg`Full`),
	}

	/** Prefer Radix-like order: None → Small → Medium → Large (skip duplicate default). */
	const radiusOptions = SITE_THEME_RADII.filter((r) => r !== 'default')

	return (
		<div className="flex flex-col gap-5">
			<section className="space-y-2">
				<FieldLabel>{_(msg`Headings`)}</FieldLabel>
				<FontSelect
					id="site-heading-font"
					value={value.headingFont}
					customLabel={
						value.headingCustomFont
							? siteFontDisplayName(value.headingCustomFont.filename)
							: null
					}
					disabled={disabled}
					onChange={(headingFont) => onChange({ ...value, headingFont })}
				/>
				{onUploadFont && onRemoveFont ? (
					<FontFileField
						role="heading"
						filename={value.headingCustomFont?.filename ?? null}
						disabled={disabled || uploadingRole === 'heading'}
						onUpload={onUploadFont}
						onRemove={onRemoveFont}
						onError={(message) => onFontError?.(message)}
					/>
				) : null}
				<p className="text-muted-foreground text-[11px] leading-relaxed">
					{_(msg`Titles and section headings.`)}
				</p>
			</section>

			<section className="space-y-2">
				<FieldLabel>{_(msg`Body`)}</FieldLabel>
				<FontSelect
					id="site-body-font"
					value={value.bodyFont}
					customLabel={
						value.bodyCustomFont
							? siteFontDisplayName(value.bodyCustomFont.filename)
							: null
					}
					disabled={disabled}
					onChange={(bodyFont) => onChange({ ...value, bodyFont })}
				/>
				{onUploadFont && onRemoveFont ? (
					<FontFileField
						role="body"
						filename={value.bodyCustomFont?.filename ?? null}
						disabled={disabled || uploadingRole === 'body'}
						onUpload={onUploadFont}
						onRemove={onRemoveFont}
						onError={(message) => onFontError?.(message)}
					/>
				) : null}
				<p className="text-muted-foreground text-[11px] leading-relaxed">
					{_(msg`Paragraphs, navigation, and other text.`)}
				</p>
			</section>

			<section className="space-y-2">
				<FieldLabel>{_(msg`Accent color`)}</FieldLabel>
				<div className="flex flex-wrap gap-2">
					{[...ACCENT_NEUTRALS, ...ACCENT_COLORS].map((themeColor) => {
						const meta = getThemeColorMeta(themeColor)
						return (
							<ColorSwatch
								key={themeColor}
								label={meta.label}
								swatch={meta.swatch}
								selected={value.theme === themeColor}
								disabled={disabled}
								onSelect={() => onChange({ ...value, theme: themeColor })}
							/>
						)
					})}
				</div>
			</section>

			<section className="space-y-2">
				<FieldLabel>{_(msg`Gray color`)}</FieldLabel>
				<div className="flex flex-wrap gap-2">
					{SITE_BASE_COLORS.map((baseColor) => {
						const meta = getBaseColorMeta(baseColor)
						return (
							<ColorSwatch
								key={baseColor}
								label={meta.label}
								swatch={meta.swatch}
								selected={value.baseColor === baseColor}
								disabled={disabled}
								onSelect={() => onChange({ ...value, baseColor })}
							/>
						)
					})}
				</div>
			</section>

			<section className="space-y-2">
				<FieldLabel>{_(msg`Appearance`)}</FieldLabel>
				<div className="grid grid-cols-2 gap-1.5">
					{SITE_THEME_MODES.map((mode) => {
						const isSelected = value.mode === mode
						return (
							<button
								key={mode}
								type="button"
								disabled={disabled}
								onClick={() => onChange({ ...value, mode })}
								aria-pressed={isSelected}
								className={cn(
									'border-border flex items-center justify-center gap-1.5 rounded-md border px-1.5 py-2 text-xs font-medium transition-colors',
									'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
									'disabled:pointer-events-none disabled:opacity-50',
									isSelected
										? 'border-foreground bg-background ring-foreground/10 ring-1'
										: 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
								)}
							>
								<Icon name={modeIcons[mode]} className="size-3.5 shrink-0" />
								{modeLabels[mode]}
							</button>
						)
					})}
				</div>
			</section>

			<section className="space-y-2">
				<FieldLabel>{_(msg`Corners`)}</FieldLabel>
				<div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
					{radiusOptions.map((radius) => {
						const isSelected =
							value.radius === radius ||
							(radius === 'medium' && value.radius === 'default')
						return (
							<button
								key={radius}
								type="button"
								disabled={disabled}
								onClick={() => onChange({ ...value, radius })}
								aria-pressed={isSelected}
								className={cn(
									'border-border flex flex-col items-center gap-1 rounded-md border px-1 py-1.5 transition-colors',
									'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
									'disabled:pointer-events-none disabled:opacity-50',
									isSelected
										? 'border-foreground bg-background ring-foreground/10 ring-1'
										: 'hover:bg-muted/50',
								)}
							>
								<RadiusGlyph radius={radius} selected={isSelected} />
								<span
									className={cn(
										'text-[10px] font-medium',
										isSelected ? 'text-foreground' : 'text-muted-foreground',
									)}
								>
									{radiusLabels[radius]}
								</span>
							</button>
						)
					})}
				</div>
			</section>
			<CssVarsEditor value={value} disabled={disabled} onChange={onChange} />
		</div>
	)
}
