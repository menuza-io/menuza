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
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

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
	const frame = useRef<HTMLDivElement>(null)
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
			<Label className="text-xs font-medium">
				<Trans>Crop focus</Trans>
			</Label>
			<p className="text-muted-foreground text-xs">
				<Trans>
					Click the part of the dish that matters. Website, QR and app photos
					keep it in view.
				</Trans>
			</p>
			<div
				ref={frame}
				role="group"
				tabIndex={readOnly ? -1 : 0}
				aria-label={_(
					msg`Photo focus point. Click the photo or use the arrow keys.`,
				)}
				aria-valuetext={_(msg`${left}% from the left, ${top}% from the top`)}
				onPointerDown={(event) => {
					if (readOnly) return
					setFromPointer(event.clientX, event.clientY)
				}}
				onKeyDown={onKeyDown}
				className={cn(
					'bg-muted/30 focus-visible:ring-ring relative block w-fit max-w-full overflow-hidden rounded-md border focus-visible:ring-2 focus-visible:outline-none',
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
