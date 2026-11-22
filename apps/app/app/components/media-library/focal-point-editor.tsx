import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	focalObjectPosition,
	normalizeFocalPoint,
	type FocalPoint,
} from '@repo/common/image-focal'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Label } from '@repo/ui/label'
import {
	useEffect,
	useId,
	useRef,
	useState,
	type KeyboardEvent,
	type PointerEvent,
} from 'react'

const KEY_STEP = 0.05

function clamp(value: number) {
	return Math.min(1, Math.max(0, value))
}

/**
 * Click the part of a dish photo that matters (#394). Every crop of the photo
 * (website, QR, app, delivery menus) keeps that point in view; the centre is
 * the default. Saving changes only the point, so nothing is uploaded again.
 * The three previews show the effect on common crops, live.
 */
export function FocalPointEditor({
	url,
	focal,
	readOnly,
	saving,
	onSave,
}: {
	url: string
	focal: FocalPoint | null
	readOnly: boolean
	saving: boolean
	/** `null` clears the point (back to the centre). */
	onSave: (point: FocalPoint | null) => void
}) {
	const { _ } = useLingui()
	const frameId = useId()
	const helpId = useId()
	const frame = useRef<HTMLDivElement>(null)
	const dragging = useRef(false)
	const [draft, setDraft] = useState<FocalPoint | null>(focal)
	useEffect(() => setDraft(focal), [focal])

	const point = draft ?? { x: 0.5, y: 0.5 }
	const dirty =
		(draft?.x ?? 0.5) !== (focal?.x ?? 0.5) ||
		(draft?.y ?? 0.5) !== (focal?.y ?? 0.5)
	const position = focalObjectPosition(draft)

	function setFromPointer(clientX: number, clientY: number) {
		const rect = frame.current?.getBoundingClientRect()
		if (!rect || rect.width === 0 || rect.height === 0) return
		setDraft(
			normalizeFocalPoint(
				clamp((clientX - rect.left) / rect.width),
				clamp((clientY - rect.top) / rect.height),
			) ?? { x: 0.5, y: 0.5 },
		)
	}

	function onPointerDown(event: PointerEvent<HTMLDivElement>) {
		if (readOnly) return
		// A drag keeps following the pointer (a finger too) after it leaves the
		// photo; `touch-none` keeps a touch from scrolling the page instead.
		dragging.current = true
		event.currentTarget.setPointerCapture(event.pointerId)
		setFromPointer(event.clientX, event.clientY)
	}

	function onPointerMove(event: PointerEvent<HTMLDivElement>) {
		if (!dragging.current) return
		setFromPointer(event.clientX, event.clientY)
	}

	function endDrag(event: PointerEvent<HTMLDivElement>) {
		dragging.current = false
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (readOnly) return
		const step =
			event.key === 'ArrowLeft'
				? [-KEY_STEP, 0]
				: event.key === 'ArrowRight'
					? [KEY_STEP, 0]
					: event.key === 'ArrowUp'
						? [0, -KEY_STEP]
						: event.key === 'ArrowDown'
							? [0, KEY_STEP]
							: null
		if (!step) return
		event.preventDefault()
		setDraft(
			normalizeFocalPoint(
				clamp(point.x + step[0]!),
				clamp(point.y + step[1]!),
			) ?? { x: 0.5, y: 0.5 },
		)
	}

	const left = Math.round(point.x * 100)
	const top = Math.round(point.y * 100)
	return (
		<div className="space-y-2" data-testid="focal-point-editor">
			<Label id={`${frameId}-label`} className="text-xs font-medium">
				<Trans>Crop focus</Trans>
			</Label>
			<p id={helpId} className="text-muted-foreground text-xs">
				<Trans>
					Click or drag on the part of the dish that matters, or use the arrow
					keys or the sliders. Website, QR and app photos keep it in view.
				</Trans>
			</p>
			<div
				ref={frame}
				id={frameId}
				role="group"
				tabIndex={readOnly ? -1 : 0}
				aria-labelledby={`${frameId}-label`}
				aria-describedby={helpId}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				onKeyDown={onKeyDown}
				className={cn(
					'bg-muted/30 focus-visible:ring-ring relative block w-fit max-w-full touch-none overflow-hidden rounded-md border focus-visible:ring-2 focus-visible:outline-none',
					readOnly ? 'cursor-default' : 'cursor-crosshair',
				)}
			>
				<img
					src={url}
					alt=""
					draggable={false}
					className="block max-h-56 max-w-full select-none"
				/>
				<span
					aria-hidden
					className="border-background bg-primary/80 pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 shadow-md"
					style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
				/>
			</div>
			{/* The new position, read out after every move (pointer, keys, sliders). */}
			<p className="sr-only" role="status" aria-live="polite">
				{_(msg`${left}% from the left, ${top}% from the top`)}
			</p>
			{readOnly ? null : (
				<div className="grid grid-cols-2 gap-3">
					<div className="space-y-1">
						<Label htmlFor={`${frameId}-x`} className="text-xs">
							<Trans>Left to right</Trans>
						</Label>
						<input
							id={`${frameId}-x`}
							type="range"
							min={0}
							max={100}
							step={1}
							value={left}
							aria-valuetext={_(msg`${left}% from the left`)}
							onChange={(event) =>
								setDraft(
									normalizeFocalPoint(
										Number(event.currentTarget.value) / 100,
										point.y,
									) ?? { x: 0.5, y: point.y },
								)
							}
							className="w-full"
						/>
					</div>
					<div className="space-y-1">
						<Label htmlFor={`${frameId}-y`} className="text-xs">
							<Trans>Top to bottom</Trans>
						</Label>
						<input
							id={`${frameId}-y`}
							type="range"
							min={0}
							max={100}
							step={1}
							value={top}
							aria-valuetext={_(msg`${top}% from the top`)}
							onChange={(event) =>
								setDraft(
									normalizeFocalPoint(
										point.x,
										Number(event.currentTarget.value) / 100,
									) ?? { x: point.x, y: 0.5 },
								)
							}
							className="w-full"
						/>
					</div>
				</div>
			)}
			<ul
				className="grid grid-cols-3 gap-2"
				aria-label={_(msg`How the crops look`)}
			>
				{[
					{ key: 'square', label: msg`Square`, ratio: 'aspect-square' },
					{ key: 'card', label: msg`Card`, ratio: 'aspect-[4/3]' },
					{ key: 'banner', label: msg`Banner`, ratio: 'aspect-video' },
				].map((preview) => (
					<li key={preview.key} className="min-w-0 space-y-1">
						<div
							aria-hidden
							className={cn('bg-muted rounded-md border', preview.ratio)}
							style={{
								backgroundImage: `url("${url}")`,
								backgroundSize: 'cover',
								backgroundPosition: position,
							}}
						/>
						<p className="text-muted-foreground truncate text-[11px]">
							{_(preview.label)}
						</p>
					</li>
				))}
			</ul>
			{readOnly ? null : (
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						size="xs"
						disabled={!dirty || saving}
						onClick={() => onSave(draft)}
					>
						<Trans>Save focus</Trans>
					</Button>
					<Button
						type="button"
						size="xs"
						variant="ghost"
						disabled={saving || (!draft && !focal)}
						onClick={() => {
							setDraft(null)
							if (focal) onSave(null)
						}}
					>
						<Trans>Reset to centre</Trans>
					</Button>
				</div>
			)}
		</div>
	)
}
