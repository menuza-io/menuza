import { Trans } from '@lingui/macro'
import {
	BULK_PHOTO_MAX_FILE_BYTES,
	BULK_PHOTO_MAX_FILES,
} from '@repo/common/dish-photo-match'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useId, useRef, useState } from 'react'

const MAX_FILE_MB = Math.round(BULK_PHOTO_MAX_FILE_BYTES / (1024 * 1024))

/**
 * The drop target of Add dish photos in bulk (#316): drag and drop, or the
 * button (a real button, so the keyboard works) for a multi-file picker that
 * also takes a zip.
 */
export function BulkDropZone({
	disabled,
	onFiles,
}: {
	disabled?: boolean
	onFiles: (files: File[]) => void
}) {
	const inputRef = useRef<HTMLInputElement>(null)
	const hintId = useId()
	const [dragging, setDragging] = useState(false)

	return (
		<div
			role="group"
			aria-describedby={hintId}
			data-dragging={dragging || undefined}
			className={cn(
				'border-input bg-card flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
				dragging && 'border-primary bg-primary/5',
				disabled && 'opacity-60',
			)}
			onDragOver={(event) => {
				if (disabled) return
				event.preventDefault()
				event.dataTransfer.dropEffect = 'copy'
			}}
			onDragEnter={(event) => {
				if (disabled) return
				event.preventDefault()
				setDragging(true)
			}}
			onDragLeave={(event) => {
				// Moving over a child fires leave too; only the zone itself counts.
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
					setDragging(false)
				}
			}}
			onDrop={(event) => {
				event.preventDefault()
				setDragging(false)
				if (disabled) return
				const files = [...event.dataTransfer.files]
				if (files.length > 0) onFiles(files)
			}}
		>
			<span className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
				<Icon name="image" className="size-6" />
			</span>
			<div className="space-y-1">
				<p className="text-base font-medium">
					<Trans>Drop dish photos here, or a zip file of photos</Trans>
				</p>
				<p id={hintId} className="text-muted-foreground text-sm">
					<Trans>
						JPEG, PNG, WebP, GIF or AVIF, up to {MAX_FILE_MB} MB each and{' '}
						{BULK_PHOTO_MAX_FILES} photos at a time. Name each file after its
						dish to get better matches.
					</Trans>
				</p>
			</div>
			<input
				ref={inputRef}
				type="file"
				multiple
				accept="image/jpeg,image/png,image/webp,image/gif,image/avif,.zip,application/zip,application/x-zip-compressed"
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				disabled={disabled}
				onChange={(event) => {
					const files = [...(event.currentTarget.files ?? [])]
					event.currentTarget.value = ''
					if (files.length > 0) onFiles(files)
				}}
			/>
			<Button
				type="button"
				disabled={disabled}
				onClick={() => inputRef.current?.click()}
			>
				<Icon name="plus" />
				<Trans>Choose photos or a zip</Trans>
			</Button>
		</div>
	)
}
