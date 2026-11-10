import { toast } from 'sonner'

/** How long the Undo button stays on screen. */
export const UNDO_TOAST_DURATION_MS = 60_000

export type UndoToastOptions = {
	/** What happened: "Waste logged: chicken thighs, 2.3 kg". */
	message: string
	/** The button label (translated by the caller). */
	undoLabel: string
	/** Runs when Undo is pressed. A rejection shows `failedMessage`. */
	onUndo: () => Promise<unknown> | unknown
	/** Shown after Undo succeeds, when given. */
	undoneMessage?: string
	/** Shown when Undo fails. */
	failedMessage: string
	duration?: number
}

/**
 * A toast with an Undo action. The first one in the App: what was done stays
 * done until Undo is pressed, and a failed Undo says so instead of
 * disappearing.
 */
export function showUndoToast({
	message,
	undoLabel,
	onUndo,
	undoneMessage,
	failedMessage,
	duration = UNDO_TOAST_DURATION_MS,
}: UndoToastOptions): string | number {
	return toast(message, {
		duration,
		action: {
			label: undoLabel,
			onClick: () => {
				void Promise.resolve()
					.then(onUndo)
					.then(
						() => {
							if (undoneMessage) toast.success(undoneMessage)
						},
						() => {
							toast.error(failedMessage)
						},
					)
			},
		},
	})
}
