import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	DEFAULT_SITE_THEME,
	paletteMeetsContrast,
	suggestLogoPalette,
	themeWithLogoPalette,
	type Rgb,
	type SiteThemeConfig,
} from '@repo/common/site-theme'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { ScrollArea } from '@repo/ui/scroll-area'
import { Spinner } from '@repo/ui/spinner'
import { Img } from 'openimg/react'
import { useEffect, useRef, useState } from 'react'
import { useFetcher } from 'react-router'
import {
	deleteSiteIconActionIntent,
	uploadSiteIconActionIntent,
} from '#app/components/settings/cards/organization/site-icon-card.tsx'
import {
	SiteThemeFields,
	confirmSiteFontLicenceActionIntent,
	deleteSiteFontActionIntent,
	siteThemeActionIntent,
	uploadSiteFontActionIntent,
} from '#app/components/settings/cards/organization/site-theme-card.tsx'
import {
	DiscardChangesDialog,
	UnpublishedChangesBadge,
} from '#app/components/website/publish-controls.tsx'

const MAX_ICON_SIZE = 1024 * 1024 * 5

async function sampleLogo(src: string): Promise<Rgb[]> {
	const image = new Image()
	image.crossOrigin = 'anonymous'
	await new Promise<void>((resolve, reject) => {
		image.onload = () => resolve()
		image.onerror = () => reject(new Error('logo'))
		image.src = src
	})
	const size = 24
	const canvas = document.createElement('canvas')
	canvas.width = size
	canvas.height = size
	const context = canvas.getContext('2d')
	if (!context) return []
	context.drawImage(image, 0, 0, size, size)
	const data = context.getImageData(0, 0, size, size).data
	const samples: Rgb[] = []
	for (let index = 0; index < data.length; index += 4) {
		if ((data[index + 3] ?? 0) < 128) continue
		samples.push({
			r: data[index] ?? 0,
			g: data[index + 1] ?? 0,
			b: data[index + 2] ?? 0,
		})
	}
	return samples
}

function LogoPaletteOffer({
	src,
	onApply,
}: {
	src: string
	onApply: (samples: Rgb[]) => void
}) {
	const [samples, setSamples] = useState<Rgb[] | null>(null)
	useEffect(() => {
		let cancelled = false
		void sampleLogo(src)
			.then((next) => {
				if (!cancelled) setSamples(next)
			})
			.catch(() => {
				if (!cancelled) setSamples(null)
			})
		return () => {
			cancelled = true
		}
	}, [src])
	if (!samples || samples.length === 0) return null
	const palette = suggestLogoPalette(samples)
	if (!paletteMeetsContrast(palette)) return null
	return (
		<div className="space-y-2" data-logo-palette>
			<p className="text-muted-foreground text-xs font-medium">
				<Trans>Colors from your logo</Trans>
			</p>
			<div className="flex gap-2">
				{['primary', 'background', 'foreground'].map((token) => (
					<span
						key={token}
						className="border-border size-8 rounded-md border bg-(--swatch)"
						style={
							{ '--swatch': palette.cssVars[token] } as React.CSSProperties
						}
					/>
				))}
			</div>
			<Button
				type="button"
				variant="outline"
				size="sm"
				onClick={() => onApply(samples)}
			>
				<Trans>Use these colors</Trans>
			</Button>
			<p className="text-muted-foreground text-[11px] leading-relaxed">
				<Trans>
					This updates the theme preview. The live site changes when you
					publish.
				</Trans>
			</p>
		</div>
	)
}

function getSharedCookieDomain() {
	if (typeof window === 'undefined') return ''
	const host = window.location.hostname
	if (host === 'localhost' || host === '127.0.0.1') return ''
	if (host.endsWith('.localhost')) return '; domain=.localhost'
	const parts = host.split('.')
	if (parts.length >= 3 && (parts[0] === 'app' || parts[0] === 'admin')) {
		return '; domain=.' + parts.slice(1).join('.')
	}
	return ''
}

export function BrandingPanel({
	organization,
	fontLicence,
	themeConfig,
	onPreviewRefresh,
	siteDesignPending = false,
	onOpenHistory,
	onSchedule,
}: {
	organization: {
		id: string
		siteIconKey: string | null
		siteIconAssets: Array<{ type: string; status: string }>
	}
	/** Licence confirmation of custom fonts (#286). */
	fontLicence?: {
		version: number
		accepted: boolean
		fonts: Partial<
			Record<
				'heading' | 'body',
				{
					fileName: string
					uploader: string | null
					uploadedAt: string | null
					needsConfirmation: boolean
				}
			>
		>
	}
	themeConfig: SiteThemeConfig
	onPreviewRefresh: () => void
	/** Header, footer or theme has unpublished changes (#85). */
	siteDesignPending?: boolean
	onOpenHistory?: () => void
	onSchedule?: () => void
}) {
	const { _ } = useLingui()
	const publishFetcher = useFetcher<{ status?: string; error?: string }>()
	const [discardOpen, setDiscardOpen] = useState(false)
	const themeFetcher = useFetcher<{ status?: string; error?: string }>()
	const iconFetcher = useFetcher<{ status?: string; error?: string }>()
	const fontFetcher = useFetcher<{
		status?: string
		error?: string
		code?: string
	}>()
	const fileInputRef = useRef<HTMLInputElement | null>(null)
	const [theme, setTheme] = useState<SiteThemeConfig>(() => ({
		...DEFAULT_SITE_THEME,
		...themeConfig,
	}))
	const [localPreview, setLocalPreview] = useState<string | null>(null)
	const [iconError, setIconError] = useState<string | null>(null)
	const lastThemeRefresh = useRef(false)
	const lastIconRefresh = useRef(false)
	const lastFontRefresh = useRef(false)
	const [fontError, setFontError] = useState<string | null>(null)
	const [uploadingRole, setUploadingRole] = useState<'heading' | 'body' | null>(
		null,
	)

	useEffect(() => {
		setTheme({ ...DEFAULT_SITE_THEME, ...themeConfig })
	}, [themeConfig])

	useEffect(() => {
		if (themeFetcher.state !== 'idle') {
			lastThemeRefresh.current = true
			return
		}
		if (lastThemeRefresh.current && themeFetcher.data?.status === 'success') {
			lastThemeRefresh.current = false
			if (typeof document !== 'undefined') {
				document.cookie = `epic_preview_theme=; path=/; max-age=0; SameSite=Lax${getSharedCookieDomain()}`
			}
			onPreviewRefresh()
		}
	}, [themeFetcher.state, themeFetcher.data, onPreviewRefresh])

	useEffect(() => {
		if (iconFetcher.state !== 'idle') {
			lastIconRefresh.current = true
			return
		}
		if (lastIconRefresh.current && iconFetcher.data?.status === 'success') {
			lastIconRefresh.current = false
			setLocalPreview(null)
			if (fileInputRef.current) fileInputRef.current.value = ''
			onPreviewRefresh()
		}
	}, [iconFetcher.state, iconFetcher.data, onPreviewRefresh])

	useEffect(() => {
		if (fontFetcher.state !== 'idle') {
			lastFontRefresh.current = true
			return
		}
		if (lastFontRefresh.current) {
			lastFontRefresh.current = false
			setUploadingRole(null)
			if (fontFetcher.data?.status === 'success') {
				setFontError(null)
				onPreviewRefresh()
			}
		}
	}, [fontFetcher.state, fontFetcher.data, onPreviewRefresh])

	const busyTheme = themeFetcher.state !== 'idle'
	const busyIcon = iconFetcher.state !== 'idle'
	const busyFont = fontFetcher.state !== 'idle'
	const hasProcessingAssets = organization.siteIconAssets.some(
		(asset) => asset.status === 'processing',
	)
	const hasCompletedAssets = organization.siteIconAssets.some(
		(asset) => asset.status === 'completed',
	)
	const imgSrc = organization.siteIconKey
		? `/resources/images?objectKey=${encodeURIComponent(organization.siteIconKey)}`
		: ''
	const uploadError =
		iconError ||
		(iconFetcher.data?.status === 'error'
			? (iconFetcher.data.error ?? null)
			: null)

	const applyLogoPalette = (samples: Rgb[]) => {
		const next = themeWithLogoPalette(theme, samples)
		if (!paletteMeetsContrast(suggestLogoPalette(samples))) return
		persistTheme(next)
		void themeFetcher.submit(
			{
				intent: siteThemeActionIntent,
				organizationId: organization.id,
				baseColor: next.baseColor,
				theme: next.theme,
				radius: next.radius,
				mode: next.mode,
				...(next.headingFont ? { headingFont: next.headingFont } : {}),
				...(next.bodyFont ? { bodyFont: next.bodyFont } : {}),
				cssVars: JSON.stringify(next.cssVars ?? {}),
			},
			{ method: 'POST' },
		)
	}

	const handleSaveTheme = () => {
		void themeFetcher.submit(
			{
				intent: siteThemeActionIntent,
				organizationId: organization.id,
				baseColor: theme.baseColor,
				theme: theme.theme,
				radius: theme.radius,
				mode: theme.mode,
				...(theme.headingFont ? { headingFont: theme.headingFont } : {}),
				...(theme.bodyFont ? { bodyFont: theme.bodyFont } : {}),
				...(theme.cssVars && Object.keys(theme.cssVars).length > 0
					? { cssVars: JSON.stringify(theme.cssVars) }
					: {}),
			},
			{ method: 'POST' },
		)
	}

	const persistTheme = (next: SiteThemeConfig) => {
		if (typeof window !== 'undefined') {
			window.dispatchEvent(
				new CustomEvent('epic-preview-theme-change', { detail: next }),
			)
		}
		setTheme(next)
		// Theme changes are now only saved to cookies until published
	}

	const handleUploadFont = (
		role: 'heading' | 'body',
		file: File,
		licenceAccepted: boolean,
	) => {
		setFontError(null)
		setUploadingRole(role)
		const formData = new FormData()
		formData.append('intent', uploadSiteFontActionIntent)
		formData.append('organizationId', organization.id)
		formData.append('role', role)
		// The agreement the member ticked, for the version they saw (#286).
		if (licenceAccepted) {
			formData.append('fontLicenceAccepted', 'true')
			formData.append('fontLicenceVersion', String(fontLicence?.version ?? ''))
		}
		formData.append('fontFile', file)
		void fontFetcher.submit(formData, {
			method: 'POST',
			encType: 'multipart/form-data',
		})
	}

	const handleConfirmFontLicence = (role: 'heading' | 'body') => {
		setFontError(null)
		void fontFetcher.submit(
			{
				intent: confirmSiteFontLicenceActionIntent,
				organizationId: organization.id,
				role,
				fontLicenceAccepted: 'true',
				fontLicenceVersion: String(fontLicence?.version ?? ''),
			},
			{ method: 'POST' },
		)
	}

	const handleRemoveFont = (role: 'heading' | 'body') => {
		setFontError(null)
		void fontFetcher.submit(
			{
				intent: deleteSiteFontActionIntent,
				organizationId: organization.id,
				role,
			},
			{ method: 'POST' },
		)
	}

	const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0]
		event.currentTarget.value = ''
		if (!file) return

		if (file.type !== 'image/png') {
			setIconError('Only PNG images are accepted')
			return
		}
		if (file.size > MAX_ICON_SIZE) {
			setIconError('Image size must be less than 5MB')
			return
		}

		setIconError(null)
		const reader = new FileReader()
		reader.onload = (loadEvent) => {
			if (typeof loadEvent.target?.result === 'string') {
				setLocalPreview(loadEvent.target.result)
			}
		}
		reader.readAsDataURL(file)

		const formData = new FormData()
		formData.append('intent', uploadSiteIconActionIntent)
		formData.append('organizationId', organization.id)
		formData.append('iconFile', file)
		void iconFetcher.submit(formData, {
			method: 'POST',
			encType: 'multipart/form-data',
		})
	}

	const handleDelete = () => {
		setLocalPreview(null)
		setIconError(null)
		void iconFetcher.submit(
			{
				intent: deleteSiteIconActionIntent,
				organizationId: organization.id,
			},
			{ method: 'POST' },
		)
	}

	const displaySrc = localPreview || imgSrc
	const hasLogo = Boolean(displaySrc) || hasCompletedAssets

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
					<Icon name="paintbrush" className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					<Trans>Branding</Trans>
				</span>
				{busyTheme || busyIcon || busyFont || hasProcessingAssets ? (
					<Spinner className="size-3.5" />
				) : null}
			</div>

			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-6 p-4">
					<p className="text-muted-foreground text-xs leading-relaxed">
						<Trans>
							Logo, fonts, colors, and corners apply to every page. The preview
							updates as you change them.
						</Trans>
					</p>

					<div className="space-y-2">
						<p className="text-muted-foreground text-xs font-medium">
							<Trans>Logo</Trans>
						</p>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/png"
							className="sr-only"
							onChange={handleFileSelect}
						/>
						{hasLogo ? (
							<div className="flex items-center gap-3">
								<div className="border-border bg-muted flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
									{localPreview ? (
										<img
											src={localPreview}
											alt=""
											className="size-full object-contain"
										/>
									) : imgSrc ? (
										<Img
											src={imgSrc}
											alt=""
											width={96}
											height={96}
											className="size-full object-contain"
										/>
									) : (
										<Icon
											name="image"
											className="text-muted-foreground size-4"
										/>
									)}
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap gap-1.5">
										<Button
											type="button"
											variant="outline"
											size="xs"
											disabled={busyIcon}
											onClick={() => fileInputRef.current?.click()}
										>
											<Trans>Change</Trans>
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="xs"
											className="text-destructive hover:text-destructive"
											disabled={busyIcon}
											onClick={handleDelete}
										>
											<Trans>Remove</Trans>
										</Button>
									</div>
									<p className="text-muted-foreground mt-1.5 text-[11px] leading-relaxed">
										<Trans>PNG, up to 5 MB. Used as logo and favicon.</Trans>
									</p>
								</div>
							</div>
						) : (
							<button
								type="button"
								disabled={busyIcon}
								onClick={() => fileInputRef.current?.click()}
								className={cn(
									'border-border hover:bg-muted/50 flex w-full items-center gap-3 rounded-lg border border-dashed px-3 py-3 text-left transition-colors',
									'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
									'disabled:pointer-events-none disabled:opacity-50',
								)}
							>
								<span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-md">
									<Icon name="image" className="size-4" />
								</span>
								<span>
									<span className="block text-sm font-medium">
										<Trans>Upload a logo</Trans>
									</span>
									<span className="text-muted-foreground mt-0.5 block text-[11px] leading-relaxed">
										<Trans>PNG, up to 5 MB. Recommended 512×512.</Trans>
									</span>
								</span>
							</button>
						)}
						{hasProcessingAssets ? (
							<p className="text-muted-foreground flex items-center gap-2 text-[11px]">
								<Icon name="loader" className="size-3.5 animate-spin" />
								<Trans>Generating favicon variants…</Trans>
							</p>
						) : null}
						{uploadError ? (
							<p className="text-destructive text-xs" role="alert">
								{uploadError}
							</p>
						) : null}
					</div>

					{displaySrc ? (
						<LogoPaletteOffer src={displaySrc} onApply={applyLogoPalette} />
					) : null}

					<SiteThemeFields
						value={theme}
						disabled={busyTheme || busyFont}
						onChange={persistTheme}
						onUploadFont={handleUploadFont}
						onRemoveFont={handleRemoveFont}
						onFontError={setFontError}
						uploadingRole={busyFont ? uploadingRole : null}
						fontLicence={
							fontLicence
								? {
										version: fontLicence.version,
										accepted: fontLicence.accepted,
									}
								: undefined
						}
						fontInfo={fontLicence?.fonts}
						onConfirmFontLicence={handleConfirmFontLicence}
					/>
					{fontError || fontFetcher.data?.status === 'error' ? (
						<p className="text-destructive text-xs" role="alert">
							{fontError ||
								(fontFetcher.data?.code === 'font_agreement_required'
									? _(
											msg`Confirm that you hold a web licence for this font to upload it.`,
										)
									: fontFetcher.data?.error)}
						</p>
					) : null}
				</div>
			</ScrollArea>
			<div className="border-border bg-background space-y-2 border-t p-3">
				{siteDesignPending ? (
					<div className="flex items-center justify-between gap-2">
						<UnpublishedChangesBadge />
						<p className="text-muted-foreground text-[11px] leading-snug">
							<Trans>
								Visitors keep seeing the live header, footer and theme until you
								publish.
							</Trans>
						</p>
					</div>
				) : null}
				{publishFetcher.data?.status === 'error' ? (
					<p role="alert" className="text-destructive text-xs">
						{publishFetcher.data.error}
					</p>
				) : null}
				<div className="flex flex-wrap items-center justify-end gap-2">
					{onOpenHistory ? (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={onOpenHistory}
						>
							<Trans>History</Trans>
						</Button>
					) : null}
					{siteDesignPending ? (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							disabled={publishFetcher.state !== 'idle'}
							onClick={() => setDiscardOpen(true)}
						>
							<Trans>Discard</Trans>
						</Button>
					) : null}
					{onSchedule ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={onSchedule}
						>
							<Trans>Publish later</Trans>
						</Button>
					) : null}
					<Button
						size="sm"
						variant="outline"
						onClick={handleSaveTheme}
						disabled={busyTheme}
					>
						{busyTheme ? <Spinner className="mr-2 size-3" /> : null}
						<Trans>Save Branding</Trans>
					</Button>
					<Button
						size="sm"
						disabled={!siteDesignPending || publishFetcher.state !== 'idle'}
						onClick={() => {
							void publishFetcher.submit(
								{ intent: 'publish-site' },
								{ method: 'POST' },
							)
						}}
					>
						{publishFetcher.state !== 'idle' ? (
							<Spinner className="mr-2 size-3" />
						) : null}
						<Trans>Publish branding</Trans>
					</Button>
				</div>
			</div>
			<DiscardChangesDialog
				site
				open={discardOpen}
				onOpenChange={setDiscardOpen}
				onConfirm={() => {
					void publishFetcher.submit(
						{ intent: 'discard-site-draft' },
						{ method: 'POST' },
					)
				}}
			/>
		</div>
	)
}
