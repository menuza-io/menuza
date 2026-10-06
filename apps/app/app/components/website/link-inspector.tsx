import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	computeSiteLinkHref,
	formatFileSize,
	isSiteLinkType,
	matchSitePage,
	normalizeSiteLink,
	type SiteLink,
	type SiteLinkFile,
	type SiteLinkInput,
	type SiteLinkOpenIn,
	type SiteLinkPreload,
	type SiteLinkType,
	type SitePageRef,
} from '@repo/common/site-link'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon, type IconName } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Spinner } from '@repo/ui/spinner'
import {
	type ComponentType,
	type ReactNode,
	createContext,
	useContext,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react'

export type SiteLinkBuilderPage = SitePageRef & {
	title: string
}

type SiteLinkBuilderValue = {
	pages: SiteLinkBuilderPage[]
	onUploadAsset?: (file: File) => void
	isUploadingAsset?: boolean
	uploadedAssetUrl?: string | null
	uploadError?: string | null
}

export const SiteLinkBuilderContext = createContext<SiteLinkBuilderValue>({
	pages: [],
})

type TextInputProps = {
	value: string
	onChange: (value: string) => void
	placeholder?: string
	id?: string
}

const LINK_TYPE_META: Array<{
	value: SiteLinkType
	icon: IconName
	label: string
}> = [
	{ value: 'url', icon: 'link-2', label: 'URL' },
	{ value: 'page', icon: 'file-text', label: 'Page' },
	{ value: 'email', icon: 'mail', label: 'Email' },
	{ value: 'phone', icon: 'smartphone', label: 'Phone' },
	{ value: 'file', icon: 'paperclip', label: 'File' },
]

const PRELOAD_OPTIONS: SiteLinkPreload[] = [
	'default',
	'prefetch',
	'prerender',
	'none',
]

function typeMeta(type: SiteLinkType) {
	return (
		LINK_TYPE_META.find((item) => item.value === type) ?? LINK_TYPE_META[0]!
	)
}

function PlainTextInput({ value, onChange, placeholder, id }: TextInputProps) {
	return (
		<Input
			id={id}
			value={value}
			onChange={(event) => onChange(event.target.value)}
			placeholder={placeholder}
		/>
	)
}

function InspectorRow({
	label,
	htmlFor,
	children,
}: {
	label: string
	htmlFor?: string
	children: ReactNode
}) {
	return (
		<div className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-x-3">
			<label
				htmlFor={htmlFor}
				className="text-muted-foreground text-xs leading-none font-medium"
			>
				{label}
			</label>
			<div className="min-w-0">{children}</div>
		</div>
	)
}

function SegmentedControl({
	value,
	onChange,
	options,
	labelledBy,
}: {
	value: string
	onChange: (value: string) => void
	options: Array<{ value: string; label: ReactNode }>
	labelledBy: string
}) {
	return (
		<div
			role="radiogroup"
			aria-labelledby={labelledBy}
			className="bg-muted flex h-8 rounded-lg p-0.5"
		>
			{options.map((option) => {
				const selected = option.value === value
				return (
					<button
						key={option.value}
						type="button"
						role="radio"
						aria-checked={selected}
						onClick={() => onChange(option.value)}
						className={cn(
							'focus-visible:ring-ring min-h-7 flex-1 rounded-md px-2 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] outline-none focus-visible:ring-2',
							'active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100',
							selected
								? 'bg-background text-foreground shadow-sm'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						{option.label}
					</button>
				)
			})}
		</div>
	)
}

function isPreviewableImage(file: SiteLinkFile) {
	return /\.(png|jpe?g|gif|webp|svg)(?:$|[?#])/iu.test(file.name || file.url)
}

function readImageSize(
	file: File,
): Promise<{ width: number; height: number } | undefined> {
	if (!file.type.startsWith('image/')) return Promise.resolve(undefined)
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file)
		const image = new Image()
		image.onload = () => {
			URL.revokeObjectURL(url)
			resolve({ width: image.naturalWidth, height: image.naturalHeight })
		}
		image.onerror = () => {
			URL.revokeObjectURL(url)
			resolve(undefined)
		}
		image.src = url
	})
}

function applyType(
	current: SiteLink,
	nextType: SiteLinkType,
	pages: SitePageRef[],
): SiteLink {
	const href = current.href || current.url || ''
	const next: SiteLink = {
		type: nextType,
		openIn: current.openIn,
		preload: current.preload,
		url: current.url,
		pageId: current.pageId,
		pageSlug: current.pageSlug,
		email: current.email,
		subject: current.subject,
		phone: current.phone,
		file: current.file,
	}

	if (nextType === 'url') {
		next.url =
			href && !href.startsWith('mailto:') && !href.startsWith('tel:')
				? href
				: current.url || '#'
	}

	if (nextType === 'page') {
		const page = matchSitePage(href, pages)
		if (page) {
			next.pageId = page.id
			next.pageSlug = page.slug
		}
	}

	if (nextType === 'email' && !next.email && href.startsWith('mailto:')) {
		next.email = href.slice('mailto:'.length).split('?')[0]
	}

	if (nextType === 'phone' && !next.phone && href.startsWith('tel:')) {
		next.phone = href.slice('tel:'.length)
	}

	next.href = computeSiteLinkHref(next, pages)
	return next
}

export function LinkInspector({
	value,
	onChange,
	text,
	onTextChange,
	showText = false,
	TextInput = PlainTextInput,
	textPlaceholder,
	buttonStyle,
	onButtonStyleChange,
}: {
	value: SiteLinkInput
	onChange: (link: SiteLink) => void
	text?: string
	onTextChange?: (value: string) => void
	showText?: boolean
	TextInput?: ComponentType<TextInputProps>
	textPlaceholder?: string
	buttonStyle?: 'primary' | 'secondary'
	onButtonStyleChange?: (style: 'primary' | 'secondary') => void
}) {
	const { _ } = useLingui()
	const builder = useContext(SiteLinkBuilderContext)
	const pages = builder.pages
	const link = normalizeSiteLink(value, pages)
	const typeId = useId()
	const openInLabelId = useId()
	const styleLabelId = useId()
	const fileInputRef = useRef<HTMLInputElement>(null)
	const pendingUploadRef = useRef(false)
	const pendingFileRef = useRef<Omit<SiteLinkFile, 'url'> | null>(null)
	const linkRef = useRef(link)
	linkRef.current = link
	const onChangeRef = useRef(onChange)
	onChangeRef.current = onChange
	const [pendingPreview, setPendingPreview] = useState<string | null>(null)

	const commit = (next: SiteLink) => {
		onChange({
			...next,
			href: computeSiteLinkHref(next, pages),
		})
	}

	useEffect(() => {
		if (
			pendingUploadRef.current &&
			builder.uploadedAssetUrl &&
			!builder.isUploadingAsset
		) {
			pendingUploadRef.current = false
			const meta = pendingFileRef.current
			pendingFileRef.current = null
			setPendingPreview(null)
			onChangeRef.current({
				...linkRef.current,
				type: 'file',
				file: {
					url: builder.uploadedAssetUrl,
					name: meta?.name || 'File',
					size: meta?.size,
					width: meta?.width,
					height: meta?.height,
				},
				href: builder.uploadedAssetUrl,
			})
		}
	}, [builder.uploadedAssetUrl, builder.isUploadingAsset])

	useEffect(() => {
		return () => {
			if (pendingPreview) URL.revokeObjectURL(pendingPreview)
		}
	}, [pendingPreview])

	const patch = (partial: Partial<SiteLink>) => {
		commit({ ...link, ...partial })
	}

	const handleFile = async (file: File) => {
		if (pendingPreview) URL.revokeObjectURL(pendingPreview)
		const preview = file.type.startsWith('image/')
			? URL.createObjectURL(file)
			: null
		setPendingPreview(preview)
		const size = await readImageSize(file)
		pendingFileRef.current = {
			name: file.name,
			size: file.size,
			width: size?.width,
			height: size?.height,
		}
		pendingUploadRef.current = true
		builder.onUploadAsset?.(file)
	}

	const selectedType = typeMeta(link.type)
	const showOpenIn =
		link.type === 'url' || link.type === 'page' || link.type === 'file'
	const showPreload = link.type === 'url' || link.type === 'page'
	const file = link.file
	const filePreviewSrc =
		pendingPreview || (file && isPreviewableImage(file) ? file.url : null)
	const dimensions =
		file?.width && file.height ? `${file.width} × ${file.height}px` : null
	const sizeLabel = formatFileSize(file?.size)

	return (
		<div className="space-y-2.5">
			<InspectorRow label={_(t`Type`)} htmlFor={typeId}>
				<Select
					value={link.type}
					onValueChange={(next) => {
						if (isSiteLinkType(next)) commit(applyType(link, next, pages))
					}}
				>
					<SelectTrigger id={typeId} size="sm" className="w-full">
						<SelectValue>
							<span className="flex min-w-0 items-center gap-1.5">
								<Icon
									name={selectedType.icon}
									className="text-muted-foreground size-3.5"
								/>
								<span className="truncate">{selectedType.label}</span>
							</span>
						</SelectValue>
					</SelectTrigger>
					<SelectContent align="start" alignItemWithTrigger={false}>
						{LINK_TYPE_META.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								<Icon name={option.icon} />
								{option.value === 'url' ? (
									<Trans>URL</Trans>
								) : option.value === 'page' ? (
									<Trans>Page</Trans>
								) : option.value === 'email' ? (
									<Trans>Email</Trans>
								) : option.value === 'phone' ? (
									<Trans>Phone</Trans>
								) : (
									<Trans>File</Trans>
								)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</InspectorRow>

			{onButtonStyleChange ? (
				<InspectorRow label={_(t`Style`)}>
					<span id={styleLabelId} className="sr-only">
						<Trans>Style</Trans>
					</span>
					<SegmentedControl
						labelledBy={styleLabelId}
						value={buttonStyle ?? 'primary'}
						onChange={(next) =>
							onButtonStyleChange(
								next === 'secondary' ? 'secondary' : 'primary',
							)
						}
						options={[
							{ value: 'primary', label: <Trans>Primary</Trans> },
							{ value: 'secondary', label: <Trans>Secondary</Trans> },
						]}
					/>
				</InspectorRow>
			) : null}

			<div
				key={link.type}
				className="space-y-2.5 motion-safe:animate-[link-inspector-in_160ms_cubic-bezier(0.19,1,0.22,1)] motion-reduce:animate-none"
			>
				{link.type === 'url' ? (
					<InspectorRow label={_(t`URL`)}>
						<Input
							value={link.url === '#' ? '#' : (link.url ?? '')}
							onChange={(event) => patch({ url: event.target.value })}
							placeholder="#"
							inputMode="url"
							autoComplete="off"
							spellCheck={false}
						/>
					</InspectorRow>
				) : null}

				{link.type === 'page' ? (
					<InspectorRow label={_(t`Page`)}>
						<Select
							value={link.pageId || null}
							onValueChange={(pageId) => {
								if (!pageId) {
									patch({ pageId: undefined, pageSlug: undefined })
									return
								}
								const page = pages.find((item) => item.id === pageId)
								patch({
									pageId,
									pageSlug: page?.slug,
								})
							}}
							items={[
								{ label: _(t`Choose a page...`), value: null },
								...pages.map((page) => ({
									label: page.title,
									value: page.id,
								})),
							]}
						>
							<SelectTrigger size="sm" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="start" alignItemWithTrigger={false}>
								{pages.length === 0 ? (
									<SelectItem value="__empty" disabled>
										<Trans>No pages yet</Trans>
									</SelectItem>
								) : (
									pages.map((page) => (
										<SelectItem key={page.id} value={page.id}>
											{page.title}
											{page.isHomePage ? (
												<span className="text-muted-foreground ml-1.5 text-xs">
													<Trans>Home</Trans>
												</span>
											) : null}
										</SelectItem>
									))
								)}
							</SelectContent>
						</Select>
					</InspectorRow>
				) : null}

				{link.type === 'email' ? (
					<>
						<InspectorRow label={_(t`Email`)}>
							<Input
								type="email"
								value={link.email ?? ''}
								onChange={(event) => patch({ email: event.target.value })}
								placeholder={_(t`e.g. bob@gmail.com`)}
								autoComplete="off"
							/>
						</InspectorRow>
						<InspectorRow label={_(t`Subject`)}>
							<Input
								value={link.subject ?? ''}
								onChange={(event) => patch({ subject: event.target.value })}
								placeholder={_(t`e.g. You've got mail!`)}
							/>
						</InspectorRow>
					</>
				) : null}

				{link.type === 'phone' ? (
					<>
						<InspectorRow label={_(t`Phone`)}>
							<Input
								type="tel"
								value={link.phone ?? ''}
								onChange={(event) => patch({ phone: event.target.value })}
								placeholder={_(t`e.g. +14155551212`)}
								autoComplete="off"
							/>
						</InspectorRow>
						<div className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3">
							<span />
							<p className="bg-muted text-muted-foreground rounded-lg px-3 py-2 text-xs leading-relaxed">
								<Trans>
									Phone links only work on devices that can place phone calls.
								</Trans>
							</p>
						</div>
					</>
				) : null}

				{link.type === 'file' ? (
					<InspectorRow label={_(t`Asset`)}>
						<div className="border-border overflow-hidden rounded-lg border">
							<input
								ref={fileInputRef}
								type="file"
								className="sr-only"
								accept="image/*,application/pdf,image/svg+xml,.svg,.pdf,.zip,.txt,.csv,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
								onChange={(event) => {
									const nextFile = event.currentTarget.files?.[0]
									if (nextFile) void handleFile(nextFile)
									event.currentTarget.value = ''
								}}
							/>
							{file?.url || pendingPreview ? (
								<div className="p-2">
									<div className="flex items-center gap-2.5">
										<span className="border-border bg-muted flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border">
											{filePreviewSrc ? (
												<img
													src={filePreviewSrc}
													alt=""
													className="size-full object-contain"
												/>
											) : (
												<Icon
													name="file-text"
													className="text-muted-foreground size-4"
												/>
											)}
										</span>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-xs font-medium">
												{file?.name || _(t`Uploading…`)}
											</span>
											<span className="text-muted-foreground mt-0.5 block text-[11px]">
												{[dimensions, sizeLabel].filter(Boolean).join(' · ')}
											</span>
										</span>
									</div>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="mt-2 w-full"
										disabled={builder.isUploadingAsset}
										onClick={() => fileInputRef.current?.click()}
									>
										{builder.isUploadingAsset ? (
											<Spinner className="size-3.5" />
										) : null}
										<Trans>Replace Asset...</Trans>
									</Button>
								</div>
							) : (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-9 w-full justify-start rounded-lg px-2.5"
									disabled={builder.isUploadingAsset}
									onClick={() => fileInputRef.current?.click()}
								>
									{builder.isUploadingAsset ? (
										<Spinner className="size-3.5" />
									) : (
										<Icon name="paperclip" className="size-3.5" />
									)}
									<Trans>Choose file...</Trans>
								</Button>
							)}
							{builder.uploadError && pendingUploadRef.current ? (
								<p className="text-destructive px-2 pb-2 text-xs" role="alert">
									{builder.uploadError}
								</p>
							) : null}
						</div>
					</InspectorRow>
				) : null}
			</div>

			{showOpenIn ? (
				<InspectorRow label={_(t`Open in`)}>
					<span id={openInLabelId} className="sr-only">
						<Trans>Open in</Trans>
					</span>
					<SegmentedControl
						labelledBy={openInLabelId}
						value={link.openIn ?? 'self'}
						onChange={(next) => patch({ openIn: next as SiteLinkOpenIn })}
						options={[
							{ value: 'self', label: <Trans>This tab</Trans> },
							{ value: 'blank', label: <Trans>New tab</Trans> },
						]}
					/>
				</InspectorRow>
			) : null}

			{showPreload ? (
				<InspectorRow label={_(t`Preload`)}>
					<Select
						value={link.preload ?? 'default'}
						items={{
							default: <Trans>Default</Trans>,
							prefetch: <Trans>Prefetch</Trans>,
							prerender: <Trans>Prerender</Trans>,
							none: <Trans>None</Trans>,
						}}
						onValueChange={(next) =>
							patch({ preload: (next as SiteLinkPreload) || 'default' })
						}
					>
						<SelectTrigger size="sm" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="start" alignItemWithTrigger={false}>
							{PRELOAD_OPTIONS.map((option) => (
								<SelectItem key={option} value={option}>
									{option === 'default' ? (
										<Trans>Default</Trans>
									) : option === 'prefetch' ? (
										<Trans>Prefetch</Trans>
									) : option === 'prerender' ? (
										<Trans>Prerender</Trans>
									) : (
										<Trans>None</Trans>
									)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</InspectorRow>
			) : null}

			{showText && onTextChange ? (
				<InspectorRow label={_(t`Text`)}>
					<TextInput
						value={text ?? ''}
						onChange={onTextChange}
						placeholder={textPlaceholder ?? _(t`Link`)}
					/>
				</InspectorRow>
			) : null}
		</div>
	)
}
