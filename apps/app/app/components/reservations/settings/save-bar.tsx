import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Spinner } from '@repo/ui/spinner'
import { type ReactNode } from 'react'

/**
 * Bottom bar for settings forms with an explicit Save. By default it only
 * renders while there is something to save (or a conflict to resolve), so a
 * clean form stays calm. `persistent` keeps a quiet, disabled Save in place
 * when nothing changed, and raises the bar once the form is dirty.
 */
export function SettingsSaveBar({
	dirty,
	pending,
	onSave,
	onDiscard,
	conflict,
	persistent,
	submit,
	saveTestId,
	discardTestId,
	dirtyTestId,
}: {
	dirty: boolean
	pending?: boolean
	onSave?: () => void
	onDiscard: () => void
	/** Shown instead of the dirty label when someone else changed the data. */
	conflict?: ReactNode
	persistent?: boolean
	/** Render Save as a form submit button instead of calling `onSave`. */
	submit?: boolean
	saveTestId?: string
	discardTestId?: string
	dirtyTestId?: string
}) {
	if (!dirty && !conflict && !persistent) return null
	const raised = dirty || Boolean(conflict)
	return (
		<div
			role="region"
			data-testid="settings-save-bar"
			className={cn(
				'bg-background/95 sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-2.5 backdrop-blur',
				raised ? 'shadow-raised' : 'bg-transparent shadow-none',
			)}
		>
			<p
				role="status"
				data-testid={dirtyTestId}
				className="text-muted-foreground flex min-w-0 items-center gap-2 text-sm"
			>
				{raised ? (
					<>
						<span
							aria-hidden
							className={cn(
								'size-1.5 shrink-0 rounded-full',
								conflict ? 'bg-destructive' : 'bg-warning',
							)}
						/>
						{conflict ?? <Trans>Unsaved changes</Trans>}
					</>
				) : null}
			</p>
			<div className="flex gap-2">
				{raised ? (
					<Button
						type="button"
						variant="outline"
						onClick={onDiscard}
						disabled={pending}
						data-testid={discardTestId}
					>
						{conflict ? <Trans>Reload</Trans> : <Trans>Discard</Trans>}
					</Button>
				) : null}
				{conflict ? null : (
					<Button
						type={submit ? 'submit' : 'button'}
						onClick={submit ? undefined : onSave}
						disabled={pending || !dirty}
						data-testid={saveTestId}
					>
						{pending ? <Spinner /> : null}
						{pending ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
					</Button>
				)}
			</div>
		</div>
	)
}
