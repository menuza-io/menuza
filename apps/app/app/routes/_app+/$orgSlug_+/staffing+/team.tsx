import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
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
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PositionSwatch } from '@repo/ui/position-color'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { data, type LoaderFunctionArgs, useLoaderData } from 'react-router'
import { z } from 'zod'
import {
	ImportDialog,
	type ImportResult,
} from '#app/components/staffing/import-dialog.tsx'
import { PositionsDialog } from '#app/components/staffing/positions-dialog.tsx'
import { StaffingSettingsDialog } from '#app/components/staffing/settings-dialog.tsx'
import {
	StaffDialog,
	type StaffFormValue,
} from '#app/components/staffing/staff-dialog.tsx'
import { staffingErrorMessage } from '#app/components/staffing/staffing-errors.ts'
import { useStaffingClient } from '#app/hooks/use-staffing-client.ts'
import { requireStaffingFeature } from '#app/utils/staffing/access.server.ts'
import {
	contextSchema,
	type Position,
	positionSchema,
	type Settings,
	settingsSchema,
	type Staff,
	staffName,
	staffSchema,
} from '#app/utils/staffing/client.ts'
import {
	loadMemberEmails,
	loadStaffingLocations,
} from '#app/utils/staffing/locations.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireStaffingFeature(
		request,
		params.orgSlug,
		'staff',
		'read',
	)
	const [locations, memberEmails] = await Promise.all([
		loadStaffingLocations(access.orgId),
		loadMemberEmails(access.orgId),
	])
	return data(
		{
			orgSlug: params.orgSlug || '',
			canWrite: access.grants.staff === 'write',
			locations,
			memberEmails,
			dataRegion: access.dataRegion,
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
}

function todayLocal() {
	const now = new Date()
	const month = String(now.getMonth() + 1).padStart(2, '0')
	const day = String(now.getDate()).padStart(2, '0')
	return `${now.getFullYear()}-${month}-${day}`
}

function toInput(value: StaffFormValue) {
	return {
		firstName: value.firstName,
		lastName: value.lastName,
		email: value.email,
		phone: value.phone,
		hiredOn: value.hiredOn,
		note: value.note,
		assignments: value.assignments,
	}
}

export default function StaffTeam() {
	const { orgSlug, canWrite, locations, memberEmails } =
		useLoaderData<typeof loader>()
	const { _, i18n } = useLingui()
	const request = useStaffingClient(orgSlug)
	const [staff, setStaff] = useState<Staff[]>([])
	const [positions, setPositions] = useState<Position[]>([])
	const [settings, setSettings] = useState<Settings | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [status, setStatus] = useState<'active' | 'terminated'>('active')
	const [editing, setEditing] = useState<Staff | null>(null)
	const [dialog, setDialog] = useState<
		'staff' | 'positions' | 'import' | 'settings' | 'terminate' | null
	>(null)
	const [terminateOn, setTerminateOn] = useState(todayLocal)
	const [terminateReason, setTerminateReason] = useState('')
	const [busy, setBusy] = useState(false)
	const logins = useMemo(() => new Set(memberEmails), [memberEmails])
	const positionById = useMemo(
		() => new Map(positions.map((position) => [position.id, position])),
		[positions],
	)
	const locationById = useMemo(
		() => new Map(locations.map((location) => [location.id, location])),
		[locations],
	)

	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const [context, list] = await Promise.all([
					request('/context', { signal }).then((body) =>
						contextSchema.parse(body),
					),
					request('/staff', { signal }).then((body) =>
						z.object({ staff: z.array(staffSchema) }).parse(body),
					),
				])
				if (signal?.aborted) return
				setPositions(context.positions)
				setSettings(context.settings)
				setStaff(list.staff)
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

	const attempt = async (work: () => Promise<unknown>) => {
		try {
			await work()
			await refresh()
			return null
		} catch (caught) {
			return staffingErrorMessage(i18n, caught)
		}
	}

	const visible = staff.filter((member) => {
		if (member.status !== status) return false
		const needle = query.trim().toLowerCase()
		if (!needle) return true
		return [staffName(member), member.email ?? '', member.phone ?? '']
			.join(' ')
			.toLowerCase()
			.includes(needle)
	})
	const activeCount = staff.filter(
		(member) => member.status === 'active',
	).length
	const terminatedCount = staff.length - activeCount
	const terminatingName = editing ? staffName(editing) : ''

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<Input
						type="search"
						className="w-64"
						placeholder={_(msg`Search name, email, or phone`)}
						aria-label={_(msg`Search team`)}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<div role="group" aria-label={_(msg`Status`)} className="flex gap-1">
						<Button
							size="sm"
							variant={status === 'active' ? 'secondary' : 'ghost'}
							aria-pressed={status === 'active'}
							onClick={() => setStatus('active')}
						>
							<Trans>Active ({activeCount})</Trans>
						</Button>
						<Button
							size="sm"
							variant={status === 'terminated' ? 'secondary' : 'ghost'}
							aria-pressed={status === 'terminated'}
							onClick={() => setStatus('terminated')}
						>
							<Trans>Terminated ({terminatedCount})</Trans>
						</Button>
					</div>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="outline" onClick={() => setDialog('settings')}>
						<Trans>Settings</Trans>
					</Button>
					<Button variant="outline" onClick={() => setDialog('positions')}>
						<Trans>Positions</Trans>
					</Button>
					{canWrite ? (
						<>
							<Button
								variant="outline"
								disabled={!locations.some((location) => location.isActive)}
								onClick={() => setDialog('import')}
							>
								<Trans>Add in bulk</Trans>
							</Button>
							<Button
								onClick={() => {
									setEditing(null)
									setDialog('staff')
								}}
							>
								<Icon name="plus" className="size-4" />
								<Trans>Add team member</Trans>
							</Button>
						</>
					) : null}
				</div>
			</div>

			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{!locations.length ? (
				<p className="bg-muted rounded-md p-3 text-sm">
					<Trans>
						Add a location in Settings → Locations before assigning staff.
					</Trans>
				</p>
			) : null}

			{loading ? (
				<p role="status">
					<Trans>Loading team…</Trans>
				</p>
			) : visible.length === 0 ? (
				<div className="rounded-lg border p-8 text-center">
					<h3 className="font-medium">
						{query ? (
							<Trans>No matches</Trans>
						) : status === 'active' ? (
							<Trans>No team members yet</Trans>
						) : (
							<Trans>No terminated team members</Trans>
						)}
					</h3>
					{status === 'active' && !query ? (
						<p className="text-muted-foreground mt-2 text-sm">
							<Trans>
								Add people one at a time, or paste a list with Add in bulk.
							</Trans>
						</p>
					) : null}
				</div>
			) : (
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full text-sm">
						<thead className="bg-muted/50 text-muted-foreground text-start text-xs">
							<tr>
								<th scope="col" className="p-3 text-start font-medium">
									<Trans>Name</Trans>
								</th>
								<th scope="col" className="p-3 text-start font-medium">
									<Trans>Positions</Trans>
								</th>
								<th scope="col" className="p-3 text-start font-medium">
									<Trans>Contact</Trans>
								</th>
								<th scope="col" className="p-3 text-start font-medium">
									<Trans>Status</Trans>
								</th>
								<th scope="col" className="p-3">
									<span className="sr-only">
										<Trans>Actions</Trans>
									</span>
								</th>
							</tr>
						</thead>
						<tbody className="divide-border divide-y">
							{visible.map((member) => {
								const lastDay = member.terminatedOn
								return (
									<tr key={member.id}>
										<td className="p-3">
											<button
												type="button"
												className="text-start font-medium hover:underline"
												onClick={() => {
													setEditing(member)
													setDialog('staff')
												}}
											>
												{staffName(member)}
											</button>
											{member.email && logins.has(member.email) ? (
												<p className="text-muted-foreground text-xs">
													<Trans>Has an App login</Trans>
												</p>
											) : null}
										</td>
										<td className="p-3">
											<div className="flex flex-wrap gap-1">
												{member.assignments.map((assignment) => {
													const position = positionById.get(
														assignment.positionId,
													)
													return (
														<Badge
															key={`${assignment.locationId}-${assignment.positionId}`}
															variant="outline"
														>
															<PositionSwatch color={position?.colorKey} />
															{position?.name ?? _(msg`Unknown`)}
															{locations.length > 1
																? ` · ${locationById.get(assignment.locationId)?.name ?? ''}`
																: ''}
														</Badge>
													)
												})}
											</div>
										</td>
										<td className="p-3">
											<p>{member.email}</p>
											<p className="text-muted-foreground">{member.phone}</p>
										</td>
										<td className="p-3">
											{member.status === 'active' ? (
												<Badge variant="secondary">
													<Trans>Active</Trans>
												</Badge>
											) : (
												<Badge variant="outline">
													<Trans>Terminated {lastDay}</Trans>
												</Badge>
											)}
										</td>
										<td className="p-3 text-end">
											{canWrite && member.status === 'active' ? (
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														setEditing(member)
														setTerminateOn(todayLocal())
														setTerminateReason('')
														setDialog('terminate')
													}}
												>
													<Trans>Terminate</Trans>
												</Button>
											) : null}
											{canWrite && member.status === 'terminated' ? (
												<Button
													size="sm"
													variant="ghost"
													disabled={busy}
													onClick={async () => {
														setBusy(true)
														const message = await attempt(() =>
															request(
																`/staff/${encodeURIComponent(member.id)}/rehire`,
																{ method: 'POST' },
															),
														)
														setBusy(false)
														setError(message)
													}}
												>
													<Trans>Rehire</Trans>
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

			<StaffDialog
				open={dialog === 'staff'}
				onOpenChange={(open) => setDialog(open ? 'staff' : null)}
				staff={editing}
				positions={positions}
				locations={locations}
				canWrite={canWrite}
				onSave={(value) =>
					attempt(() =>
						editing
							? request(`/staff/${encodeURIComponent(editing.id)}`, {
									method: 'PATCH',
									body: JSON.stringify(toInput(value)),
								})
							: request('/staff', {
									method: 'POST',
									body: JSON.stringify(toInput(value)),
								}),
					)
				}
			/>
			<PositionsDialog
				open={dialog === 'positions'}
				onOpenChange={(open) => setDialog(open ? 'positions' : null)}
				positions={positions}
				canWrite={canWrite}
				onCreate={(input) =>
					attempt(async () =>
						positionSchema.parse(
							(
								await request<{ position: unknown }>('/positions', {
									method: 'POST',
									body: JSON.stringify(input),
								})
							).position,
						),
					)
				}
				onUpdate={(id, input) =>
					attempt(() =>
						request(`/positions/${encodeURIComponent(id)}`, {
							method: 'PATCH',
							body: JSON.stringify(input),
						}),
					)
				}
			/>
			<ImportDialog
				open={dialog === 'import'}
				onOpenChange={(open) => setDialog(open ? 'import' : null)}
				locations={locations}
				onImport={async (input) => {
					try {
						const body = await request<{ result: ImportResult }>(
							'/staff/import',
							{ method: 'POST', body: JSON.stringify(input) },
						)
						await refresh()
						return { result: body.result }
					} catch (caught) {
						return { error: staffingErrorMessage(i18n, caught) }
					}
				}}
			/>
			{settings ? (
				<StaffingSettingsDialog
					open={dialog === 'settings'}
					onOpenChange={(open) => setDialog(open ? 'settings' : null)}
					settings={settings}
					canWrite={canWrite}
					onSave={(next) =>
						attempt(async () =>
							settingsSchema.parse(
								(
									await request<{ settings: unknown }>('/settings', {
										method: 'PUT',
										body: JSON.stringify(next),
									})
								).settings,
							),
						)
					}
				/>
			) : null}
			<Dialog
				open={dialog === 'terminate'}
				onOpenChange={(open) => setDialog(open ? 'terminate' : null)}
			>
				<DialogContent className="sm:max-w-md">
					<form
						className="space-y-4"
						onSubmit={async (event) => {
							event.preventDefault()
							if (!editing) return
							setBusy(true)
							const message = await attempt(() =>
								request(`/staff/${encodeURIComponent(editing.id)}/terminate`, {
									method: 'POST',
									body: JSON.stringify({
										terminatedOn: terminateOn,
										reason: terminateReason,
									}),
								}),
							)
							setBusy(false)
							setError(message)
							if (!message) setDialog(null)
						}}
					>
						<DialogHeader>
							<DialogTitle>
								<Trans>Terminate {terminatingName}?</Trans>
							</DialogTitle>
							<DialogDescription>
								<Trans>
									They can no longer clock in. Their shifts after the last day
									become open shifts. Time cards and history are kept, and you
									can rehire them later.
								</Trans>
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-2">
							<Label htmlFor="terminate-on">
								<Trans>Last day</Trans>
							</Label>
							<Input
								id="terminate-on"
								type="date"
								required
								value={terminateOn}
								onChange={(event) => setTerminateOn(event.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="terminate-reason">
								<Trans>Reason (optional, managers only)</Trans>
							</Label>
							<Input
								id="terminate-reason"
								maxLength={500}
								value={terminateReason}
								onChange={(event) => setTerminateReason(event.target.value)}
							/>
						</div>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setDialog(null)}
							>
								<Trans>Cancel</Trans>
							</Button>
							<Button type="submit" variant="destructive" disabled={busy}>
								<Trans>Terminate</Trans>
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	)
}
