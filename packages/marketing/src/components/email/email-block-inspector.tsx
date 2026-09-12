import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	EMAIL_HEADING_LEVELS,
	type EmailBlock,
	type EmailBlockAlignment,
	type EmailButtonVariant,
	type EmailButtonWidth,
	type EmailHeadingLevel,
} from '@repo/common/email-blocks'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import { type ReactNode } from 'react'

import { useEmailBlockTypes } from './block-meta.ts'
import { MergeTagField } from './merge-tag-field.tsx'

type InspectorProps = {
	block: EmailBlock
	onUpdate: (patch: Record<string, unknown>) => void
	onBack: () => void
	onRemove: () => void
}

function Field({
	label,
	children,
	htmlFor,
}: {
	label: ReactNode
	children: ReactNode
	htmlFor?: string
}) {
	return (
		<div className="space-y-2">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
		</div>
	)
}

function Segmented<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T
	options: Array<{ value: T; label: ReactNode }>
	onChange: (value: T) => void
}) {
	return (
		<div className="border-border inline-flex rounded-lg border p-0.5">
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => onChange(option.value)}
					className={cn(
						'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
						value === option.value
							? 'bg-muted text-foreground'
							: 'text-muted-foreground hover:text-foreground',
					)}
				>
					{option.label}
				</button>
			))}
		</div>
	)
}

const ALIGN_OPTIONS: Array<{
	value: EmailBlockAlignment
	label: ReturnType<typeof msg>
}> = [
	{ value: 'left', label: msg`Left` },
	{ value: 'center', label: msg`Center` },
	{ value: 'right', label: msg`Right` },
]

const BUTTON_VARIANT_OPTIONS: Array<{
	value: EmailButtonVariant
	label: ReturnType<typeof msg>
}> = [
	{ value: 'primary', label: msg`Solid` },
	{ value: 'outline', label: msg`Outline` },
]

const BUTTON_WIDTH_OPTIONS: Array<{
	value: EmailButtonWidth
	label: ReturnType<typeof msg>
}> = [
	{ value: 'auto', label: msg`Auto` },
	{ value: 'full', label: msg`Full width` },
]

export function EmailBlockInspector({
	block,
	onUpdate,
	onBack,
	onRemove,
}: InspectorProps) {
	const { _ } = useLingui()
	const { getBlockType } = useEmailBlockTypes()
	const meta = getBlockType(block.type)

	const alignOptions = ALIGN_OPTIONS.map((option) => ({
		value: option.value,
		label: _(option.label),
	}))

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<Button
					variant="ghost"
					size="icon-xs"
					onClick={onBack}
					aria-label={_(msg`Back to blocks`)}
				>
					<Icon name="chevron-left" className="size-4" />
				</Button>
				<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
					<Icon name={meta.icon} className="size-3.5" />
				</span>
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{meta.label}
				</span>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					onClick={onRemove}
					aria-label={_(msg`Remove block`)}
				>
					<Icon name="trash-2" className="size-4" />
				</Button>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="space-y-4 p-4">
					{block.type === 'heading' ? (
						<>
							<Field label={<Trans>Text</Trans>} htmlFor="block-heading-text">
								<MergeTagField
									id="block-heading-text"
									value={block.config.text}
									onChange={(text) => onUpdate({ text })}
									placeholder={_(msg`Add a heading`)}
								/>
							</Field>
							<Field label={<Trans>Size</Trans>}>
								<Segmented<EmailHeadingLevel>
									value={block.config.level}
									options={EMAIL_HEADING_LEVELS.map((level) => ({
										value: level,
										label: level.toUpperCase(),
									}))}
									onChange={(level) => onUpdate({ level })}
								/>
							</Field>
							<Field label={<Trans>Alignment</Trans>}>
								<Segmented<EmailBlockAlignment>
									value={block.config.align}
									options={alignOptions}
									onChange={(align) => onUpdate({ align })}
								/>
							</Field>
						</>
					) : null}

					{block.type === 'body' || block.type === 'paragraph' ? (
						<>
							<Field label={<Trans>Text</Trans>} htmlFor="block-text">
								<MergeTagField
									id="block-text"
									multiline
									rows={6}
									value={block.config.text}
									onChange={(text) => onUpdate({ text })}
									placeholder={_(msg`Write your message`)}
								/>
							</Field>
							{block.type === 'body' || block.type === 'paragraph' ? (
								<Field label={<Trans>Alignment</Trans>}>
									<Segmented<EmailBlockAlignment>
										value={block.config.align}
										options={alignOptions}
										onChange={(align) => onUpdate({ align })}
									/>
								</Field>
							) : null}
						</>
					) : null}

					{block.type === 'image' ? (
						<>
							<Field label={<Trans>Image URL</Trans>} htmlFor="block-image-url">
								<Input
									id="block-image-url"
									placeholder="https://"
									value={block.config.url}
									onChange={(event) => onUpdate({ url: event.target.value })}
								/>
							</Field>
							<Field label={<Trans>Alt text</Trans>} htmlFor="block-image-alt">
								<Input
									id="block-image-alt"
									value={block.config.alt}
									onChange={(event) => onUpdate({ alt: event.target.value })}
								/>
							</Field>
							<Field
								label={<Trans>Link (optional)</Trans>}
								htmlFor="block-image-href"
							>
								<Input
									id="block-image-href"
									placeholder="https://"
									value={block.config.href}
									onChange={(event) => onUpdate({ href: event.target.value })}
								/>
							</Field>
							<Field
								label={
									<span className="flex w-full items-center justify-between">
										<Trans>Width</Trans>
										<span className="text-muted-foreground font-mono text-xs">
											{block.config.width}%
										</span>
									</span>
								}
								htmlFor="block-image-width"
							>
								<input
									id="block-image-width"
									type="range"
									min={10}
									max={100}
									step={5}
									value={block.config.width}
									onChange={(event) =>
										onUpdate({ width: Number(event.target.value) })
									}
									className="accent-primary w-full"
								/>
							</Field>
							<Field label={<Trans>Alignment</Trans>}>
								<Segmented<EmailBlockAlignment>
									value={block.config.align}
									options={alignOptions}
									onChange={(align) => onUpdate({ align })}
								/>
							</Field>
						</>
					) : null}

					{block.type === 'button' ? (
						<>
							<Field label={<Trans>Label</Trans>} htmlFor="block-button-label">
								<MergeTagField
									id="block-button-label"
									value={block.config.label}
									onChange={(label) => onUpdate({ label })}
									placeholder={_(msg`Button label`)}
								/>
							</Field>
							<Field label={<Trans>Link</Trans>} htmlFor="block-button-url">
								<Input
									id="block-button-url"
									placeholder="https://"
									value={block.config.url}
									onChange={(event) => onUpdate({ url: event.target.value })}
								/>
							</Field>
							<Field label={<Trans>Style</Trans>}>
								<Segmented<EmailButtonVariant>
									value={block.config.variant}
									options={BUTTON_VARIANT_OPTIONS.map((option) => ({
										value: option.value,
										label: _(option.label),
									}))}
									onChange={(variant) => onUpdate({ variant })}
								/>
							</Field>
							<Field label={<Trans>Width</Trans>}>
								<Segmented<EmailButtonWidth>
									value={block.config.width}
									options={BUTTON_WIDTH_OPTIONS.map((option) => ({
										value: option.value,
										label: _(option.label),
									}))}
									onChange={(width) => onUpdate({ width })}
								/>
							</Field>
							{block.config.width === 'full' ? null : (
								<Field label={<Trans>Alignment</Trans>}>
									<Segmented<EmailBlockAlignment>
										value={block.config.align}
										options={alignOptions}
										onChange={(align) => onUpdate({ align })}
									/>
								</Field>
							)}
						</>
					) : null}
				</div>
			</ScrollArea>
		</div>
	)
}
