import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	buildEmailTemplateBlocks,
	EMAIL_BLOCK_TEMPLATES,
	getDefaultEmailBlock,
	type EmailBlock,
	type EmailBlockTemplateId,
	type EmailBlockType,
} from '@repo/common/email-blocks'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { ScrollArea } from '@repo/ui/scroll-area'
import { useEffect, useId, useRef, useState } from 'react'
import { useFetcher } from 'react-router'

import { AddEmailBlockDialog } from './add-email-block-dialog.tsx'
import { emailBlockPreviewText, useEmailBlockTypes } from './block-meta.ts'
import { EmailBlockInspector } from './email-block-inspector.tsx'
import { EmailPreview } from './email-preview.tsx'

/** Below this width the editor stacks (list above preview) instead of columns. */
const EDITOR_COLUMNS_MIN_WIDTH = 860
const EDITOR_SIDEBAR_WIDTH = 330

export type EmailBlockEditorProps = {
	blocks: EmailBlock[]
	onChange: (blocks: EmailBlock[]) => void
	/**
	 * Route action that renders blocks to `{ html }` with the current branding.
	 * Defaults to the route that renders the editor.
	 */
	previewEndpoint?: string
	subject?: string
	className?: string
}

function SortableEmailBlockCard({
	block,
	isSelected,
	onSelect,
	onRemove,
}: {
	block: EmailBlock
	isSelected: boolean
	onSelect: () => void
	onRemove: () => void
}) {
	const { _ } = useLingui()
	const { getBlockType } = useEmailBlockTypes()
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: block.id })
	const meta = getBlockType(block.type)
	const preview = emailBlockPreviewText(block)

	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Transform.toString(transform), transition }}
			className={cn(isDragging && 'z-10 opacity-80')}
		>
			<div
				className={cn(
					'group relative cursor-pointer rounded-lg px-2 py-2 transition-colors duration-150',
					isSelected
						? 'bg-muted'
						: 'hover:bg-muted/60 focus-within:bg-muted/60',
				)}
				onClick={onSelect}
				role="button"
				tabIndex={0}
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget) return
					if (event.key === 'Enter' || event.key === ' ') {
						event.preventDefault()
						onSelect()
					}
				}}
			>
				<div className="flex items-start gap-2">
					<span className="border-border/70 bg-background text-muted-foreground relative mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border">
						<button
							type="button"
							ref={setActivatorNodeRef}
							className={cn(
								'peer absolute inset-0 z-10 flex cursor-grab items-center justify-center rounded-md opacity-0 transition-opacity duration-150 active:cursor-grabbing',
								'group-hover:opacity-100 focus-visible:opacity-100',
							)}
							aria-label={_(msg`Drag to reorder`)}
							{...attributes}
							{...listeners}
						>
							<Icon name="grip-vertical" className="size-3.5" />
						</button>
						<Icon
							name={meta.icon}
							className={cn(
								'size-3.5 transition-opacity duration-150',
								'group-hover:opacity-0 peer-focus-visible:opacity-0',
								isDragging && 'opacity-0',
							)}
						/>
					</span>
					<div className="min-w-0 flex-1 pr-8">
						<div className="truncate text-sm font-medium">{meta.label}</div>
						{preview ? (
							<p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs leading-relaxed">
								{preview}
							</p>
						) : null}
					</div>
				</div>
				<div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
					<Button
						variant="ghost"
						size="icon-xs"
						className="text-destructive hover:text-destructive"
						aria-label={_(msg`Remove block`)}
						onClick={(event) => {
							event.stopPropagation()
							onRemove()
						}}
					>
						<Icon name="trash-2" className="size-3.5" />
					</Button>
				</div>
			</div>
		</div>
	)
}

function TemplatePicker({
	onSelect,
}: {
	onSelect: (templateId: EmailBlockTemplateId) => void
}) {
	return (
		<div className="space-y-3 p-3">
			<div className="space-y-1">
				<p className="text-sm font-medium">
					<Trans>Start with a template</Trans>
				</p>
				<p className="text-muted-foreground text-xs leading-relaxed">
					<Trans>Pick a layout, then customize the blocks.</Trans>
				</p>
			</div>
			<div className="grid grid-cols-2 gap-2">
				{EMAIL_BLOCK_TEMPLATES.map((template) => (
					<button
						key={template.id}
						type="button"
						onClick={() => onSelect(template.id)}
						className="border-border hover:bg-muted/50 focus-visible:ring-ring flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors outline-none focus-visible:ring-2"
					>
						<span className="text-sm font-medium tracking-tight">
							{template.label}
						</span>
						<span className="text-muted-foreground line-clamp-2 text-xs leading-snug">
							{template.description}
						</span>
					</button>
				))}
			</div>
		</div>
	)
}

function BlocksList({
	blocks,
	selectedBlockId,
	onSelect,
	onRemove,
	onReorder,
	onAdd,
	onApplyTemplate,
}: {
	blocks: EmailBlock[]
	selectedBlockId: string | null
	onSelect: (blockId: string) => void
	onRemove: (blockId: string) => void
	onReorder: (orderedIds: string[]) => void
	onAdd: (type: EmailBlockType, position: number) => void
	onApplyTemplate: (templateId: EmailBlockTemplateId) => void
}) {
	const { _ } = useLingui()
	const dndId = useId()
	const [isDragging, setIsDragging] = useState(false)

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor),
	)

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event
		setIsDragging(false)
		if (!over || active.id === over.id) return

		const oldIndex = blocks.findIndex((block) => block.id === active.id)
		const newIndex = blocks.findIndex((block) => block.id === over.id)
		if (oldIndex < 0 || newIndex < 0) return

		onReorder(arrayMove(blocks, oldIndex, newIndex).map((block) => block.id))
	}

	return (
		<>
			<div className="border-border flex items-center gap-2 border-b px-3 py-2.5">
				<span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
					<Icon name="blocks" className="size-3.5" />
				</span>
				<span className="min-w-0 truncate text-sm font-medium">
					<Trans>Blocks</Trans>
				</span>
				<span className="text-muted-foreground text-xs tabular-nums">
					{blocks.length}
				</span>
				<div className="flex-1" />
				{blocks.length > 0 ? (
					<AddEmailBlockDialog position={blocks.length} onAdd={onAdd} />
				) : null}
			</div>
			<ScrollArea className="min-h-0 flex-1">
				{blocks.length === 0 ? (
					<TemplatePicker onSelect={onApplyTemplate} />
				) : (
					<div className="mt-2 px-2 pb-2">
						<DndContext
							id={dndId}
							sensors={sensors}
							collisionDetection={closestCenter}
							modifiers={[restrictToVerticalAxis]}
							onDragStart={() => setIsDragging(true)}
							onDragCancel={() => setIsDragging(false)}
							onDragEnd={handleDragEnd}
						>
							<SortableContext
								items={blocks.map((block) => block.id)}
								strategy={verticalListSortingStrategy}
							>
								{blocks.map((block, index) => (
									<div key={block.id}>
										<div
											className={cn(isDragging && 'pointer-events-none')}
											aria-hidden={isDragging || undefined}
										>
											<AddEmailBlockDialog
												position={index}
												onAdd={onAdd}
												trigger="insert"
											/>
										</div>
										<SortableEmailBlockCard
											block={block}
											isSelected={selectedBlockId === block.id}
											onSelect={() => onSelect(block.id)}
											onRemove={() => onRemove(block.id)}
										/>
										{index === blocks.length - 1 ? (
											<div
												className={cn(isDragging && 'pointer-events-none')}
												aria-hidden={isDragging || undefined}
											>
												<AddEmailBlockDialog
													position={index + 1}
													onAdd={onAdd}
													trigger="insert"
												/>
											</div>
										) : null}
									</div>
								))}
							</SortableContext>
						</DndContext>
					</div>
				)}
			</ScrollArea>
		</>
	)
}

export function EmailBlockEditor({
	blocks,
	onChange,
	previewEndpoint,
	subject,
	className,
}: EmailBlockEditorProps) {
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const selected = blocks.find((block) => block.id === selectedId) ?? null

	// Switch to side-by-side only when this editor is actually wide enough; a
	// viewport breakpoint would clip the preview inside narrow hosts (e.g. a
	// form column or a small dialog).
	const containerRef = useRef<HTMLDivElement>(null)
	const [isWide, setIsWide] = useState(false)
	useEffect(() => {
		const element = containerRef.current
		if (!element) return
		const measure = () =>
			setIsWide(element.clientWidth >= EDITOR_COLUMNS_MIN_WIDTH)
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	const previewFetcher = useFetcher<{ html?: string }>()
	const [previewHtml, setPreviewHtml] = useState('')

	// Keep the latest fetcher in a ref so the debounce effect does not depend on
	// its (per-render) identity and re-submit in a loop.
	const previewFetcherRef = useRef(previewFetcher)
	previewFetcherRef.current = previewFetcher

	const blocksJson = JSON.stringify(blocks)

	useEffect(() => {
		const timeout = setTimeout(() => {
			previewFetcherRef.current.submit(
				{ intent: 'email_preview', blocks: blocksJson, subject: subject ?? '' },
				previewEndpoint
					? { method: 'post', action: previewEndpoint }
					: { method: 'post' },
			)
		}, 300)
		return () => clearTimeout(timeout)
	}, [blocksJson, subject, previewEndpoint])

	useEffect(() => {
		const html = previewFetcher.data?.html
		if (typeof html === 'string') {
			setPreviewHtml((current) => (current === html ? current : html))
		}
	}, [previewFetcher.data])

	const addBlock = (type: EmailBlockType, position: number) => {
		const block = getDefaultEmailBlock(type)
		const next = [...blocks]
		next.splice(position, 0, block)
		onChange(next)
		setSelectedId(block.id)
	}

	const updateBlock = (blockId: string, patch: Record<string, unknown>) => {
		onChange(
			blocks.map((block) =>
				block.id === blockId
					? ({ ...block, config: { ...block.config, ...patch } } as EmailBlock)
					: block,
			),
		)
	}

	const removeBlock = (blockId: string) => {
		onChange(blocks.filter((block) => block.id !== blockId))
		if (selectedId === blockId) setSelectedId(null)
	}

	const reorderBlocks = (orderedIds: string[]) => {
		const byId = new Map(blocks.map((block) => [block.id, block]))
		const ordered = orderedIds
			.map((id) => byId.get(id))
			.filter((block): block is EmailBlock => Boolean(block))
		const listed = new Set(orderedIds)
		const missing = blocks.filter((block) => !listed.has(block.id))
		onChange([...ordered, ...missing])
	}

	const applyTemplate = (templateId: EmailBlockTemplateId) => {
		const next = buildEmailTemplateBlocks(templateId)
		onChange(next)
		setSelectedId(next[0]?.id ?? null)
	}

	return (
		<div
			ref={containerRef}
			className={cn(
				// Blocks and preview are separate surfaces with the same gap as the
				// docked AI panel, so all three read as sibling sections.
				'flex min-h-0 min-w-0 gap-2',
				isWide ? 'flex-row' : 'flex-col',
				className,
			)}
		>
			<div
				data-slot="email-designer-section"
				data-section="blocks"
				className={cn(
					'bg-background border-border flex min-w-0 flex-col overflow-hidden rounded-xl border',
					isWide ? 'min-h-0 shrink-0' : 'max-h-[320px] shrink-0',
				)}
				style={isWide ? { width: EDITOR_SIDEBAR_WIDTH } : undefined}
			>
				{selected ? (
					<EmailBlockInspector
						block={selected}
						onUpdate={(patch) => updateBlock(selected.id, patch)}
						onBack={() => setSelectedId(null)}
						onRemove={() => removeBlock(selected.id)}
					/>
				) : (
					<BlocksList
						blocks={blocks}
						selectedBlockId={selectedId}
						onSelect={setSelectedId}
						onRemove={removeBlock}
						onReorder={reorderBlocks}
						onAdd={addBlock}
						onApplyTemplate={applyTemplate}
					/>
				)}
			</div>

			<div
				data-slot="email-designer-section"
				data-section="preview"
				className={cn(
					'bg-background border-border flex min-w-0 flex-col overflow-hidden rounded-xl border',
					isWide ? 'min-h-0 flex-1' : 'min-h-[320px] w-full flex-1',
				)}
			>
				<EmailPreview
					html={previewHtml}
					loading={previewFetcher.state !== 'idle'}
					framed={false}
				/>
			</div>
		</div>
	)
}
