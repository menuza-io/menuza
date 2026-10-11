import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getDomainUrl } from '@repo/common'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { data, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { PairKioskDialog } from '#app/components/staffing/pair-kiosk-dialog.tsx'
import { staffingErrorMessage } from '#app/components/staffing/staffing-errors.ts'
import { useStaffingClient } from '#app/hooks/use-staffing-client.ts'
import { requireStaffingFeature } from '#app/utils/staffing/access.server.ts'
import {
	type Kiosk,
	kioskListSchema,
	pairingSchema,
} from '#app/utils/staffing/client.ts'
import {
	loadMemberNames,
	loadStaffingLocations,
} from '#app/utils/staffing/locations.server.ts'
import { type KioskAuditEvent } from './kiosks-audit.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireStaffingFeature(
		request,
		params.orgSlug,
		'timeclock',
		'read',
	)
	const orgSlug = params.orgSlug || ''
	const [locations, memberNames] = await Promise.all([
		loadStaffingLocations(access.orgId),
		loadMemberNames(access.orgId),
	])
	return data(
		{
			orgSlug,
			canWrite: access.grants.timeclock === 'write',
			locations,
			memberNames,
			kioskUrl: `${getDomainUrl(request)}/kiosk/${encodeURIComponent(orgSlug)}`,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

function useRelativeTime() {
	const { i18n } = useLingui()
	return useCallback(
		(iso: string) => {
			const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
			const format = new Intl.RelativeTimeFormat(i18n.locale, {
				numeric: 'auto',
			})
			const abs = Math.abs(seconds)
			if (abs < 60) return format.format(seconds, 'second')
			if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
			if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour')
			return format.format(Math.round(seconds / 86400), 'day')
		},
		[i18n.locale],
	)
}

export default function StaffKiosks() {
	const { orgSlug, canWrite, locations, memberNames, kioskUrl } =
		useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const request = useStaffingClient(orgSlug)
	const relative = useRelativeTime()
	const [kiosks, setKiosks] = useState<Kiosk[]>([])
	const [kioskEnabled, setKioskEnabled] = useState(true)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [pairing, setPairing] = useState(false)
	const [revoking, setRevoking] = useState<Kiosk | null>(null)
	const [busy, setBusy] = useState(false)
	const activeLocations = useMemo(
		() => locations.filter((location) => location.isActive),
		[locations],
	)
	const locationName = useMemo(
		() => new Map(locations.map((location) => [location.id, location.name])),
		[locations],
	)

	const audit = useCallback(
		(event: KioskAuditEvent) =>
			fetch(`/${encodeURIComponent(orgSlug)}/staffing/kiosks-audit`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(event),
			}).catch(() => undefined),
		[orgSlug],
	)

	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const body = kioskListSchema.parse(await request('/kiosks', { signal }))
				if (signal?.aborted) return
				setKiosks(body.kiosks)
				setKioskEnabled(body.kioskEnabled)
				setError(null)
			} catch (caught) {
				if (!signal?.aborted) setError(staffingErrorMessage(i18n, caught))
			} finally {
				if (!signal?.aborted) setLoading(false)
			}
		},
		[request, i18n],
	)

	useEffect(() => {
		const controller = new AbortController()
		void refresh(controller.signal)
		return () => controller.abort()
	}, [refresh])

	const active = kiosks.filter((kiosk) => !kiosk.revokedAt)
	const revoked = kiosks.filter((kiosk) => kiosk.revokedAt)
	const revokingName = revoking?.name ?? ''
	const revokedCount = revoked.length

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<p className="text-muted-foreground max-w-2xl text-sm">
					<Trans>
						A time clock is a shared tablet at a location. Staff enter their PIN
						to clock in and out. Set PINs on the Team page.
					</Trans>
				</p>
				{canWrite ? (
					<Button
						disabled={!kioskEnabled || activeLocations.length === 0}
						onClick={() => setPairing(true)}
					>
						<Icon name="plus" className="size-4" />
						<Trans>Add a time clock</Trans>
					</Button>
				) : null}
			</div>

			{!kioskEnabled ? (
				<p role="status" className="bg-muted rounded-md p-3 text-sm">
					<Trans>
						Time clocks are paused in your data region. Paired tablets will not
						accept punches until they are turned back on.
					</Trans>
				</p>
			) : null}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}

			{loading ? (
				<p role="status">
					<Trans>Loading time clocks…</Trans>
				</p>
			) : active.length === 0 ? (
				<div className="rounded-lg border p-8 text-center">
					<h3 className="font-medium">
						<Trans>No time clocks yet</Trans>
					</h3>
					<p className="text-muted-foreground mt-2 text-sm">
						<Trans>
							Add one, then open the link on the tablet that stays at the
							location.
						</Trans>
					</p>
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted/50 text-muted-foreground text-xs">
							<tr>
								<th scope="col" className="p-3 text-start font-medium">
									<Trans>Device</Trans>
								</th>
								<th scope="col" className="p-3 text-start font-medium">
									<Trans>Location</Trans>
								</th>
								<th scope="col" className="p-3 text-start font-medium">
									<Trans>Last seen</Trans>
								</th>
								<th scope="col" className="p-3 text-start font-medium">
									<Trans>Added by</Trans>
								</th>
								<th scope="col" className="p-3">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</th>
							</tr>
						</thead>
						<tbody className="divide-border divide-y">
							{active.map((kiosk) => {
								const locked =
									kiosk.lockedUntil &&
									new Date(kiosk.lockedUntil).getTime() > Date.now()
								return (
									<tr key={kiosk.id}>
										<td className="p-3 font-medium">
											<span className="flex items-center gap-2">
												<Icon name="tablet" className="size-4" />
												{kiosk.name}
												{locked ? (
													<Badge variant="destructive">
														<Trans>Locked after wrong PINs</Trans>
													</Badge>
												) : null}
											</span>
										</td>
										<td className="p-3">
											{locationName.get(kiosk.locationId) ?? _(msg`Unknown`)}
										</td>
										<td className="p-3">
											{kiosk.lastSeenAt ? relative(kiosk.lastSeenAt) : '—'}
										</td>
										<td className="p-3">
											{memberNames[kiosk.createdBy] ?? _(msg`A former member`)}
										</td>
										<td className="p-3 text-end">
											{canWrite ? (
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setRevoking(kiosk)}
												>
													<Trans>Remove</Trans>
												</Button>
											) : null}
										</td>
									</tr>
								)
							})}
						</tbody>
					</table>
				</div>
			)}

			{revoked.length > 0 ? (
				<details className="text-sm">
					<summary className="text-muted-foreground cursor-pointer">
						<Trans>Removed time clocks ({revokedCount})</Trans>
					</summary>
					<ul className="mt-2 space-y-1">
						{revoked.map((kiosk) => (
							<li key={kiosk.id} className="text-muted-foreground">
								{kiosk.name} ·{' '}
								{locationName.get(kiosk.locationId) ?? _(msg`Unknown`)} ·{' '}
								{relative(kiosk.revokedAt!)}
							</li>
						))}
					</ul>
				</details>
			) : null}

			<PairKioskDialog
				open={pairing}
				onOpenChange={(open) => {
					setPairing(open)
					if (!open) void refresh()
				}}
				locations={activeLocations}
				kioskUrl={kioskUrl}
				onCreate={async (input) => {
					try {
						const body = pairingSchema.parse(
							await request('/kiosks/pairing-codes', {
								method: 'POST',
								body: JSON.stringify(input),
							}),
						)
						void audit({
							event: 'pairing_started',
							locationId: input.locationId,
						})
						return body.pairing
					} catch (caught) {
						return { error: staffingErrorMessage(i18n, caught) }
					}
				}}
			/>
			<Dialog
				open={revoking !== null}
				onOpenChange={(open) => {
					if (!open) setRevoking(null)
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							<Trans>Remove {revokingName}?</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								The tablet stops working as a time clock right away. Anyone
								still clocked in can be clocked out from Timesheets. To use it
								again, pair it with a new code.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={() => setRevoking(null)}>
							<Trans>Cancel</Trans>
						</Button>
						<Button
							variant="destructive"
							disabled={busy}
							onClick={async () => {
								if (!revoking) return
								setBusy(true)
								try {
									await request(
										`/kiosks/${encodeURIComponent(revoking.id)}/revoke`,
										{ method: 'POST' },
									)
									void audit({
										event: 'kiosk_revoked',
										kioskId: revoking.id,
										locationId: revoking.locationId,
									})
									setRevoking(null)
									await refresh()
								} catch (caught) {
									setError(staffingErrorMessage(i18n, caught))
									setRevoking(null)
								} finally {
									setBusy(false)
								}
							}}
						>
							<Trans>Remove</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}
