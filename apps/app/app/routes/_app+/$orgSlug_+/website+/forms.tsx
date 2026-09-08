import { Trans } from '@lingui/macro'
import { formatDistanceToNow } from 'date-fns'
import { useState } from 'react'
import {
	Form,
	Link,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { EmptyState } from '#app/components/empty-state.tsx'
import { CreateFormDialog } from '#app/components/website/create-form-dialog.tsx'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

type FormField = {
	id: string
	label: string
	type: 'text' | 'email' | 'tel' | 'textarea'
	required: boolean
}
type WebsiteForm = {
	id: string
	name: string
	description: string | null
	fields: FormField[]
	status: 'draft' | 'published'
	submissionCount: number
	updatedAt: string | null
}

const fieldSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
	label: z.string().trim().min(1).max(100),
	type: z.enum(['text', 'email', 'tel', 'textarea']),
	required: z.boolean(),
})
const createSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).default(''),
	fields: z.string().transform((value, context) => {
		try {
			const parsed = z
				.array(fieldSchema)
				.min(1)
				.max(20)
				.safeParse(JSON.parse(value))
			if (parsed.success) return parsed.data
		} catch {}
		context.addIssue({
			code: 'custom',
			message: 'Add at least one valid field.',
		})
		return z.NEVER
	}),
	submitLabel: z.string().trim().min(1).max(50),
	successMessage: z.string().trim().min(1).max(300),
})

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
	try {
		const response = await fetchTenant('/operator/forms')
		if (!response.ok) throw new Error('Regional forms unavailable')
		const data = (await response.json()) as { forms?: WebsiteForm[] }
		return { forms: data.forms ?? [], error: null }
	} catch {
		return {
			forms: [] as WebsiteForm[],
			error:
				'The regional forms database is unavailable. Republish the website or repair its tenant database.',
		}
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const { fetchTenant, orgId } = await getOperatorTenantClient(
		request,
		params.orgSlug || '',
	)
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	const formData = await request.formData()
	const intent = String(formData.get('intent') || '')
	if (intent === 'create') {
		const parsed = createSchema.safeParse(Object.fromEntries(formData))
		if (!parsed.success)
			return {
				error: parsed.error.issues[0]?.message ?? 'Check the form details.',
			}
		const response = await fetchTenant('/operator/forms', {
			method: 'POST',
			body: JSON.stringify({ ...parsed.data, status: 'published' }),
		})
		return response.ok
			? { success: 'Form created.' }
			: { error: 'Unable to create the form.' }
	}
	if (intent === 'delete') {
		const id = String(formData.get('id') || '')
		if (!id) return { error: 'Form not found.' }
		const response = await fetchTenant(`/operator/forms/${id}`, {
			method: 'DELETE',
		})
		return response.ok
			? { success: 'Form deleted.' }
			: { error: 'Unable to delete the form.' }
	}
	return { error: 'Invalid action.' }
}

export default function WebsiteFormsRoute() {
	const { forms, error } = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	const [createOpen, setCreateOpen] = useState(false)
	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Forms</Trans>}
				description={
					<Trans>
						Create reusable forms, then place them on any website page with a
						Form block.
					</Trans>
				}
				headingLevel="h2"
				size="section"
				actions={
					<Button onClick={() => setCreateOpen(true)} disabled={Boolean(error)}>
						<Icon name="plus" className="size-4" />
						<Trans>Create form</Trans>
					</Button>
				}
			/>
			<CreateFormDialog
				open={createOpen}
				onOpenChange={setCreateOpen}
				disabled={Boolean(error)}
			/>
			{error ? (
				<p className="text-destructive text-sm" role="alert">
					{error}
				</p>
			) : null}
			{actionData?.error ? (
				<p className="text-destructive text-sm" role="alert">
					{actionData.error}
				</p>
			) : null}
			{actionData?.success ? (
				<p className="text-sm text-emerald-600" role="status">
					{actionData.success}
				</p>
			) : null}
			{forms.length === 0 ? (
				<EmptyState
					title="No forms yet"
					description="Create a custom form or start from a template, then add it to a page."
					icons={['file-text']}
				/>
			) : (
				<Frame className="overflow-hidden p-0">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>
									<Trans>Name</Trans>
								</TableHead>
								<TableHead className="hidden sm:table-cell">
									<Trans>Fields</Trans>
								</TableHead>
								<TableHead>
									<Trans>Status</Trans>
								</TableHead>
								<TableHead className="hidden md:table-cell">
									<Trans>Updated</Trans>
								</TableHead>
								<TableHead className="text-right">
									<Trans>Responses</Trans>
								</TableHead>
								<TableHead className="w-20" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{forms.map((form) => (
								<TableRow key={form.id}>
									<TableCell>
										<Link
											to={form.id}
											className="hover:text-primary font-medium"
										>
											{form.name}
										</Link>
										{form.description ? (
											<p className="text-muted-foreground mt-1 max-w-md truncate text-xs">
												{form.description}
											</p>
										) : null}
									</TableCell>
									<TableCell className="text-muted-foreground hidden sm:table-cell">
										{form.fields.length}
									</TableCell>
									<TableCell>
										<Badge variant="outline">
											<span
												aria-hidden="true"
												className={
													form.status === 'published'
														? 'size-1.5 rounded-full bg-emerald-500'
														: 'bg-muted-foreground size-1.5 rounded-full'
												}
											/>
											{form.status === 'published' ? (
												<Trans>Published</Trans>
											) : (
												<Trans>Draft</Trans>
											)}
										</Badge>
									</TableCell>
									<TableCell className="text-muted-foreground hidden md:table-cell">
										{form.updatedAt
											? formatDistanceToNow(new Date(form.updatedAt), {
													addSuffix: true,
												})
											: '—'}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										<Link to={form.id} className="hover:text-primary">
											{form.submissionCount}
										</Link>
									</TableCell>
									<TableCell>
										<Form
											method="post"
											onSubmit={(event) => {
												if (
													!window.confirm(
														'Delete this form and all of its responses?',
													)
												)
													event.preventDefault()
											}}
										>
											<input type="hidden" name="intent" value="delete" />
											<input type="hidden" name="id" value={form.id} />
											<Button
												type="submit"
												variant="ghost"
												size="icon-sm"
												aria-label={`Delete ${form.name}`}
											>
												<Icon name="trash-2" className="size-4" />
											</Button>
										</Form>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</Frame>
			)}
		</div>
	)
}
