import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { type ReservationsSummary } from '#app/utils/reservations/region-confirmation.ts'

export type RegionReservationsGuardState = {
	status: 'loading' | 'ready'
	summary: ReservationsSummary | null
	requiresConfirmation: boolean
}

export function RegionReservationsGuard({
	orgSlug,
	state,
	typed,
	onTypedChange,
	showConfirmInput = true,
}: {
	orgSlug: string
	state: RegionReservationsGuardState
	typed: string
	onTypedChange: (value: string) => void
	showConfirmInput?: boolean
}) {
	const { _ } = useLingui()

	if (state.status === 'loading') {
		return (
			<p
				className="text-muted-foreground text-sm"
				role="status"
				data-testid="region-reservations-loading"
			>
				<Trans>Checking for reservation records…</Trans>
			</p>
		)
	}
	if (!state.requiresConfirmation) return null

	const { summary } = state
	const reservationsCount = summary?.reservations ?? 0
	const upcomingCount = summary?.upcomingReservations ?? 0
	const guestsCount = summary?.guests ?? 0
	const tablesCount = summary?.tables ?? 0
	const waitlistCount = summary?.waitlistEntries ?? 0
	const holdsCount = summary?.holds ?? summary?.activeHolds ?? 0
	const unsettledPaymentsCount =
		summary?.unsettledPayments ?? summary?.payments ?? 0

	return (
		<section
			className="border-destructive/40 flex flex-col gap-3 rounded-lg border p-3"
			aria-labelledby="region-reservations-heading"
			data-testid="region-reservations-guard"
		>
			<h3 id="region-reservations-heading" className="text-sm font-medium">
				<Trans>Reservation records will be deleted too</Trans>
			</h3>
			{summary ? (
				<ul className="text-sm" data-testid="region-reservations-counts">
					<li>
						<Trans>Reservations: {reservationsCount}</Trans>
						{upcomingCount > 0 ? (
							<span className="text-muted-foreground">
								{' '}
								<Trans>({upcomingCount} upcoming)</Trans>
							</span>
						) : null}
					</li>
					<li>
						<Trans>Guests: {guestsCount}</Trans>
					</li>
					<li>
						<Trans>Tables: {tablesCount}</Trans>
					</li>
					<li>
						<Trans>Waitlist entries: {waitlistCount}</Trans>
					</li>
					<li>
						<Trans>Active holds: {holdsCount}</Trans>
					</li>
					{unsettledPaymentsCount > 0 ? (
						<li className="text-destructive font-medium">
							<Trans>Unsettled payments: {unsettledPaymentsCount}</Trans>
						</li>
					) : null}
				</ul>
			) : (
				<p
					className="text-muted-foreground text-sm"
					data-testid="region-reservations-unknown"
				>
					<Trans>
						We could not check how many reservation records there are, so assume
						there are some.
					</Trans>
				</p>
			)}
			{unsettledPaymentsCount > 0 ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>
							Settle or refund all pending reservation payments before switching
							regions.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			<p className="text-muted-foreground text-sm">
				<Trans>
					Reservation books, guest profiles, floor plans, and waitlist history
					are not moved to the new region.
				</Trans>
			</p>
			{showConfirmInput ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="region-reservations-confirm">
						<span>
							<Trans>
								Type <strong>{orgSlug}</strong> to confirm
							</Trans>
						</span>
					</Label>
					<Input
						id="region-reservations-confirm"
						data-testid="region-reservations-confirm-input"
						value={typed}
						onChange={(event) => onTypedChange(event.target.value)}
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						aria-label={_(t`Organization slug`)}
					/>
				</div>
			) : null}
		</section>
	)
}
