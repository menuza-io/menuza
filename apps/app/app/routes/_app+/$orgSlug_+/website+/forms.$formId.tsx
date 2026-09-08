import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { PageHeader } from '@repo/ui/page-header'
import { useEffect, useState } from 'react'
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
	const { jwt, tenantApiUrl, orgId } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
	)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	return { jwt, tenantApiUrl, formId: params.formId || '' }
}

export default function WebsiteFormResponsesRoute() {
	const { jwt, tenantApiUrl, formId } = useLoaderData<typeof loader>()
	const [payload, setPayload] = useState<ResponsesPayload | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const controller = new AbortController()
		void fetch(`${tenantApiUrl}/operator/forms/${formId}/submissions`, {
			headers: { Authorization: `Bearer ${jwt}` },
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) throw new Error('Unable to load responses')
				setPayload((await response.json()) as ResponsesPayload)
			})
			.catch((caught) => {
				if (!controller.signal.aborted) {
					setError(
						caught instanceof Error
							? caught.message
							: 'Unable to load responses',
					)
				}
			})
		return () => controller.abort()
	}, [formId, jwt, tenantApiUrl])

	const form = payload?.form
	const submissions = payload?.submissions ?? []

	return (
		<div className="max-w-6xl space-y-6">
			<div className="flex items-start justify-between gap-4">
				<PageHeader
					title={form?.name ?? 'Form responses'}
					description="Responses load directly from the regional tenant database and do not pass through the app server."
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
			{!payload && !error ? (
				<p className="text-muted-foreground text-sm">Loading responses…</p>
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
