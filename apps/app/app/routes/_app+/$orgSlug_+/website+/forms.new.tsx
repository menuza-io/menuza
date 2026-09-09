import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { toPublicFormProjection } from '@repo/common/public-form'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState } from 'react'
import {
	Form,
	Link,
	redirect,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useNavigation,
} from 'react-router'
import { z } from 'zod'

import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { setCachedPublicForm } from '#app/utils/sites/kv-cache.server.ts'
import {
	FORM_TEMPLATES,
	getFormTemplate,
} from '#app/utils/website/form-templates.ts'
import { parseTenantFormResponse } from '#app/utils/website/tenant-form-response.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

const createSchema = z.object({
	name: z.string().trim().min(1).max(120),
	template: z.string(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	const { orgId } = await getOperatorTenantClient(request, params.orgSlug || '')
	await requireUserWithOrganizationPermission(
		request,
		orgId,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	return null
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
	const parsed = createSchema.safeParse(
		Object.fromEntries(await request.formData()),
	)
	if (!parsed.success) return { error: 'Choose a template and enter a name.' }
	const template = getFormTemplate(parsed.data.template)
	if (!template) return { error: 'Template not found.' }
	const response = await fetchTenant('/operator/forms', {
		method: 'POST',
		body: JSON.stringify({
			name: parsed.data.name,
			description: '',
			fields: template.fields,
			submitLabel: 'Submit',
			successMessage: 'Thank you. Your response has been received.',
			status: 'draft',
		}),
	})
	if (!response.ok) return { error: 'Unable to create the form.' }
	const payload = await response.json().catch(() => null)
	const createdForm = parseTenantFormResponse(payload)
	if (!createdForm) return { error: 'Unable to create the form.' }
	const projection = toPublicFormProjection(createdForm)
	if (projection) await setCachedPublicForm(orgId, projection)
	return redirect(`/${params.orgSlug}/website/forms/${createdForm.id}`)
}

export default function NewWebsiteFormRoute() {
	const { _ } = useLingui()
	const [selected, setSelected] = useState('blank')
	const actionData = useActionData<typeof action>()
	const navigation = useNavigation()
	const isCreating = navigation.state !== 'idle'
	const templates = FORM_TEMPLATES.map((template) => ({
		...template,
		name: _(template.name),
		description: _(template.description),
	}))
	return (
		<div className="bg-background fixed inset-0 z-50 flex h-dvh flex-col overflow-auto">
			<header className="border-border flex h-12 shrink-0 items-center border-b px-3">
				<Button
					variant="ghost"
					size="icon-xs"
					render={<Link to=".." relative="path" />}
					aria-label="Back to forms"
				>
					<Icon name="arrow-left" className="size-4" />
				</Button>
				<div className="bg-border mx-3 h-5 w-px" aria-hidden />
				<span className="text-sm font-medium">
					<Trans>New form</Trans>
				</span>
			</header>

			<main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-5 py-12 sm:px-8">
				<div className="mb-8 max-w-2xl">
					<p className="text-muted-foreground mb-2 text-sm">
						<Trans>Choose a starting point</Trans>
					</p>
					<h1 className="text-3xl font-semibold tracking-tight">
						<Trans>What would you like to collect?</Trans>
					</h1>
					<p className="text-muted-foreground mt-3 text-sm leading-relaxed">
						<Trans>
							Pick a template, then customize every field in the builder.
						</Trans>
					</p>
				</div>

				<Form method="post" className="space-y-8">
					<input type="hidden" name="template" value={selected} />
					<div className="grid gap-4 md:grid-cols-2">
						{templates.map((template) => (
							<button
								key={template.id}
								type="button"
								onClick={() => setSelected(template.id)}
								aria-pressed={selected === template.id}
								className={cn(
									'border-border bg-card hover:border-primary/50 focus-visible:ring-ring rounded-xl border p-5 text-left transition-[border-color,box-shadow,transform] duration-150 focus-visible:ring-2 focus-visible:outline-none active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100',
									selected === template.id &&
										'border-primary ring-primary/15 ring-4',
								)}
							>
								<div className="mb-5 flex items-start justify-between gap-4">
									<div>
										<h2 className="font-medium">{template.name}</h2>
										<p className="text-muted-foreground mt-1 text-sm">
											{template.description}
										</p>
									</div>
									<span
										className={cn(
											'border-border flex size-5 shrink-0 items-center justify-center rounded-full border',
											selected === template.id &&
												'border-primary bg-primary text-primary-foreground',
										)}
									>
										{selected === template.id ? (
											<Icon name="check" className="size-3" />
										) : null}
									</span>
								</div>
								<div className="space-y-2">
									{template.fields.slice(0, 3).map((field) => (
										<div
											key={field.id}
											className="bg-muted/60 h-8 rounded-md px-3 py-2 text-xs"
										>
											{field.label}
										</div>
									))}
								</div>
							</button>
						))}
					</div>

					<div className="border-border flex flex-col gap-4 border-t pt-6 sm:flex-row sm:items-end sm:justify-between">
						<div className="w-full max-w-sm space-y-2">
							<Label htmlFor="form-name">
								<Trans>Form name</Trans>
							</Label>
							<Input
								id="form-name"
								name="name"
								placeholder="Contact us"
								required
								maxLength={120}
								autoFocus
							/>
						</div>
						<div className="flex flex-col items-end gap-2">
							{actionData?.error ? (
								<p className="text-destructive text-sm" role="alert">
									{actionData.error}
								</p>
							) : null}
							<Button type="submit" size="lg" disabled={isCreating}>
								<Trans>Create and customize</Trans>
								<Icon name="arrow-right" className="size-4" />
							</Button>
						</div>
					</div>
				</Form>
			</main>
		</div>
	)
}
