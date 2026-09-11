import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	buildMergeToken,
	MERGE_TOKENS,
	mergeTagLabel,
	parseMergeSegments,
} from '@repo/common/merge-tags'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Popover, PopoverContent } from '@repo/ui/popover'
import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
	type ClipboardEvent,
	type KeyboardEvent,
	type MouseEvent,
} from 'react'

export type MergeTagFieldProps = {
	value: string
	onChange: (value: string) => void
	id?: string
	placeholder?: string
	/** Multi-line editors accept newlines; single-line ones swallow Enter. */
	multiline?: boolean
	rows?: number
	className?: string
	disabled?: boolean
}

type ActiveToken = {
	element: HTMLElement
	tag: string
}

const CHIP_CLASS =
	'mx-0.5 inline-block cursor-pointer rounded-md bg-primary/15 px-1.5 py-px text-[0.95em] font-medium text-primary ring-1 ring-primary/25 align-baseline'

function escapeText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
	return escapeText(value).replace(/"/g, '&quot;')
}

function chipHtml(tag: string, fallback: string): string {
	return `<span data-merge-tag="${escapeAttribute(tag)}" data-merge-fallback="${escapeAttribute(
		fallback,
	)}" contenteditable="false" class="${CHIP_CLASS}">${escapeText(
		mergeTagLabel(tag),
	)}</span>`
}

function chipElement(tag: string, fallback: string): HTMLElement | null {
	const template = document.createElement('template')
	template.innerHTML = chipHtml(tag, fallback)
	return template.content.firstElementChild as HTMLElement | null
}

/** Render stored text as editor HTML, replacing tokens with chips. */
export function mergeValueToHtml(value: string): string {
	return parseMergeSegments(value)
		.map((segment) =>
			segment.type === 'text'
				? escapeText(segment.value)
				: chipHtml(segment.tag, segment.fallback),
		)
		.join('')
}

/** Serialize editor HTML back to stored text, preserving chips as tokens. */
export function mergeHtmlToValue(root: HTMLElement): string {
	let output = ''
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			output += node.textContent ?? ''
			return
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return
		const element = node as HTMLElement
		const tag = element.dataset.mergeTag
		if (tag) {
			output += buildMergeToken(tag, element.dataset.mergeFallback ?? '')
			return
		}
		if (element.tagName === 'BR') {
			output += '\n'
			return
		}
		element.childNodes.forEach(walk)
	}
	root.childNodes.forEach(walk)
	return output
}

/**
 * Merge-tag aware text field.
 *
 * Renders merge tags as inline chips. Clicking a chip opens a popover to swap
 * the tag or set a fallback used when the recipient has no value. The stored
 * value stays plain text (`{{firstName|there}}`), so nothing downstream needs to
 * understand chips.
 */
export function MergeTagField({
	value,
	onChange,
	id,
	placeholder,
	multiline = false,
	rows = 4,
	className,
	disabled,
}: MergeTagFieldProps) {
	const { _ } = useLingui()
	const fallbackInputId = useId()
	const editorRef = useRef<HTMLDivElement>(null)
	const lastValueRef = useRef<string | null>(null)
	const [active, setActive] = useState<ActiveToken | null>(null)
	const [fallbackDraft, setFallbackDraft] = useState('')

	// Sync external value changes without clobbering what the user is typing.
	useEffect(() => {
		const editor = editorRef.current
		if (!editor) return
		if (value === lastValueRef.current) return
		editor.innerHTML = mergeValueToHtml(value)
		lastValueRef.current = value
	}, [value])

	const emit = useCallback(
		(next: string) => {
			lastValueRef.current = next
			onChange(next)
		},
		[onChange],
	)

	const serialize = useCallback(
		() => (editorRef.current ? mergeHtmlToValue(editorRef.current) : ''),
		[],
	)

	/** The caret's range when it sits inside this editor, else null. */
	const caretRange = useCallback(() => {
		const editor = editorRef.current
		const selection = window.getSelection()
		if (!editor || !selection || selection.rangeCount === 0) return null
		const range = selection.getRangeAt(0)
		if (!editor.contains(range.commonAncestorContainer)) return null
		return range
	}, [])

	/** Move the caret to sit just after `node`. */
	const placeCaretAfter = useCallback((node: Node) => {
		const editor = editorRef.current
		const selection = window.getSelection()
		if (!editor || !selection) return
		// Focusing first; the browser may otherwise collapse the selection.
		editor.focus()
		const range = document.createRange()
		range.setStartAfter(node)
		range.collapse(true)
		selection.removeAllRanges()
		selection.addRange(range)
	}, [])

	/**
	 * Insert nodes at the caret, keeping the caret after them.
	 *
	 * `Range.insertNode` splits a text node at the offset, so a chip lands
	 * between the two halves rather than swallowing the surrounding text.
	 */
	const insertAtCaret = useCallback(
		(nodes: Node) => {
			const range = caretRange()
			if (!range) return false
			range.deleteContents()
			const last = nodes.lastChild ?? nodes
			range.insertNode(nodes)
			placeCaretAfter(last)
			emit(serialize())
			return true
		},
		[caretRange, placeCaretAfter, emit, serialize],
	)

	const insertPlainText = (text: string) => {
		insertAtCaret(document.createTextNode(text))
	}

	/** Insert a merge tag as a real chip at the caret (or append it). */
	const insertTag = (tag: string) => {
		const chip = chipElement(tag, '')
		if (!chip) return
		if (insertAtCaret(chip)) return

		const editor = editorRef.current
		if (!editor) return
		editor.appendChild(chip)
		placeCaretAfter(chip)
		emit(serialize())
	}

	const handleInput = () => emit(serialize())

	const handleClick = (event: MouseEvent<HTMLDivElement>) => {
		const chip = (event.target as HTMLElement).closest<HTMLElement>(
			'[data-merge-tag]',
		)
		if (!chip) return
		setFallbackDraft(chip.dataset.mergeFallback ?? '')
		setActive({ element: chip, tag: chip.dataset.mergeTag ?? '' })
	}

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== 'Enter') return
		event.preventDefault()
		if (multiline) insertPlainText('\n')
	}

	const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
		// Paste as plain text so foreign markup can't enter the editor, but
		// recognize any merge tokens in it and render them as chips.
		event.preventDefault()
		const raw = event.clipboardData.getData('text/plain')
		const text = multiline ? raw : raw.replace(/\s*\n+\s*/g, ' ')
		const template = document.createElement('template')
		template.innerHTML = mergeValueToHtml(text)
		insertAtCaret(template.content)
	}

	/** Rewrite the clicked chip in place, then re-serialize. */
	const updateActiveChip = (next: { tag?: string; fallback?: string }) => {
		const chip = active?.element
		if (!chip) return
		const tag = next.tag ?? chip.dataset.mergeTag ?? ''
		const fallback = next.fallback ?? chip.dataset.mergeFallback ?? ''
		const replacement = chipElement(tag, fallback)
		if (!replacement) return
		chip.parentNode?.replaceChild(replacement, chip)
		setActive({ element: replacement, tag })
		emit(serialize())
	}

	const removeActiveChip = () => {
		active?.element.remove()
		setActive(null)
		emit(serialize())
	}

	return (
		<div className="space-y-1.5">
			<div
				ref={editorRef}
				id={id}
				role="textbox"
				aria-multiline={multiline}
				aria-label={placeholder}
				tabIndex={disabled ? -1 : 0}
				contentEditable={!disabled}
				suppressContentEditableWarning
				data-placeholder={placeholder}
				onInput={handleInput}
				onClick={handleClick}
				onKeyDown={handleKeyDown}
				onPaste={handlePaste}
				className={cn(
					'border-input focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-lg border bg-transparent px-2.5 py-1.5 text-sm break-words whitespace-pre-wrap transition-colors outline-none focus-visible:ring-[3px]',
					'empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
					!multiline && 'leading-6',
					className,
				)}
				style={multiline ? { minHeight: `${rows * 1.5}rem` } : undefined}
			/>
			<div className="flex flex-wrap items-center gap-1">
				<span className="text-muted-foreground text-[11px]">
					<Trans>Insert</Trans>
				</span>
				{MERGE_TOKENS.map((entry) => (
					<button
						key={entry.tag}
						type="button"
						disabled={disabled}
						onClick={() => insertTag(entry.tag)}
						className="border-border text-muted-foreground hover:bg-muted hover:text-foreground rounded-md border px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50"
					>
						{entry.label}
					</button>
				))}
			</div>

			<Popover
				open={Boolean(active)}
				onOpenChange={(open) => {
					if (!open) setActive(null)
				}}
			>
				<PopoverContent
					anchor={active?.element ?? null}
					align="start"
					side="bottom"
					sideOffset={6}
					className="w-80 gap-3"
				>
					<p className="text-sm font-medium">
						<Trans>Swap variable</Trans>
					</p>

					<div className="space-y-1.5">
						<Label htmlFor={fallbackInputId} className="text-xs">
							<Trans>Fallback</Trans>
						</Label>
						<div className="flex gap-1.5">
							<Input
								id={fallbackInputId}
								value={fallbackDraft}
								placeholder={_(msg`Used when the value is empty`)}
								onChange={(event) => setFallbackDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										updateActiveChip({ fallback: fallbackDraft })
									}
								}}
								className="h-8"
							/>
							<Button
								type="button"
								size="sm"
								variant="outline"
								className="h-8 shrink-0"
								onClick={() => updateActiveChip({ fallback: fallbackDraft })}
							>
								<Trans>Save</Trans>
							</Button>
						</div>
						<p className="text-muted-foreground text-[11px]">
							<Trans>
								Shown to recipients who have no value for this field.
							</Trans>
						</p>
					</div>

					<div className="space-y-0.5">
						<p className="text-muted-foreground px-1 text-[11px] font-semibold tracking-wide uppercase">
							<Trans>Variables</Trans>
						</p>
						<div className="max-h-56 overflow-auto">
							{MERGE_TOKENS.map((entry) => {
								const isCurrent = active?.tag === entry.tag
								return (
									<button
										key={entry.tag}
										type="button"
										onClick={() =>
											updateActiveChip({
												tag: entry.tag,
												fallback: fallbackDraft,
											})
										}
										className={cn(
											'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
											isCurrent ? 'bg-muted' : 'hover:bg-muted/60',
										)}
									>
										<span className="min-w-0 flex-1">
											<span className="block truncate text-sm font-medium">
												{entry.label}
											</span>
											<span className="text-muted-foreground block truncate text-xs">
												{entry.sample}
											</span>
										</span>
										<Icon
											name={isCurrent ? 'check' : 'chevron-right'}
											className="text-muted-foreground size-3.5 shrink-0"
										/>
									</button>
								)
							})}
						</div>
					</div>

					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="text-destructive hover:text-destructive w-full justify-start"
						onClick={removeActiveChip}
					>
						<Icon name="trash-2" className="size-3.5" />
						<Trans>Remove variable</Trans>
					</Button>
				</PopoverContent>
			</Popover>
		</div>
	)
}
