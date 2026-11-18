import { Trans } from '@lingui/macro'
import { Icon } from '@repo/ui/icon'
import { isTrainingMode } from '~/lib/training-flag.ts'

/**
 * Shown above every screen while the till is in training mode (#383): the
 * register, the lock screen, setup, every app. It sits outside the app shell
 * (see `main.tsx`), so no screen can leave it out.
 */
export function TrainingBanner() {
	return (
		<div
			role="status"
			data-training-banner
			className="notice-warning flex w-full shrink-0 items-center justify-center gap-2 px-4 py-2 text-center text-sm font-semibold"
		>
			<Icon name="book-open" className="size-4 shrink-0" />
			<Trans>
				TRAINING MODE. Nothing here is a real sale: no order is sent, counted or
				printed as a receipt. A manager turns it off in Settings.
			</Trans>
		</div>
	)
}

/** Wraps the app in the banner while training, and leaves it untouched otherwise. */
export function TrainingShell({
	children,
	training = isTrainingMode(),
}: {
	children: React.ReactNode
	training?: boolean
}) {
	if (!training) return <>{children}</>
	return (
		<div className="flex h-full flex-col">
			<TrainingBanner />
			<div className="min-h-0 flex-1">{children}</div>
		</div>
	)
}
