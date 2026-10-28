import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { Progress } from '@repo/ui/progress'
import { Switch } from '@repo/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { Textarea } from '@repo/ui/textarea'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFetcher } from 'react-router'
import { toast } from 'sonner'
import { photoStudioVertical } from '#app/utils/media/photo-studio-vertical.ts'
import {
	aspectRatioFor,
	PHOTO_STUDIO_INSTRUCTIONS_MAX,
	PHOTO_STUDIO_MAX_PHOTOS,
	resolvePhotoStudioOptions,
} from '#app/utils/media/photo-studio.ts'
import { BeforeAfterSlider } from './before-after-slider.tsx'

export type PhotoStudioAsset = {
	id: string
	url: string
	fileName: string | null
	altText: string | null
	mimeType: string
	width: number | null
	height: number | null
}

type StudioImage = {
	blob: Blob
	url: string
	mimeType: string
}

type StudioResult = {
	asset: PhotoStudioAsset
	status: 'pending' | 'done' | 'error'
	versions: StudioImage[]
	error?: string
	saved?: 'copy' | 'replace'
}

type Step = 'photos' | 'style' | 'generating' | 'results'

type SaveData = { asset?: { id: string }; replaced?: boolean; error?: string }

const STUDIO_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024

export function isPhotoStudioCompatible(mimeType: string) {
	return STUDIO_INPUT_TYPES.has(mimeType)
}

function base64ToBlob(base64: string, mimeType: string) {
	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return new Blob([bytes], { type: mimeType })
}

function extensionFor(mimeType: string) {
	if (mimeType === 'image/jpeg') return 'jpg'
	return mimeType.split('/')[1] ?? 'png'
}

function measureImage(url: string) {
	return new Promise<{ width: number; height: number } | null>((resolve) => {
		const img = new Image()
		img.onload = () =>
			resolve({ width: img.naturalWidth, height: img.naturalHeight })
		img.onerror = () => resolve(null)
		img.src = url
	})
}

function resultFileName(asset: PhotoStudioAsset, mimeType: string) {
	const base =
		asset.fileName?.replace(/\.[^/.]+$/, '') || asset.altText || 'photo'
	return `ai-${base}.${extensionFor(mimeType)}`
}

export function PhotoStudioDialog({
	open,
	onOpenChange,
	orgSlug,
	assets,
	initialAssetIds,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	orgSlug: string
	/** Library photos offered on the first step. */
	assets: PhotoStudioAsset[]
	/** Photos to start with; the photo step is skipped when set. */
	initialAssetIds?: string[]
}) {
	const { _ } = useLingui()
	const vertical = photoStudioVertical
	const saveFetcher = useFetcher<SaveData>()
	const referenceInputRef = useRef<HTMLInputElement>(null)
	const objectUrls = useRef<string[]>([])
	const generationRef = useRef(0)
	const pendingSave = useRef<{ index: number; kind: 'copy' | 'replace' }>(
		null,
	)

	const [step, setStep] = useState<Step>('photos')
	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const [category, setCategory] = useState(vertical.categories[0]?.id ?? '')
	const [presetId, setPresetId] = useState<string | null>(null)
	const [reference, setReference] = useState<{ file: File; url: string }>()
	const [options, setOptions] = useState(() =>
		resolvePhotoStudioOptions(vertical, {}),
	)
	const [instructions, setInstructions] = useState('')
	const [results, setResults] = useState<StudioResult[]>([])
	const [activeIndex, setActiveIndex] = useState(0)
	const [refineText, setRefineText] = useState('')
	const [refining, setRefining] = useState(false)

	const trackUrl = useCallback((blob: Blob) => {
		const url = URL.createObjectURL(blob)
		objectUrls.current.push(url)
		return url
	}, [])

	const wasOpen = useRef(false)
	useEffect(() => {
		if (open && !wasOpen.current) {
			const initial = (initialAssetIds ?? []).slice(0, PHOTO_STUDIO_MAX_PHOTOS)
			setSelectedIds(initial)
			setStep(initial.length ? 'style' : 'photos')
			setCategory(vertical.categories[0]?.id ?? '')
			setPresetId(null)
			setReference(undefined)
			setOptions(resolvePhotoStudioOptions(vertical, {}))
			setInstructions('')
			setResults([])
			setActiveIndex(0)
			setRefineText('')
		}
		if (!open && wasOpen.current) {
			for (const url of objectUrls.current) URL.revokeObjectURL(url)
			objectUrls.current = []
		}
		wasOpen.current = open
	}, [open, initialAssetIds, vertical])

	useEffect(() => {
		if (saveFetcher.state !== 'idle' || !saveFetcher.data) return
		const pending = pendingSave.current
		if (!pending) return
		pendingSave.current = null
		if (saveFetcher.data.error) {
			toast.error(saveFetcher.data.error)
			return
		}
		setResults((current) =>
			current.map((result, index) =>
				index === pending.index ? { ...result, saved: pending.kind } : result,
			),
		)
		toast.success(
			pending.kind === 'copy'
				? _(msg`Saved to your media library`)
				: _(msg`Original image replaced`),
		)
	}, [_, saveFetcher.state, saveFetcher.data])

	const selectedAssets = selectedIds
		.map((id) => assets.find((asset) => asset.id === id))
		.filter((asset): asset is PhotoStudioAsset => Boolean(asset))
	const presets = vertical.presets.filter((p) => p.category === category)
	const hasStyle = Boolean(presetId || reference)
	const doneCount = results.filter((r) => r.status !== 'pending').length
	const active = results[activeIndex]
	const activeImage = active?.versions.at(-1)

	function errorMessage(code: string | undefined) {
		switch (code) {
			case 'rate_limited':
				return _(msg`You reached the hourly limit for AI photos. Try again later.`)
			case 'not_configured':
				return _(msg`AI photos are not set up for this workspace.`)
			case 'unsupported_image':
				return _(msg`Use a JPEG, PNG, or WebP photo up to 10 MB.`)
			default:
				return _(msg`The photo could not be generated. Try again.`)
		}
	}

	async function requestImage(
		asset: PhotoStudioAsset,
		extra: { instructions?: string; previous?: StudioImage },
	): Promise<StudioImage> {
		const size =
			asset.width && asset.height
				? { width: asset.width, height: asset.height }
				: await measureImage(asset.url)
		const formData = new FormData()
		formData.set('assetId', asset.id)
		if (reference) {
			formData.set('styleType', 'reference')
			formData.set('styleReference', reference.file)
		} else {
			formData.set('styleType', 'preset')
			formData.set('presetId', presetId ?? '')
		}
		formData.set('options', JSON.stringify(options))
		formData.set('aspectRatio', aspectRatioFor(size?.width, size?.height))
		if (extra.instructions) formData.set('instructions', extra.instructions)
		if (extra.previous) {
			formData.set(
				'previousResult',
				new File(
					[extra.previous.blob],
					`previous.${extensionFor(extra.previous.mimeType)}`,
					{ type: extra.previous.mimeType },
				),
			)
		}
		const response = await fetch(`/${orgSlug}/media/studio`, {
			method: 'POST',
			body: formData,
		})
		const data = (await response.json().catch(() => null)) as {
			ok?: boolean
			error?: string
			image?: { base64: string; mimeType: string }
		} | null
		if (!response.ok || !data?.ok || !data.image) {
			throw new Error(errorMessage(data?.error))
		}
		const blob = base64ToBlob(data.image.base64, data.image.mimeType)
		return { blob, url: trackUrl(blob), mimeType: data.image.mimeType }
	}

	async function generate() {
		const targets = selectedAssets
		const gen = ++generationRef.current
		setResults(
			targets.map((asset) => ({ asset, status: 'pending', versions: [] })),
		)
		setActiveIndex(0)
		setStep('generating')
		const trimmed = instructions.trim() || undefined
		await Promise.all(
			targets.map(async (asset, index) => {
				try {
					const image = await requestImage(asset, { instructions: trimmed })
					setResults((current) =>
						gen === generationRef.current
							? current.map((r, i) =>
									i === index
										? { ...r, status: 'done', versions: [image] }
										: r,
								)
							: current,
					)
				} catch (error) {
					setResults((current) =>
						gen === generationRef.current
							? current.map((r, i) =>
									i === index
										? {
												...r,
												status: 'error',
												error:
													error instanceof Error
														? error.message
														: errorMessage(''),
											}
										: r,
								)
							: current,
					)
				}
			}),
		)
		if (gen === generationRef.current) setStep('results')
	}

	async function refine() {
		if (!active || !activeImage || !refineText.trim()) return
		const index = activeIndex
		setRefining(true)
		try {
			const image = await requestImage(active.asset, {
				instructions: refineText.trim(),
				previous: activeImage,
			})
			setResults((current) =>
				current.map((r, i) =>
					i === index
						? { ...r, versions: [...r.versions, image], saved: undefined }
						: r,
				),
			)
			setRefineText('')
		} catch (error) {
			toast.error(error instanceof Error ? error.message : errorMessage(''))
		} finally {
			setRefining(false)
		}
	}

	async function retry(index: number) {
		const target = results[index]
		if (!target) return
		const gen = generationRef.current
		setResults((current) =>
			current.map((r, i) =>
				i === index ? { ...r, status: 'pending', error: undefined } : r,
			),
		)
		try {
			const image = await requestImage(target.asset, {
				instructions: instructions.trim() || undefined,
			})
			setResults((current) =>
				gen === generationRef.current
					? current.map((r, i) =>
							i === index ? { ...r, status: 'done', versions: [image] } : r,
						)
					: current,
			)
		} catch (error) {
			setResults((current) =>
				gen === generationRef.current
					? current.map((r, i) =>
							i === index
								? {
										...r,
										status: 'error',
										error:
											error instanceof Error ? error.message : errorMessage(''),
									}
								: r,
						)
					: current,
			)
		}
	}

	function undo() {
		setResults((current) =>
			current.map((r, i) =>
				i === activeIndex && r.versions.length > 1
					? { ...r, versions: r.versions.slice(0, -1), saved: undefined }
					: r,
			),
		)
	}

	function save(kind: 'copy' | 'replace') {
		if (!active || !activeImage) return
		const file = new File(
			[activeImage.blob],
			resultFileName(active.asset, activeImage.mimeType),
			{ type: activeImage.mimeType },
		)
		const formData = new FormData()
		if (kind === 'copy') {
			formData.set('intent', 'upload')
			formData.set('source', 'ai-studio')
		} else {
			formData.set('intent', 'replace')
			formData.set('id', active.asset.id)
		}
		formData.set('imageFile', file)
		pendingSave.current = { index: activeIndex, kind }
		void saveFetcher.submit(formData, {
			method: 'POST',
			action: `/${orgSlug}/media`,
			encType: 'multipart/form-data',
		})
	}

	function download() {
		if (!active || !activeImage) return
		const link = document.createElement('a')
		link.href = activeImage.url
		link.download = resultFileName(active.asset, activeImage.mimeType)
		document.body.appendChild(link)
		link.click()
		link.remove()
	}

	function toggleAsset(id: string) {
		setSelectedIds((current) =>
			current.includes(id)
				? current.filter((value) => value !== id)
				: current.length >= PHOTO_STUDIO_MAX_PHOTOS
					? current
					: [...current, id],
		)
	}

	function chooseReference(file: File | undefined) {
		if (!file) return
		if (!STUDIO_INPUT_TYPES.has(file.type) || file.size > MAX_REFERENCE_BYTES) {
			toast.error(_(msg`Use a JPEG, PNG, or WebP photo up to 10 MB.`))
			return
		}
		setReference({ file, url: trackUrl(file) })
		setPresetId(null)
	}

	const isSaving = saveFetcher.state !== 'idle'
	const studioAssets = assets.filter((asset) =>
		isPhotoStudioCompatible(asset.mimeType),
	)
	const steps: { id: Step; label: string }[] = [
		{ id: 'photos', label: _(msg`Photos`) },
		{ id: 'style', label: _(msg`Style`) },
		{ id: 'results', label: _(msg`Results`) },
	]
	const stepIndex =
		step === 'generating' ? 2 : steps.findIndex((s) => s.id === step)

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && (step === 'generating' || refining)) return
				onOpenChange(next)
			}}
		>
			<DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
				<div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<Icon name="sparkles" className="size-4" />
							<Trans>Enhance with AI</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>Turn everyday photos into professional shots.</Trans>
						</DialogDescription>
					</DialogHeader>
					<ol className="text-muted-foreground flex items-center gap-2 text-xs">
						{steps.map((s, index) => (
							<li key={s.id} className="flex items-center gap-2">
								<span
									className={cn(
										'flex items-center gap-1.5',
										index === stepIndex && 'text-foreground font-medium',
									)}
									aria-current={index === stepIndex ? 'step' : undefined}
								>
									<span
										className={cn(
											'flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums',
											index < stepIndex &&
												'bg-primary text-primary-foreground border-transparent',
											index === stepIndex && 'border-foreground',
										)}
									>
										{index < stepIndex ? (
											<Icon name="check" className="size-3" />
										) : (
											index + 1
										)}
									</span>
									{s.label}
								</span>
								{index < steps.length - 1 ? (
									<Icon name="chevron-right" className="size-3" />
								) : null}
							</li>
						))}
					</ol>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto p-6">
					{step === 'photos' ? (
						<div className="space-y-4">
							<div className="flex items-center justify-between gap-3">
								<p className="text-sm font-medium">
									<Trans>Choose up to {PHOTO_STUDIO_MAX_PHOTOS} photos</Trans>
								</p>
								<p className="text-muted-foreground text-xs tabular-nums">
									<Plural
										value={selectedIds.length}
										one="# selected"
										other="# selected"
									/>
								</p>
							</div>
							{studioAssets.length ? (
								<ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
									{studioAssets.map((asset) => {
										const selected = selectedIds.includes(asset.id)
										const order = selectedIds.indexOf(asset.id) + 1
										return (
											<li key={asset.id}>
												<button
													type="button"
													onClick={() => toggleAsset(asset.id)}
													aria-pressed={selected}
													aria-label={
														asset.altText || asset.fileName || _(msg`Photo`)
													}
													className={cn(
														'focus-visible:ring-ring/50 relative block aspect-square w-full overflow-hidden rounded-lg border outline-none focus-visible:ring-2',
														selected
															? 'border-primary ring-primary/20 ring-2'
															: 'hover:border-primary/50',
													)}
												>
													<img
														src={asset.url}
														alt=""
														loading="lazy"
														className="bg-muted size-full object-cover"
													/>
													{selected ? (
														<span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full text-[11px] font-medium tabular-nums">
															{order}
														</span>
													) : null}
												</button>
											</li>
										)
									})}
								</ul>
							) : (
								<p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
									<Trans>
										Upload a JPEG, PNG, or WebP photo to your media library
										first.
									</Trans>
								</p>
							)}
						</div>
					) : null}

					{step === 'style' ? (
						<div className="space-y-6">
							<section className="space-y-2">
								<p className="text-muted-foreground text-xs font-medium">
									<Plural
										value={selectedAssets.length}
										one="Your photo"
										other="Your # photos"
									/>
								</p>
								<div className="flex flex-wrap gap-2">
									{selectedAssets.map((asset) => (
										<img
											key={asset.id}
											src={asset.url}
											alt={asset.altText ?? ''}
											className="bg-muted size-16 rounded-lg border object-cover"
										/>
									))}
								</div>
							</section>

							<section className="space-y-3">
								<div className="flex flex-wrap items-center justify-between gap-2">
									<p className="text-sm font-medium">
										<Trans>Pick a style</Trans>
									</p>
									{vertical.categories.length > 1 ? (
										<Tabs
											value={category}
											onValueChange={(value) => setCategory(String(value))}
										>
											<TabsList>
												{vertical.categories.map((c) => (
													<TabsTrigger key={c.id} value={c.id}>
														{_(c.label)}
													</TabsTrigger>
												))}
											</TabsList>
										</Tabs>
									) : null}
								</div>
								<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
									{presets.map((preset) => {
										const selected = presetId === preset.id
										return (
											<button
												key={preset.id}
												type="button"
												aria-pressed={selected}
												onClick={() => {
													setPresetId(preset.id)
													setReference(undefined)
												}}
												className={cn(
													'focus-visible:ring-ring/50 bg-card flex flex-col overflow-hidden rounded-xl border text-start outline-none focus-visible:ring-2 motion-safe:transition-colors',
													selected
														? 'border-primary ring-primary/20 ring-2'
														: 'hover:border-primary/50',
												)}
											>
												{preset.previewSrc ? (
													<img
														src={preset.previewSrc}
														alt=""
														className="bg-muted aspect-4/3 w-full object-cover"
													/>
												) : (
													<span className="bg-muted text-muted-foreground flex aspect-4/3 w-full items-center justify-center">
														<Icon name={preset.icon} className="size-6" />
													</span>
												)}
												<span className="space-y-0.5 p-2.5">
													<span className="block text-sm font-medium">
														{_(preset.label)}
													</span>
													<span className="text-muted-foreground block text-xs">
														{_(preset.description)}
													</span>
												</span>
											</button>
										)
									})}
								</div>
							</section>

							<section className="space-y-2">
								<p className="text-sm font-medium">
									<Trans>Or match your own style</Trans>
								</p>
								<input
									ref={referenceInputRef}
									type="file"
									accept="image/jpeg,image/png,image/webp"
									className="sr-only"
									tabIndex={-1}
									onChange={(event) => {
										chooseReference(event.currentTarget.files?.[0])
										event.currentTarget.value = ''
									}}
								/>
								{reference ? (
									<div className="border-primary ring-primary/20 flex items-center gap-3 rounded-xl border p-2.5 ring-2">
										<img
											src={reference.url}
											alt=""
											className="size-14 rounded-lg object-cover"
										/>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm font-medium">
												{reference.file.name}
											</p>
											<p className="text-muted-foreground text-xs">
												<Trans>
													The AI matches its lighting, background, and colors.
												</Trans>
											</p>
										</div>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											onClick={() => setReference(undefined)}
											aria-label={_(msg`Remove style reference`)}
										>
											<Icon name="x" />
										</Button>
									</div>
								) : (
									<button
										type="button"
										onClick={() => referenceInputRef.current?.click()}
										className="hover:border-primary/50 focus-visible:ring-ring/50 flex w-full items-center gap-3 rounded-xl border border-dashed p-3 text-start outline-none focus-visible:ring-2"
									>
										<span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
											<Icon name="arrow-up-from-line" className="size-4" />
										</span>
										<span>
											<span className="block text-sm font-medium">
												<Trans>Upload a style reference</Trans>
											</span>
											<span className="text-muted-foreground block text-xs">
												<Trans>
													A photo whose lighting, background, and colors you
													like. JPEG, PNG, or WebP, up to 10 MB.
												</Trans>
											</span>
										</span>
									</button>
								)}
							</section>

							{vertical.options.length ? (
								<section className="space-y-3 rounded-xl border p-4">
									<p className="text-sm font-medium">
										<Trans>Settings</Trans>
									</p>
									{vertical.options.map((option) => (
										<div
											key={option.id}
											className="flex items-start justify-between gap-4"
										>
											<div className="space-y-0.5">
												<Label htmlFor={`studio-option-${option.id}`}>
													{_(option.label)}
												</Label>
												<p className="text-muted-foreground text-xs">
													{_(option.description)}
												</p>
											</div>
											<Switch
												id={`studio-option-${option.id}`}
												checked={options[option.id] ?? option.defaultValue}
												onCheckedChange={(checked) =>
													setOptions((current) => ({
														...current,
														[option.id]: checked,
													}))
												}
											/>
										</div>
									))}
								</section>
							) : null}

							<section className="space-y-1.5">
								<Label htmlFor="studio-instructions">
									<Trans>Extra direction (optional)</Trans>
								</Label>
								<Textarea
									id="studio-instructions"
									value={instructions}
									maxLength={PHOTO_STUDIO_INSTRUCTIONS_MAX}
									onChange={(event) => setInstructions(event.target.value)}
									placeholder={_(msg`e.g. Add a few fresh flowers in the background`)}
									rows={2}
									className="resize-none"
								/>
							</section>
						</div>
					) : null}

					{step === 'generating' ? (
						<div className="flex flex-col items-center gap-5 py-10 text-center">
							<span className="bg-primary/10 text-primary flex size-14 items-center justify-center rounded-full motion-safe:animate-pulse">
								<Icon name="sparkles" className="size-6" />
							</span>
							<div className="space-y-1">
								<p className="text-lg font-medium">
									<Plural
										value={results.length}
										one="Enhancing your photo…"
										other="Enhancing # photos…"
									/>
								</p>
								<p className="text-muted-foreground text-sm">
									<Trans>This usually takes 10 to 30 seconds per photo.</Trans>
								</p>
							</div>
							{results.length > 1 ? (
								<Progress
									value={(doneCount / results.length) * 100}
									className="w-full max-w-xs"
									aria-label={_(msg`Progress`)}
								/>
							) : null}
							<div className="flex flex-wrap justify-center gap-2">
								{results.map((result) => (
									<span
										key={result.asset.id}
										className="relative size-14 overflow-hidden rounded-lg border"
									>
										<img
											src={result.asset.url}
											alt=""
											className="size-full object-cover"
										/>
										{result.status !== 'pending' ? (
											<span className="bg-foreground/40 text-background absolute inset-0 flex items-center justify-center">
												<Icon
													name={result.status === 'done' ? 'check' : 'x'}
													className="size-5"
												/>
											</span>
										) : null}
									</span>
								))}
							</div>
						</div>
					) : null}

					{step === 'results' && active ? (
						<div className="space-y-4">
							{results.length > 1 ? (
								<div className="flex flex-wrap gap-2">
									{results.map((result, index) => {
										const thumb = result.versions.at(-1)?.url ?? result.asset.url
										return (
											<button
												key={result.asset.id}
												type="button"
												onClick={() => {
													setActiveIndex(index)
													setRefineText('')
												}}
												aria-pressed={index === activeIndex}
												aria-label={_(msg`Show result ${index + 1}`)}
												className={cn(
													'focus-visible:ring-ring/50 relative size-14 overflow-hidden rounded-lg border outline-none focus-visible:ring-2',
													index === activeIndex &&
														'border-primary ring-primary/20 ring-2',
												)}
											>
												<img src={thumb} alt="" className="size-full object-cover" />
												{result.status === 'error' ? (
													<span className="bg-destructive/60 text-background absolute inset-0 flex items-center justify-center">
														<Icon name="alert-triangle" className="size-4" />
													</span>
												) : null}
											</button>
										)
									})}
								</div>
							) : null}

							{active.status === 'done' && activeImage ? (
								<>
									<BeforeAfterSlider
										beforeSrc={active.asset.url}
										afterSrc={activeImage.url}
										beforeLabel={_(msg`Original`)}
										afterLabel={_(msg`Enhanced`)}
									/>
									<div className="flex flex-wrap items-center justify-between gap-2">
										<p className="text-muted-foreground text-xs">
											{active.versions.length > 1 ? (
												<Trans>Version {active.versions.length}</Trans>
											) : (
												<Trans>Drag the slider to compare.</Trans>
											)}
										</p>
										<div className="flex flex-wrap gap-2">
											{active.versions.length > 1 ? (
												<Button
													type="button"
													variant="ghost"
													size="sm"
													disabled={refining}
													onClick={undo}
												>
													<Icon name="undo-2" />
													<Trans>Undo</Trans>
												</Button>
											) : null}
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={download}
											>
												<Icon name="download" />
												<Trans>Download</Trans>
											</Button>
										</div>
									</div>
									<form
										className="flex items-end gap-2"
										onSubmit={(event) => {
											event.preventDefault()
											void refine()
										}}
									>
										<div className="min-w-0 flex-1 space-y-1.5">
											<Label htmlFor="studio-refine">
												<Trans>Want changes?</Trans>
											</Label>
											<Textarea
												id="studio-refine"
												value={refineText}
												maxLength={PHOTO_STUDIO_INSTRUCTIONS_MAX}
												disabled={refining}
												onChange={(event) => setRefineText(event.target.value)}
												onKeyDown={(event) => {
													if (event.key === 'Enter' && !event.shiftKey) {
														event.preventDefault()
														void refine()
													}
												}}
												placeholder={_(msg`e.g. Make the background a little darker`)}
												rows={1}
												className="resize-none"
											/>
										</div>
										<Button
											type="submit"
											disabled={refining || !refineText.trim()}
										>
											<Icon
												name={refining ? 'loader' : 'send'}
												className={cn(refining && 'animate-spin')}
											/>
											{refining ? <Trans>Updating…</Trans> : <Trans>Update</Trans>}
										</Button>
									</form>
								</>
							) : active.status === 'pending' ? (
								<div className="text-muted-foreground flex min-h-48 items-center justify-center gap-2 text-sm">
									<Icon name="loader" className="size-4 animate-spin" />
									<Trans>Generating…</Trans>
								</div>
							) : (
								<div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-xl border border-dashed p-6 text-center">
									<p className="text-destructive text-sm" role="alert">
										{active.error}
									</p>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => void retry(activeIndex)}
									>
										<Icon name="refresh-cw" />
										<Trans>Try again</Trans>
									</Button>
								</div>
							)}
						</div>
					) : null}
				</div>

				<DialogFooter className="m-0 sm:items-center sm:justify-between">
					{step === 'photos' ? (
						<>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => onOpenChange(false)}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={!selectedIds.length}
								onClick={() => setStep('style')}
							>
								<Trans>Next: choose style</Trans>
								<Icon name="arrow-right" />
							</Button>
						</>
					) : null}
					{step === 'style' ? (
						<>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() =>
									initialAssetIds?.length
										? onOpenChange(false)
										: setStep('photos')
								}
							>
								<Icon name="arrow-left" />
								{initialAssetIds?.length ? (
									<Trans>Cancel</Trans>
								) : (
									<Trans>Back</Trans>
								)}
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={!hasStyle || !selectedAssets.length}
								onClick={() => void generate()}
							>
								<Icon name="sparkles" />
								<Plural
									value={selectedAssets.length}
									one="Generate photo"
									other="Generate # photos"
								/>
							</Button>
						</>
					) : null}
					{step === 'generating' ? (
						<p className="text-muted-foreground text-xs">
							<Trans>Keep this window open until it finishes.</Trans>
						</p>
					) : null}
					{step === 'results' ? (
						<>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={refining || isSaving}
								onClick={() => setStep('style')}
							>
								<Icon name="paintbrush" />
								<Trans>Try another style</Trans>
							</Button>
							<div className="flex flex-wrap items-center gap-2">
								{active?.saved ? (
									<span className="text-muted-foreground flex items-center gap-1.5 text-xs">
										<Icon name="check" className="size-3.5" />
										{active.saved === 'copy' ? (
											<Trans>Saved as a copy</Trans>
										) : (
											<Trans>Original replaced</Trans>
										)}
									</span>
								) : null}
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={!activeImage || isSaving || refining}
									onClick={() => save('replace')}
								>
									<Icon name="refresh-cw" />
									<Trans>Replace original</Trans>
								</Button>
								<Button
									type="button"
									size="sm"
									disabled={!activeImage || isSaving || refining}
									onClick={() => save('copy')}
								>
									<Icon
										name={isSaving ? 'loader' : 'copy'}
										className={cn(isSaving && 'animate-spin')}
									/>
									<Trans>Save as copy</Trans>
								</Button>
							</div>
						</>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
