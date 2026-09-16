import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { ScrollArea } from '@repo/ui/scroll-area'
import { useCallback, useRef, useState } from 'react'
import { useFetcher } from 'react-router'

export type MediaLibraryAsset = {
	id: string
	objectKey: string
	url: string
	fileName: string | null
	mimeType: string
	fileSize: number | null
	altText: string | null
	source: string
	createdAt: string
}

type MediaActionData = {
	asset?: MediaLibraryAsset
	error?: string
}

export type MediaLibraryPickerProps = {
	orgSlug: string
	onSelect: (asset: MediaLibraryAsset) => void
	disabled?: boolean
	triggerLabel?: React.ReactNode
	iconOnly?: boolean
	className?: string
	variant?: 'default' | 'outline' | 'ghost' | 'secondary'
	size?:
		'default' | 'xs' | 'sm' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg'
	open?: boolean
	onOpenChange?: (open: boolean) => void
	trigger?: React.ReactElement | null
}

type MediaLibraryData = {
	assets?: MediaLibraryAsset[]
	asset?: MediaLibraryAsset
	error?: string
}

const ACCEPTED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
])

const ACCEPTED_IMAGE_EXTENSIONS = /\.(avif|gif|jpe?g|png|webp)$/iu

export function MediaLibraryPicker({
	orgSlug,
	onSelect,
	disabled = false,
	triggerLabel,
	iconOnly = false,
	className,
	variant = 'outline',
	size,
	open: controlledOpen,
	onOpenChange: controlledOnOpenChange,
	trigger,
}: MediaLibraryPickerProps) {
	const { _ } = useLingui()
	const fetcher = useFetcher<MediaLibraryData>()
	const fileInputRef = useRef<HTMLInputElement>(null)
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
	const isControlled = controlledOpen !== undefined
	const open = isControlled ? controlledOpen : uncontrolledOpen

	const [query, setQuery] = useState('')
	const [selectedAsset, setSelectedAsset] = useState<MediaLibraryAsset | null>(
		null,
	)
	const [uploadError, setUploadError] = useState<string | null>(null)
	const [isUploading, setIsUploading] = useState(false)

	const reset = useCallback(() => {
		setQuery('')
		setSelectedAsset(null)
		setUploadError(null)
		if (fileInputRef.current) fileInputRef.current.value = ''
	}, [])

	const wasOpenRef = useRef(open)
	if (open && !wasOpenRef.current) {
		wasOpenRef.current = true
		reset()
		void fetcher.load(`/${orgSlug}/media?index`)
	} else if (!open && wasOpenRef.current) {
		wasOpenRef.current = false
	}

	const assets = fetcher.data?.assets ?? []
	const isLoading = open && fetcher.state === 'loading' && !fetcher.data?.assets
	const filteredAssets = assets.filter((asset) => {
		const searchable = [asset.fileName, asset.altText, asset.source]
			.filter(Boolean)
			.join(' ')
			.toLocaleLowerCase()
		return searchable.includes(query.trim().toLocaleLowerCase())
	})

	const handleOpenChange = useCallback(
		(isOpen: boolean) => {
			if (!isControlled) {
				setUncontrolledOpen(isOpen)
			}
			controlledOnOpenChange?.(isOpen)
			if (!isOpen) {
				reset()
			}
		},
		[controlledOnOpenChange, isControlled, reset],
	)

	const handleUpload = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.currentTarget.files?.[0]
			event.currentTarget.value = ''
			if (!file) return

			if (
				!ACCEPTED_IMAGE_TYPES.has(file.type) &&
				!ACCEPTED_IMAGE_EXTENSIONS.test(file.name)
			) {
				setUploadError(_(msg`Choose a JPEG, PNG, GIF, WebP, or AVIF image.`))
				return
			}

			setUploadError(null)
			setIsUploading(true)
			const formData = new FormData()
			formData.append('intent', 'upload')
			formData.append('imageFile', file)

			try {
				const response = await fetch(`/${orgSlug}/media`, {
					method: 'POST',
					body: formData,
				})
				const data = (await response.json()) as MediaActionData
				if (!response.ok || data.error) {
					setUploadError(data.error ?? _(msg`Upload failed.`))
					return
				}
				if (data.asset) {
					onSelect(data.asset)
					handleOpenChange(false)
					reset()
				}
			} catch {
				setUploadError(_(msg`Upload failed. Please try again.`))
			} finally {
				setIsUploading(false)
			}
		},
		[_, handleOpenChange, onSelect, orgSlug, reset],
	)

	const handleUseSelected = useCallback(() => {
		if (!selectedAsset) return
		onSelect(selectedAsset)
		handleOpenChange(false)
		reset()
	}, [handleOpenChange, onSelect, reset, selectedAsset])

	const error = uploadError ?? fetcher.data?.error

	const resolvedLabel =
		typeof triggerLabel === 'string'
			? triggerLabel
			: _(msg`Choose from library`)

	return (
		<div onClick={(e) => e.stopPropagation()} className="inline-flex">
			<Dialog open={open} onOpenChange={handleOpenChange}>
				{trigger !== undefined ? (
					trigger ? (
						<DialogTrigger render={trigger} />
					) : null
				) : (
					<DialogTrigger
						render={
							<Button
								type="button"
								disabled={disabled}
								className={className}
								variant={variant}
								size={size ?? (iconOnly ? 'icon-sm' : 'default')}
								title={resolvedLabel}
								aria-label={resolvedLabel}
								onClick={(e) => e.stopPropagation()}
							>
								<Icon name="image" className="size-4" />
								{iconOnly ? null : (triggerLabel ?? resolvedLabel)}
							</Button>
						}
					/>
				)}
				<DialogContent
					onClick={(e) => e.stopPropagation()}
					className="flex max-h-[min(42rem,calc(100vh-2rem))] flex-col gap-4 p-4 sm:max-w-3xl"
				>
					<DialogHeader>
						<DialogTitle>
							<Trans>Media library</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Select an image from your library or upload a new one.
							</Trans>
						</DialogDescription>
					</DialogHeader>

					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="relative min-w-0 flex-1">
							<Icon
								name="search"
								className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
							/>
							<Input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder={_(msg`Search media`)}
								aria-label={_(msg`Search media library`)}
								className="pl-8"
							/>
						</div>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/jpeg,image/png,image/gif,image/webp,image/avif"
							onChange={handleUpload}
							className="sr-only"
							tabIndex={-1}
						/>
						<Button
							type="button"
							variant="outline"
							disabled={isUploading}
							onClick={() => fileInputRef.current?.click()}
						>
							<Icon
								name={isUploading ? 'loader' : 'image'}
								className={cn(isUploading && 'animate-spin')}
							/>
							<Trans>Upload new</Trans>
						</Button>
					</div>

					{error ? (
						<p className="text-destructive text-sm" role="alert">
							{error}
						</p>
					) : null}

					<ScrollArea
						className="min-h-0 flex-1"
						viewportClassName="max-h-[24rem]"
					>
						{isLoading ? (
							<div className="text-muted-foreground flex min-h-48 items-center justify-center gap-2 text-sm">
								<Icon name="loader" className="size-4 animate-spin" />
								<Trans>Loading media…</Trans>
							</div>
						) : filteredAssets.length ? (
							<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
								{filteredAssets.map((asset) => {
									const isSelected = selectedAsset?.id === asset.id
									const label = asset.altText || asset.fileName || asset.source
									return (
										<button
											key={asset.id}
											type="button"
											onClick={() => setSelectedAsset(asset)}
											aria-pressed={isSelected}
											className={cn(
												'focus-visible:ring-ring/50 relative overflow-hidden rounded-lg border text-left outline-none focus-visible:ring-2',
												isSelected
													? 'border-primary ring-primary/20 ring-2'
													: 'border-border hover:border-primary/50',
											)}
										>
											<img
												src={asset.url}
												alt={asset.altText ?? asset.fileName ?? ''}
												className="bg-muted aspect-square w-full object-cover"
											/>
											<span className="bg-background/95 block truncate border-t px-2 py-1.5 text-xs font-medium">
												{label}
											</span>
											{isSelected ? (
												<span className="bg-primary text-primary-foreground absolute top-2 right-2 rounded-full p-1">
													<Icon name="check" className="size-3" />
													<span className="sr-only">
														<Trans>Selected</Trans>
													</span>
												</span>
											) : null}
										</button>
									)
								})}
							</div>
						) : (
							<div className="text-muted-foreground flex min-h-48 flex-col items-center justify-center gap-2 text-center text-sm">
								<Icon name="image" className="size-6" />
								{assets.length ? (
									<Trans>No media matches your search.</Trans>
								) : (
									<Trans>No media yet. Upload an image to get started.</Trans>
								)}
							</div>
						)}
					</ScrollArea>

					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							<Trans>Cancel</Trans>
						</DialogClose>
						<Button
							type="button"
							disabled={!selectedAsset}
							onClick={handleUseSelected}
						>
							<Trans>Use selected</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}
