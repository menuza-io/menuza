import { Button, Input, Select } from '@cloudflare/kumo'
import { MediaPickerModal } from '@emdash-cms/admin'
import {
	File,
	Globe,
	Image as ImageIcon,
	LinkSimple,
	Mailbox,
	Phone,
	VideoCamera,
	X,
} from '@phosphor-icons/react'
import { apiFetch, parseApiResponse } from 'emdash/plugin-utils'
import * as React from 'react'

import {
	type MarketingLinkValue,
	type MarketingLinkType,
	buildHrefFromLink,
	isMarketingLinkValue,
	parseLinkValue,
} from '../content-links'

export interface LinkSettingsFieldProps {
	value: unknown
	onChange: (value: MarketingLinkValue) => void
	label?: string
	pluginId?: string
}

const TYPE_OPTIONS: Array<{
	value: MarketingLinkType
	label: string
	icon: React.ReactNode
}> = [
	{ value: 'url', label: 'URL', icon: <LinkSimple className="h-4 w-4" /> },
	{ value: 'page', label: 'Page', icon: <File className="h-4 w-4" /> },
	{ value: 'post', label: 'Post', icon: <File className="h-4 w-4" /> },
	{ value: 'email', label: 'Email', icon: <Mailbox className="h-4 w-4" /> },
	{ value: 'tel', label: 'Phone', icon: <Phone className="h-4 w-4" /> },
	{ value: 'file', label: 'File', icon: <Globe className="h-4 w-4" /> },
]

const OPEN_IN_TYPES: MarketingLinkType[] = ['url', 'page', 'post', 'file']

const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i
const VIDEO_URL_RE = /\.(mp4|webm|ogg|mov|m4v)(\?|$)/i

interface PickerOption {
	id: string
	name: string
}

interface MediaPickerItem {
	id: string
	url?: string
	storageKey?: string
	provider?: string
	filename?: string
	mimeType?: string
}

function isSafePreviewUrl(url: string): boolean {
	if (!url) return false
	if (HAS_SCHEME_RE.test(url)) {
		try {
			const parsed = new URL(url)
			return parsed.protocol === 'http:' || parsed.protocol === 'https:'
		} catch {
			return false
		}
	}
	return url.startsWith('/') && !url.startsWith('//')
}

function isVideoPreviewUrl(url: string): boolean {
	return VIDEO_URL_RE.test(url) || url.includes('/video')
}

function mediaItemToUrl(item: MediaPickerItem): string | undefined {
	const isLocalMedia = item.provider === 'local' || Boolean(item.storageKey)
	const localKey = item.storageKey || item.id
	return isLocalMedia && localKey
		? `/_emdash/api/media/file/${localKey}`
		: item.url
}

async function fetchPickerOptions(
	pluginId: string,
	route: string,
): Promise<PickerOption[]> {
	const res = await apiFetch(`/_emdash/api/plugins/${pluginId}/${route}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({}),
	})
	const data = await parseApiResponse<{ items: PickerOption[] }>(
		res,
		'Failed to load link options',
	)
	return data.items ?? []
}

function LinkPickerSelect({
	label,
	value,
	optionsRoute,
	pluginId,
	placeholder,
	onChange,
}: {
	label: string
	value: string
	optionsRoute: string
	pluginId: string
	placeholder: string
	onChange: (value: string) => void
}) {
	const [options, setOptions] = React.useState<PickerOption[]>([])
	const [loading, setLoading] = React.useState(true)

	React.useEffect(() => {
		const controller = new AbortController()
		setLoading(true)
		fetchPickerOptions(pluginId, optionsRoute)
			.then((items) => {
				if (!controller.signal.aborted) setOptions(items)
			})
			.catch(() => {
				if (!controller.signal.aborted) setOptions([])
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
		return () => controller.abort()
	}, [optionsRoute, pluginId])

	const items: Record<string, string> = {
		'': placeholder,
		...Object.fromEntries(options.map((opt) => [opt.id, opt.name])),
	}

	return (
		<Select
			label={label}
			value={value}
			onValueChange={(next) => onChange(next ?? '')}
			items={items}
			disabled={loading}
		/>
	)
}

function OpenInToggle({
	target,
	onChange,
}: {
	target: MarketingLinkValue['target']
	onChange: (target: MarketingLinkValue['target']) => void
}) {
	const active = target === '_blank' ? 'new' : 'same'
	return (
		<div>
			<span className="mb-1.5 block text-sm font-medium">Open in</span>
			<div className="border-kumo-line bg-kumo-control flex rounded-md border p-0.5">
				<button
					type="button"
					className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
						active === 'same'
							? 'bg-kumo-base text-foreground shadow-sm'
							: 'text-kumo-subtle hover:text-foreground'
					}`}
					onClick={() => onChange('_self')}
				>
					This tab
				</button>
				<button
					type="button"
					className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
						active === 'new'
							? 'bg-kumo-base text-foreground shadow-sm'
							: 'text-kumo-subtle hover:text-foreground'
					}`}
					onClick={() => onChange('_blank')}
				>
					New tab
				</button>
			</div>
		</div>
	)
}

/** Same media library UX as section `media_picker` fields (image + video). */
function LinkFileMediaField({
	value,
	onChange,
}: {
	value: string
	onChange: (url: string) => void
}) {
	const [pickerOpen, setPickerOpen] = React.useState(false)
	const [previewBroken, setPreviewBroken] = React.useState(false)
	const url = value.trim()
	const canPreview = isSafePreviewUrl(url)
	const isVideo = canPreview && isVideoPreviewUrl(url)

	React.useEffect(() => {
		setPreviewBroken(false)
	}, [url])

	const handleSelect = (item: MediaPickerItem) => {
		const nextUrl = mediaItemToUrl(item)
		if (nextUrl) onChange(nextUrl)
	}

	const pickerActions = (
		<div className="pointer-events-none absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
			<Button
				type="button"
				size="sm"
				variant="secondary"
				onClick={() => setPickerOpen(true)}
			>
				Change
			</Button>
			<Button
				type="button"
				shape="square"
				variant="destructive"
				className="h-8 w-8"
				onClick={() => onChange('')}
				aria-label="Remove"
			>
				<X className="h-4 w-4" />
			</Button>
		</div>
	)

	return (
		<div className="space-y-2">
			<span className="mb-1.5 block text-sm font-medium">Asset</span>
			{canPreview && !previewBroken ? (
				<div className="group relative">
					{isVideo ? (
						<video
							src={url}
							className="border-kumo-line bg-kumo-muted max-h-40 min-h-20 w-full rounded-md border object-contain"
							controls
							preload="metadata"
							onError={() => setPreviewBroken(true)}
						/>
					) : (
						<img
							src={url}
							alt=""
							className="border-kumo-line bg-kumo-muted max-h-40 min-h-20 w-full rounded-md border object-contain"
							referrerPolicy="no-referrer"
							loading="lazy"
							onError={() => setPreviewBroken(true)}
						/>
					)}
					{pickerActions}
				</div>
			) : canPreview && previewBroken ? (
				<div className="group relative min-h-20">
					<div className="border-kumo-line bg-kumo-muted text-kumo-subtle flex min-h-20 w-full items-center justify-center gap-2 rounded-md border">
						<ImageIcon className="h-5 w-5" />
						<span className="text-sm">Preview not available</span>
					</div>
					{pickerActions}
				</div>
			) : (
				<Button
					type="button"
					variant="outline"
					className="h-24 w-full justify-center rounded-lg border-dashed"
					onClick={() => setPickerOpen(true)}
				>
					<div className="text-kumo-subtle flex flex-col items-center gap-1.5">
						<div className="flex items-center gap-2">
							<ImageIcon className="h-6 w-6" />
							<VideoCamera className="h-6 w-6" />
						</div>
						<span className="text-sm">Select media</span>
					</div>
				</Button>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilters={['image/', 'video/']}
				title="Select media"
			/>
		</div>
	)
}

export default function LinkSettingsField({
	value,
	onChange,
	label = 'Link',
	pluginId = 'marketing-blocks',
}: LinkSettingsFieldProps) {
	const link = React.useMemo(() => parseLinkValue(value), [value])

	const update = (patch: Partial<MarketingLinkValue>) => {
		const next = { ...link, ...patch }
		if (patch.type && patch.type !== link.type) {
			onChange({
				type: patch.type,
				target: next.target ?? '_self',
			})
			return
		}
		onChange(next)
	}

	const typeItems = Object.fromEntries(
		TYPE_OPTIONS.map((opt) => [opt.value, opt.label]),
	)

	const resolvedHref = isMarketingLinkValue(value)
		? buildHrefFromLink(link)
		: typeof value === 'string'
			? value
			: ''

	return (
		<div className="border-kumo-line space-y-4 rounded-lg border p-3">
			<span className="text-sm font-medium">{label}</span>

			<Select
				label="Type"
				value={link.type}
				onValueChange={(next) =>
					update({ type: (next as MarketingLinkType) ?? 'url' })
				}
				items={typeItems}
			/>

			{link.type === 'url' && (
				<Input
					label="URL"
					placeholder="# or https://example.com"
					value={link.url ?? ''}
					onChange={(e) => update({ url: e.target.value })}
				/>
			)}

			{link.type === 'page' && (
				<LinkPickerSelect
					label="Page"
					value={link.page ?? ''}
					optionsRoute="content-link-pages"
					pluginId={pluginId}
					placeholder="Choose a page…"
					onChange={(page) => update({ page })}
				/>
			)}

			{link.type === 'post' && (
				<LinkPickerSelect
					label="Post"
					value={link.post ?? ''}
					optionsRoute="content-link-posts"
					pluginId={pluginId}
					placeholder="Choose a post…"
					onChange={(post) => update({ post })}
				/>
			)}

			{link.type === 'email' && (
				<>
					<Input
						label="Email"
						placeholder="e.g. bob@gmail.com"
						value={link.email ?? ''}
						onChange={(e) => update({ email: e.target.value })}
					/>
					<Input
						label="Subject"
						placeholder="e.g. You've got mail!"
						value={link.emailSubject ?? ''}
						onChange={(e) => update({ emailSubject: e.target.value })}
					/>
				</>
			)}

			{link.type === 'tel' && (
				<>
					<Input
						label="Phone"
						placeholder="e.g. +14155551212"
						value={link.tel ?? ''}
						onChange={(e) => update({ tel: e.target.value })}
					/>
					<p className="text-kumo-subtle text-sm">
						Phone links only work on devices that can place phone calls.
					</p>
				</>
			)}

			{link.type === 'file' && (
				<LinkFileMediaField
					value={link.file ?? ''}
					onChange={(file) => update({ file })}
				/>
			)}

			{OPEN_IN_TYPES.includes(link.type) && (
				<OpenInToggle
					target={link.target ?? '_self'}
					onChange={(target) => update({ target })}
				/>
			)}

			{resolvedHref && (
				<p className="text-kumo-subtle text-xs">
					Resolved: <span className="font-mono">{resolvedHref}</span>
				</p>
			)}
		</div>
	)
}
