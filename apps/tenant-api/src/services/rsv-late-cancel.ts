import { rsvLocationSettings, type TenantDatabase } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'

type DbOrTx =
	TenantDatabase | Parameters<Parameters<TenantDatabase['transaction']>[0]>[0]

const DEFAULT_CANCEL_CUTOFF_MIN = 120

/**
 * A cancellation is "late" once it falls inside the cancellation cutoff before
 * the start. A booking policy's own cutoff wins; otherwise the location's guest
 * modify cutoff applies, so a restaurant without payment policies still gets
 * the same late-cancel facts in the Guestbook and reports.
 */
export async function isLateCancellation(
	db: DbOrTx,
	reservation: {
		locationId: string
		startAt: number
		policySnapshot: Record<string, unknown> | null
	},
	now: number,
): Promise<boolean> {
	const snapshotCutoff = Number(reservation.policySnapshot?.cancelCutoffMin)
	let cutoffMin =
		Number.isFinite(snapshotCutoff) && snapshotCutoff > 0 ? snapshotCutoff : 0
	if (cutoffMin === 0) {
		const settings = await db
			.select({ cutoff: rsvLocationSettings.guestModifyCutoffMin })
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, reservation.locationId))
			.get()
		cutoffMin = settings?.cutoff ?? DEFAULT_CANCEL_CUTOFF_MIN
	}
	return now > reservation.startAt - cutoffMin * 60_000
}
