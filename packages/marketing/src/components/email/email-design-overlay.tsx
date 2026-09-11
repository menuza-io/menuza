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
import { Dialog, DialogContent } from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { cn } from '@repo/ui'
import { useCallback, useRef, useState, type ReactNode } from 'react'

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
	const wasOpenRef = useRef(open)

	// Re-seed the draft at the explicit open-session boundary so a discarded
	// edit cannot reappear on the next open.
	if (open && !wasOpenRef.current) setDraft(initialBlocks)
	wasOpenRef.current = open

	const isDirty = JSON.stringify(draft) !== JSON.stringify(initialBlocks)

	const requestClose = useCallback(() => {
		if (isDirty) {
			setConfirmDiscard(true)
			return
		}
		onOpenChange(false)
	}, [isDirty, onOpenChange])

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
			<Dialog
				open={open}
				onOpenChange={(nextOpen) => {
					if (!nextOpen && !confirmDiscard) requestClose()
				}}
			>
				<DialogContent
					showCloseButton={false}
					aria-label={title ?? _(msg`Email design`)}
					className={cn(
						// DialogContent is normally a centred card. This editor is a
						// full-screen workspace, so override both its base and `sm:`
						// popup constraints while retaining Dialog's focus management.
						'bg-muted !inset-0 !top-0 !right-0 !bottom-0 !left-0 flex h-dvh !w-screen !max-w-none !translate-x-0 !translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 data-closed:animate-none data-open:animate-none sm:!max-w-none',
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
								{isDirty ? (
									<Trans>Unsaved changes</Trans>
								) : (
									<Trans>Saved</Trans>
								)}
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
				</DialogContent>
			</Dialog>

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
