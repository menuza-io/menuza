import { Trans } from '@lingui/macro'
import { FEATURE_ICON_KEYS } from '@repo/common/site-motion'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { LocalizedInput } from '#app/components/website/locale-fields.tsx'

type Update = (key: string, value: unknown) => void

function Field({
	label,
	value,
	onChange,
}: {
	label: string
	value: string
	onChange: (value: string) => void
}) {
	return (
		<div className="space-y-1.5">
			<Label className="text-muted-foreground text-xs font-medium">
				{label}
			</Label>
			<LocalizedInput value={value} onChange={onChange} />
		</div>
	)
}

export function MenuHighlightsEditor({
	config,
	updateField,
}: {
	config: Record<string, unknown>
	updateField: Update
}) {
	const source = (config.source as string) || 'popular'
	const itemIds = Array.isArray(config.itemIds)
		? (config.itemIds as string[]).join('\n')
		: ''
	return (
		<div className="space-y-4">
			<Field
				label="Heading"
				value={(config.heading as string) ?? ''}
				onChange={(value) => updateField('heading', value)}
			/>
			<Field
				label="Subtitle"
				value={(config.subtitle as string) ?? ''}
				onChange={(value) => updateField('subtitle', value)}
			/>
			<div className="space-y-1.5">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Dishes</Trans>
				</Label>
				<Select
					value={source}
					onValueChange={(value) => updateField('source', value)}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="popular">
							<Trans>Popular this week</Trans>
						</SelectItem>
						<SelectItem value="category">
							<Trans>A category</Trans>
						</SelectItem>
						<SelectItem value="picked">
							<Trans>Dishes I pick</Trans>
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{source === 'category' ? (
				<div className="space-y-1.5">
					<Label className="text-muted-foreground text-xs font-medium">
						<Trans>Category id</Trans>
					</Label>
					<Input
						value={(config.categoryId as string) ?? ''}
						onChange={(event) => updateField('categoryId', event.target.value)}
					/>
				</div>
			) : null}
			{source === 'picked' ? (
				<div className="space-y-1.5">
					<Label className="text-muted-foreground text-xs font-medium">
						<Trans>Dish ids, one per line, in order</Trans>
					</Label>
					<textarea
						className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 text-sm"
						value={itemIds}
						onChange={(event) =>
							updateField(
								'itemIds',
								event.target.value
									.split('\n')
									.map((id) => id.trim())
									.filter(Boolean),
							)
						}
					/>
				</div>
			) : null}
			<div className="space-y-1.5">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Layout</Trans>
				</Label>
				<Select
					value={(config.layout as string) || 'row'}
					onValueChange={(value) => updateField('layout', value)}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="row">
							<Trans>Row</Trans>
						</SelectItem>
						<SelectItem value="grid">
							<Trans>Grid</Trans>
						</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Prices, photos and names come from the menu when the page is viewed. A
					price change shows up without publishing again.
				</Trans>
			</p>
		</div>
	)
}

export function LocationsHoursEditor({
	config,
	updateField,
}: {
	config: Record<string, unknown>
	updateField: Update
}) {
	const ids = Array.isArray(config.locationIds)
		? (config.locationIds as string[]).join('\n')
		: ''
	return (
		<div className="space-y-4">
			<Field
				label="Heading"
				value={(config.heading as string) ?? ''}
				onChange={(value) => updateField('heading', value)}
			/>
			<div className="space-y-1.5">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Location ids, one per line. Leave empty for all.</Trans>
				</Label>
				<textarea
					className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 text-sm"
					value={ids}
					onChange={(event) =>
						updateField(
							'locationIds',
							event.target.value
								.split('\n')
								.map((id) => id.trim())
								.filter(Boolean),
						)
					}
				/>
			</div>
		</div>
	)
}

export function ContactSectionEditor({
	config,
	updateField,
}: {
	config: Record<string, unknown>
	updateField: Update
}) {
	return (
		<div className="space-y-4">
			<Field
				label="Heading"
				value={(config.heading as string) ?? ''}
				onChange={(value) => updateField('heading', value)}
			/>
			<Field
				label="Intro"
				value={(config.intro as string) ?? ''}
				onChange={(value) => updateField('intro', value)}
			/>
			<div className="space-y-1.5">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Email</Trans>
				</Label>
				<Input
					value={(config.email as string) ?? ''}
					onChange={(event) => updateField('email', event.target.value)}
				/>
			</div>
			<div className="space-y-1.5">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>Form id</Trans>
				</Label>
				<Input
					value={(config.formId as string) ?? ''}
					onChange={(event) => {
						updateField('formId', event.target.value)
						updateField('showForm', event.target.value.trim().length > 0)
					}}
				/>
			</div>
		</div>
	)
}

export function MenuFileEditor({
	config,
	updateField,
}: {
	config: Record<string, unknown>
	updateField: Update
}) {
	return (
		<div className="space-y-4">
			<Field
				label="Heading"
				value={(config.heading as string) ?? ''}
				onChange={(value) => updateField('heading', value)}
			/>
			<Field
				label="Button"
				value={(config.buttonLabel as string) ?? ''}
				onChange={(value) => updateField('buttonLabel', value)}
			/>
			<div className="space-y-1.5">
				<Label className="text-muted-foreground text-xs font-medium">
					<Trans>PDF URL from the media library, up to 20 MB</Trans>
				</Label>
				<Input
					value={(config.fileUrl as string) ?? ''}
					onChange={(event) => updateField('fileUrl', event.target.value)}
				/>
			</div>
		</div>
	)
}

export function ScrollingStripEditor({
	config,
	updateField,
}: {
	config: Record<string, unknown>
	updateField: Update
}) {
	const items = Array.isArray(config.items)
		? (config.items as Array<{ text?: string }>)
		: []
	return (
		<div className="space-y-3">
			{items.map((item, index) => (
				<Field
					key={index}
					label={`Message ${index + 1}`}
					value={item.text ?? ''}
					onChange={(value) => {
						const next = items.map((entry, entryIndex) =>
							entryIndex === index ? { ...entry, text: value } : entry,
						)
						updateField('items', next)
					}}
				/>
			))}
			<button
				type="button"
				className="text-sm underline"
				onClick={() => updateField('items', [...items, { text: '' }])}
			>
				<Trans>Add message</Trans>
			</button>
		</div>
	)
}

export function HeroSlidesEditor({
	config,
	updateField,
}: {
	config: Record<string, unknown>
	updateField: Update
}) {
	const slides = Array.isArray(config.slides)
		? (config.slides as Array<{ url?: string; alt?: string }>)
		: []
	return (
		<div className="space-y-3">
			<p className="text-muted-foreground text-xs">
				<Trans>Up to 6 photos. The first loads immediately.</Trans>
			</p>
			{slides.map((slide, index) => (
				<div key={index} className="space-y-1.5">
					<Input
						value={slide.url ?? ''}
						placeholder="https://"
						onChange={(event) => {
							const next = slides.map((entry, entryIndex) =>
								entryIndex === index
									? { ...entry, url: event.target.value }
									: entry,
							)
							updateField('slides', next.slice(0, 6))
						}}
					/>
				</div>
			))}
			{slides.length < 6 ? (
				<button
					type="button"
					className="text-sm underline"
					onClick={() =>
						updateField('slides', [...slides, { url: '', alt: '' }].slice(0, 6))
					}
				>
					<Trans>Add photo</Trans>
				</button>
			) : null}
		</div>
	)
}

export function FeatureIconSelect({
	value,
	onChange,
}: {
	value: string
	onChange: (value: string) => void
}) {
	return (
		<div className="space-y-1.5">
			<Label className="text-muted-foreground text-xs font-medium">
				<Trans>Icon</Trans>
			</Label>
			<Select
				value={value || 'none'}
				onValueChange={(next) => onChange(next === 'none' || !next ? '' : next)}
			>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="none">
						<Trans>None</Trans>
					</SelectItem>
					{FEATURE_ICON_KEYS.map((icon) => (
						<SelectItem key={icon} value={icon}>
							{icon}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	)
}
