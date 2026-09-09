import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { PageHeader } from '@repo/ui/page-header'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'

import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

type FormField = { id: string; label: string }
type FormSubmission = {
	id: string
	values: Record<string, string>
	createdAt: string | null
}
type ResponsesPayload = {
	form: { id: string; name: string; fields: FormField[]; status: string }
	submissions: FormSubmission[]
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { fetchTenant, orgId } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
	)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const formId = params.formId || ''
	try {
		const response = await fetchTenant(
			`/operator/forms/${encodeURIComponent(formId)}/submissions`,
			{ signal: AbortSignal.timeout(3000) },
		)
		if (!response.ok) throw new Error('Unable to load responses')
		return {
			payload: (await response.json()) as ResponsesPayload,
			error: null,
		}
	} catch {
		return { payload: null, error: 'Unable to load responses' }
	}
}

export default function WebsiteFormResponsesRoute() {
	const { payload, error } = useLoaderData<typeof loader>()

	const form = payload?.form
	const submissions = payload?.submissions ?? []

	return (
		<div className="max-w-6xl space-y-6">
			<div className="flex items-start justify-between gap-4">
				<PageHeader
					title={form?.name ?? 'Form responses'}
					description="Responses are loaded securely through the app server from the regional tenant database."
				/>
				<Button render={<Link to=".." />} variant="outline">
					Back to forms
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{form ? (
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full text-left text-sm">
						<thead className="bg-muted/50 border-b">
							<tr>
								<th className="px-4 py-3 font-medium">Submitted</th>
								{form.fields.map((field) => (
									<th key={field.id} className="px-4 py-3 font-medium">
										{field.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody className="divide-y">
							{submissions.length === 0 ? (
								<tr>
									<td
										colSpan={form.fields.length + 1}
										className="text-muted-foreground px-4 py-10 text-center"
									>
										No responses yet.
									</td>
								</tr>
							) : (
								submissions.map((submission) => (
									<tr key={submission.id}>
										<td className="px-4 py-3 whitespace-nowrap">
											<Badge variant="outline">
												{submission.createdAt
													? new Date(submission.createdAt).toLocaleString()
													: 'Unknown'}
											</Badge>
										</td>
										{form.fields.map((field) => (
											<td
												key={field.id}
												className="max-w-sm px-4 py-3 align-top whitespace-pre-wrap"
											>
												{submission.values[field.id] || '—'}
											</td>
										))}
									</tr>
								))
							)}
						</tbody>
					</table>
				</div>
			) : null}
		</div>
	)
}
