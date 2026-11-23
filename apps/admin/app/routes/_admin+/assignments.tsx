import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserWithRole } from '@repo/auth'
import {
	ASSIGNMENT_ROLES,
	ASSIGNMENT_ROLE_LABELS,
	isAssignmentRole,
	type AssignmentRole,
} from '@repo/common/support-assignments'
import { redirectWithToast } from '@repo/common/toast'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { PageHeader } from '@repo/ui/page-header'
import {
	Form,
	data,
	useLoaderData,
	type ActionFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { bulkReassign, listTeamMembers } from '#app/utils/assignments.server.ts'

export async function loader({ request }: { request: Request }) {
	await requireUserWithRole(request, 'admin')
	return { team: await listTeamMembers() }
}

const BulkSchema = z.object({
	fromUserId: z.string().trim().min(1).max(64),
	toUserId: z.string().trim().min(1).max(64),
})

/** Hand every restaurant of one team member to another when someone leaves (#272). */
export async function action({ request }: ActionFunctionArgs) {
	const agentId = await requireUserWithRole(request, 'admin')
	const form = await request.formData()
	const parsed = BulkSchema.safeParse(Object.fromEntries(form))
	if (!parsed.success) throw data({ error: 'invalid' }, { status: 400 })
	const roles = form
		.getAll('role')
		.map(String)
		.filter((role): role is AssignmentRole => isAssignmentRole(role))
	const result = await bulkReassign({
		...parsed.data,
		byAgentId: agentId,
		roles,
		request,
	})
	if (result.status !== 'ok') {
		return redirectWithToast('/assignments', {
			type: 'error',
			title: 'Nothing moved',
			description:
				result.status === 'same_person'
					? 'Choose two different people.'
					: 'The new contact must be on the Admin team.',
		})
	}
	return redirectWithToast('/assignments', {
		type: 'success',
		title: 'Reassigned',
		description: `${result.moved} assignment${result.moved === 1 ? '' : 's'} moved.`,
	})
}

export default function AssignmentsPage() {
	const { team } = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	return (
		<div className="space-y-6">
			<PageHeader
				title={<Trans>Assignments</Trans>}
				description={
					<Trans>
						Move every restaurant one team member looks after to someone else.
					</Trans>
				}
			/>
			<Card className="max-w-xl">
				<CardHeader>
					<CardTitle>
						<Trans>Reassign in bulk</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							History is kept: each restaurant shows who held the role and until
							when. This gives nobody extra access.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form method="post" className="space-y-4">
						<label className="block text-sm">
							<span className="block font-medium">
								<Trans>From</Trans>
							</span>
							<select
								name="fromUserId"
								required
								className="bg-background mt-1 h-8 w-full rounded-md border px-2"
							>
								<option value="">{_(msg`Choose a person`)}</option>
								{team.map((person) => (
									<option key={person.id} value={person.id}>
										{person.name}
									</option>
								))}
							</select>
						</label>
						<label className="block text-sm">
							<span className="block font-medium">
								<Trans>To</Trans>
							</span>
							<select
								name="toUserId"
								required
								className="bg-background mt-1 h-8 w-full rounded-md border px-2"
							>
								<option value="">{_(msg`Choose a person`)}</option>
								{team.map((person) => (
									<option key={person.id} value={person.id}>
										{person.name}
									</option>
								))}
							</select>
						</label>
						<fieldset className="space-y-1 text-sm">
							<legend className="font-medium">
								<Trans>Roles to move (none selected moves all)</Trans>
							</legend>
							{ASSIGNMENT_ROLES.map((role) => (
								<label key={role} className="flex items-center gap-2">
									<input type="checkbox" name="role" value={role} />
									{ASSIGNMENT_ROLE_LABELS[role]}
								</label>
							))}
						</fieldset>
						<Button type="submit">
							<Trans>Reassign</Trans>
						</Button>
					</Form>
				</CardContent>
			</Card>
		</div>
	)
}
