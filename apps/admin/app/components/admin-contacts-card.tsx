import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	ASSIGNMENT_ROLES,
	ASSIGNMENT_ROLE_LABELS,
} from '@repo/common/support-assignments'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Form } from 'react-router'

export type ContactView = {
	id: string
	roleLabel: string
	adminName: string
	locationName: string | null
	startedAt: string
	endedAt: string | null
	assignedByName: string | null
	endedByName: string | null
}

/**
 * The restaurant's Menuza contacts (#272): who holds each role, for all
 * locations or one, and the history. Assigning names a person and routes
 * support requests; it gives no access.
 */
export function AdminContactsCard({
	organizationId,
	open,
	history,
	team,
	locations,
}: {
	organizationId: string
	open: ContactView[]
	history: ContactView[]
	team: Array<{ id: string; name: string }>
	locations: Array<{ id: string; name: string }>
}) {
	const { _ } = useLingui()
	const action = `/organizations/${organizationId}/assignments`
	return (
		<Card id="contacts">
			<CardHeader>
				<CardTitle>
					<Trans>Menuza contacts</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Who looks after this restaurant. The restaurant sees a first name
						only, and new requests go to the support contact first. Assigning
						gives no extra access.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				{open.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						<Trans>Nobody is assigned yet.</Trans>
					</p>
				) : (
					<ul className="divide-y text-sm">
						{open.map((row) => (
							<li
								key={row.id}
								className="flex items-center justify-between gap-3 py-2"
							>
								<div>
									<span className="font-medium">{row.adminName}</span>{' '}
									<span className="text-muted-foreground">
										· {row.roleLabel} ·{' '}
										{row.locationName ?? _(msg`All locations`)}
									</span>
								</div>
								<Form method="post" action={action}>
									<input type="hidden" name="intent" value="unassign" />
									<input type="hidden" name="assignmentId" value={row.id} />
									<Button type="submit" variant="ghost" size="sm">
										<Trans>Remove</Trans>
									</Button>
								</Form>
							</li>
						))}
					</ul>
				)}

				<Form
					method="post"
					action={action}
					className="flex flex-wrap items-end gap-3"
				>
					<input type="hidden" name="intent" value="assign" />
					<label className="text-sm">
						<span className="text-muted-foreground block text-xs">
							<Trans>Role</Trans>
						</span>
						<select
							name="role"
							className="bg-background h-8 rounded-md border px-2"
						>
							{ASSIGNMENT_ROLES.map((role) => (
								<option key={role} value={role}>
									{ASSIGNMENT_ROLE_LABELS[role]}
								</option>
							))}
						</select>
					</label>
					<label className="text-sm">
						<span className="text-muted-foreground block text-xs">
							<Trans>Team member</Trans>
						</span>
						<select
							name="adminUserId"
							required
							className="bg-background h-8 rounded-md border px-2"
						>
							<option value="">{_(msg`Choose a person`)}</option>
							{team.map((person) => (
								<option key={person.id} value={person.id}>
									{person.name}
								</option>
							))}
						</select>
					</label>
					<label className="text-sm">
						<span className="text-muted-foreground block text-xs">
							<Trans>Location</Trans>
						</span>
						<select
							name="locationId"
							className="bg-background h-8 rounded-md border px-2"
						>
							<option value="all">{_(msg`All locations`)}</option>
							{locations.map((location) => (
								<option key={location.id} value={location.id}>
									{location.name}
								</option>
							))}
						</select>
					</label>
					<Button type="submit">
						<Trans>Assign or reassign</Trans>
					</Button>
				</Form>

				{history.length > 0 ? (
					<div>
						<h3 className="mb-2 text-sm font-medium">
							<Trans>History</Trans>
						</h3>
						<ul className="text-muted-foreground space-y-1 text-xs">
							{history.map((row) => (
								<li key={row.id}>
									{row.adminName} · {row.roleLabel} ·{' '}
									{row.locationName ?? _(msg`All locations`)} ·{' '}
									{new Date(row.startedAt).toLocaleDateString()} –{' '}
									{row.endedAt
										? new Date(row.endedAt).toLocaleDateString()
										: ''}
									{row.endedByName ? ` (${row.endedByName})` : ''}
								</li>
							))}
						</ul>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}
