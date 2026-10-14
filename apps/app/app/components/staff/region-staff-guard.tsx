import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type StaffSummary } from '@repo/staffing'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useMemo, useState } from 'react'
import {
	fetchStaffBackup,
	saveTextFile,
	staffBackupFilename,
} from '#app/utils/staffing/region-backup.ts'
import { createStaffClient } from '#app/utils/staffing/staff-client.ts'

/** What the region-switch dialog knows about the old region's staff data. */
export type RegionStaffGuardState = {
	status: 'loading' | 'ready'
	summary: StaffSummary | null
	requiresConfirmation: boolean
}

/**
 * The staff part of the "delete customer data and switch region" dialog:
 * counts of what would be deleted, a backup that goes from the old region
 * straight to this browser, and the typed confirmation that unlocks the switch.
 * Rendered only while the dialog is open; nothing here reads a staff record.
 */
export function RegionStaffGuard({
	orgSlug,
	state,
	typed,
	onTypedChange,
}: {
	orgSlug: string
	state: RegionStaffGuardState
	typed: string
	onTypedChange: (value: string) => void
}) {
	const { _ } = useLingui()
	const [backup, setBackup] = useState<'idle' | 'working' | 'done' | 'failed'>(
		'idle',
	)
	const client = useMemo(() => createStaffClient({ orgSlug }), [orgSlug])

	if (state.status === 'loading') {
		return (
			<p className="text-muted-foreground text-sm" role="status">
				<Trans>Checking for staff records…</Trans>
			</p>
		)
	}
	if (!state.requiresConfirmation) return null

	const { summary } = state
	const staffCount = summary?.staff ?? 0
	const formerCount = summary?.byStatus.terminated ?? 0
	const payCount = summary?.payRecords ?? 0
	const positionCount = summary?.positions ?? 0
	const noteCount = summary?.notes ?? 0
	const applicantCount = summary?.applicants ?? 0
	const timeCardCount = summary?.timeCards ?? 0
	const shiftCount = summary?.shifts ?? 0

	async function downloadBackup() {
		setBackup('working')
		try {
			saveTextFile(
				staffBackupFilename(orgSlug, new Date()),
				await fetchStaffBackup(client),
			)
			setBackup('done')
		} catch {
			setBackup('failed')
		}
	}

	return (
		<section
			className="border-destructive/40 flex flex-col gap-3 rounded-lg border p-3"
			aria-labelledby="region-staff-heading"
		>
			<h3 id="region-staff-heading" className="text-sm font-medium">
				<Trans>Staff records will be deleted too</Trans>
			</h3>
			{summary ? (
				<ul className="text-sm">
					<li>
						<Trans>Staff members: {staffCount}</Trans>
						{formerCount > 0 ? (
							<span className="text-muted-foreground">
								{' '}
								<Trans>({formerCount} former)</Trans>
							</span>
						) : null}
					</li>
					<li>
						<Trans>Pay history records: {payCount}</Trans>
					</li>
					<li>
						<Trans>Positions: {positionCount}</Trans>
					</li>
					<li>
						<Trans>Notes: {noteCount}</Trans>
					</li>
					{timeCardCount > 0 ? (
						<li>
							<Trans>
								Time cards: {timeCardCount} (not included in the backup)
							</Trans>
						</li>
					) : null}
					{shiftCount > 0 ? (
						<li>
							<Trans>
								Scheduled shifts: {shiftCount} (not included in the backup)
							</Trans>
						</li>
					) : null}
					{applicantCount > 0 ? (
						<li>
							<Trans>
								Job applicants: {applicantCount} (not included in the backup)
							</Trans>
						</li>
					) : null}
				</ul>
			) : (
				<p className="text-muted-foreground text-sm">
					<Trans>
						We could not check how many staff records there are, so assume there
						are some.
					</Trans>
				</p>
			)}
			<p className="text-muted-foreground text-sm">
				<Trans>
					Staff data is not moved to the new region. Download a backup first: it
					goes from the current region straight to this device.
				</Trans>
			</p>
			<div className="flex flex-col items-start gap-2">
				<Button
					type="button"
					variant="outline"
					disabled={backup === 'working'}
					onClick={() => void downloadBackup()}
				>
					{backup === 'working' ? (
						<Trans>Preparing backup…</Trans>
					) : backup === 'done' ? (
						<Trans>Download again</Trans>
					) : (
						<Trans>Download staff backup</Trans>
					)}
				</Button>
				{backup === 'done' ? (
					<p className="text-sm" role="status">
						<Trans>Backup downloaded.</Trans>
					</p>
				) : null}
				{backup === 'failed' ? (
					<Alert variant="destructive">
						<AlertDescription>
							<Trans>
								The backup could not be created. Turn on Staff and check that
								you can view staff, then try again.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}
			</div>
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="region-staff-confirm">
					<span>
						<Trans>
							Type <strong>{orgSlug}</strong> to confirm
						</Trans>
					</span>
				</Label>
				<Input
					id="region-staff-confirm"
					value={typed}
					onChange={(event) => onTypedChange(event.target.value)}
					autoComplete="off"
					autoCapitalize="none"
					spellCheck={false}
					aria-label={_(t`Organization slug`)}
				/>
			</div>
		</section>
	)
}
