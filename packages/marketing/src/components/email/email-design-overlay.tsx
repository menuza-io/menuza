import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type EmailBlock } from '@repo/common/email-blocks'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { cn } from '@repo/ui'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { EmailBlockEditor } from './email-block-editor.tsx'

export type EmailDesignOverlayProps = {
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Blocks to seed the draft with when the overlay opens. */
	initialBlocks: EmailBlock[]
	/** Shown as the document title in the header. */
	title?: string
	/** Shown as secondary context in the header (the node's subject line). */
	subject?: string
	/** Extra header controls (e.g. the app's AI assistant toggle). */
	headerExtras?: ReactNode
	/** Extra classes for the content area (e.g. inset for a docked AI panel). */
	contentClassName?: string
	/** Called with the draft when the author confirms the change. */
	onSave: (blocks: EmailBlock[]) => void | Promise<void>
	className?: string
}

/**
 * Full-screen email designer.
 *
 * Edits are held as a local draft: nothing reaches the caller until Save, and
 * closing with pending changes asks for confirmation. This keeps the designer
 * from silently committing into the workflow graph.
 *
 * The shell mirrors the website page/form builders (muted canvas, compact
 * header, rounded surface) so the editors feel consistent.
 */
export function EmailDesignOverlay({
	open,
	onOpenChange,
	initialBlocks,
	title,
	subject,
	headerExtras,
	contentClassName,
	onSave,
	className,
}: EmailDesignOverlayProps) {
	const { _ } = useLingui()
	const [draft, setDraft] = useState<EmailBlock[]>(initialBlocks)
	const [confirmDiscard, setConfirmDiscard] = useState(false)
	const [isSaving, setIsSaving] = useState(false)

	// Re-seed the draft each time the designer is opened so a discarded edit
	// doesn't reappear on the next open.
	useEffect(() => {
		if (open) setDraft(initialBlocks)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open])

	const isDirty = JSON.stringify(draft) !== JSON.stringify(initialBlocks)

	const requestClose = useCallback(() => {
		if (isDirty) {
			setConfirmDiscard(true)
			return
		}
		onOpenChange(false)
	}, [isDirty, onOpenChange])

	useEffect(() => {
		if (!open) return
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			event.stopPropagation()
			if (confirmDiscard) return
			requestClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [open, confirmDiscard, requestClose])

	const handleSave = async () => {
		setIsSaving(true)
		try {
			await onSave(draft)
			onOpenChange(false)
		} finally {
			setIsSaving(false)
		}
	}

	if (!open) return null

	return (
		<>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={title ?? _(msg`Email design`)}
				className={cn(
					'bg-muted fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden',
					className,
				)}
			>
				<header className="border-border bg-background flex h-12 shrink-0 items-center justify-between gap-3 border-b px-3">
					<div className="flex min-w-0 items-center gap-2">
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							onClick={requestClose}
							aria-label={_(msg`Close email design`)}
						>
							<Icon name="arrow-left" className="size-4" />
						</Button>

						<div className="bg-border hidden h-5 w-px sm:block" aria-hidden />

						<span className="max-w-48 truncate text-sm font-medium">
							{title ?? _(msg`Email design`)}
						</span>

						<div className="text-muted-foreground hidden items-center gap-1.5 text-xs sm:flex">
							<span
								className={cn(
									'size-1.5 rounded-full',
									isDirty ? 'bg-amber-500' : 'bg-muted-foreground/40',
								)}
							/>
							{isDirty ? <Trans>Unsaved changes</Trans> : <Trans>Saved</Trans>}
						</div>
					</div>

					<div className="flex shrink-0 items-center gap-2">
						{headerExtras}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={requestClose}
							disabled={isSaving}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							onClick={handleSave}
							disabled={!isDirty || isSaving}
						>
							{isSaving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
						</Button>
					</div>
				</header>

				<div className={cn('flex min-h-0 flex-1 p-2', contentClassName)}>
					<EmailBlockEditor
						blocks={draft}
						onChange={setDraft}
						subject={subject ?? ''}
						className="h-full min-h-0 flex-1"
					/>
				</div>
			</div>

			<AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Discard unsaved changes?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Your email design has changes that haven't been saved. Leaving
								now will lose them.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep editing</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								setConfirmDiscard(false)
								onOpenChange(false)
							}}
						>
							<Trans>Discard</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
