import { Trans, Plural } from '@lingui/macro'
import { type ImpersonationInfo } from '@repo/auth'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Form } from 'react-router'

interface ImpersonationBannerProps {
	impersonationInfo: ImpersonationInfo
}

export function ImpersonationBanner({
	impersonationInfo,
}: ImpersonationBannerProps) {
	const { expiresAt } = impersonationInfo
	const expiresAtDate = expiresAt ? new Date(expiresAt) : null
	const remainingMinutes = expiresAtDate
		? Math.max(0, Math.ceil((expiresAtDate.getTime() - Date.now()) / 1000 / 60))
		: null

	const targetName = impersonationInfo.targetName

	return (
		<div
			role="status"
			className="sticky top-0 z-50 w-full shrink-0 border-b border-amber-500/30 bg-amber-50/95 px-4 py-2.5 backdrop-blur-sm dark:border-amber-400/25 dark:bg-amber-950/95"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 items-start gap-2.5 sm:items-center">
					<Icon
						name="alert-triangle"
						className="mt-0.5 size-4 shrink-0 text-amber-600 sm:mt-0 dark:text-amber-400"
					/>
					<p className="text-sm leading-snug text-amber-950 dark:text-amber-50">
						<span className="font-semibold">
							<Trans>Admin impersonation active</Trans>
						</span>
						<span className="text-amber-900/80 dark:text-amber-100/80">
							{' '}
							·{' '}
							<Trans>
								Impersonating <strong>{targetName}</strong>
							</Trans>
							{remainingMinutes !== null && (
								<>
									{' '}
									·{' '}
									<Plural
										value={remainingMinutes}
										one="# minute left"
										other="# minutes left"
									/>
								</>
							)}
						</span>
					</p>
				</div>
				<Form method="post" action="/stop-impersonation" className="shrink-0">
					<Button
						type="submit"
						variant="outline"
						size="sm"
						className="border-amber-500/40 bg-white/80 text-amber-950 hover:bg-amber-100 dark:border-amber-400/40 dark:bg-amber-950/50 dark:text-amber-50 dark:hover:bg-amber-900/60"
					>
						<Icon name="x" className="mr-1.5 size-3.5" />
						<Trans>Stop impersonation</Trans>
					</Button>
				</Form>
			</div>
		</div>
	)
}
