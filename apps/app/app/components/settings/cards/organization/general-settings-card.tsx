import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { Trans } from '@lingui/macro'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { FieldGroup } from '@repo/ui/field'
import { StatusButton } from '@repo/ui/status-button'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import { Field, ErrorList } from '#app/components/forms.tsx'

import { OrganizationPhoto } from './organization-photo-card'

const SettingsSchema = z.object({
	name: z.string().min(1, 'Name is required'),
	slug: z.string().min(1, 'Slug is required'),
})

export const organizationUpdateActionIntent = 'update-settings'

interface Organization {
	id: string
	name: string
	slug: string
	image?: { objectKey: string; id: string } | null
}

export function GeneralSettingsCard({
	organization,
}: {
	organization: Organization
}) {
	const fetcher = useFetcher()

	const [form, fields] = useForm({
		id: 'organization-settings-form',
		constraint: getZodConstraint(SettingsSchema),
		lastResult: fetcher.data?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: SettingsSchema })
		},
		defaultValue: {
			name: organization.name,
			slug: organization.slug,
		},
	})

	return (
		<Card>
			<CardHeader>
				<CardTitle>
					<Trans>General Settings</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>Manage your restaurant's name, slug, and profile image.</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="pt-6">
				<div className="mb-6 flex flex-col gap-6 md:flex-row">
					<div className="h-32 w-32 shrink-0">
						<OrganizationPhoto organization={organization} size="small" />
					</div>
					<div className="grow">
						<fetcher.Form method="POST" {...getFormProps(form)}>
							<input
								type="hidden"
								name="intent"
								value={organizationUpdateActionIntent}
							/>
							<FieldGroup>
								<Field
									labelProps={{
										htmlFor: fields.name.id,
										children: <Trans>Name</Trans>,
									}}
									inputProps={getInputProps(fields.name, { type: 'text' })}
									errors={fields.name.errors}
								/>
								<Field
									labelProps={{
										htmlFor: fields.slug.id,
										children: <Trans>Slug</Trans>,
									}}
									inputProps={getInputProps(fields.slug, { type: 'text' })}
									errors={fields.slug.errors}
								/>
							</FieldGroup>
							<ErrorList id={form.errorId} errors={form.errors} />
						</fetcher.Form>
					</div>
				</div>
			</CardContent>
			<CardFooter className="justify-end">
				<StatusButton
					size="sm"
					form={form.id}
					type="submit"
					name="intent"
					value={organizationUpdateActionIntent}
					status={
						fetcher.state !== 'idle' ? 'pending' : (form.status ?? 'idle')
					}
				>
					<Trans>Save changes</Trans>
				</StatusButton>
			</CardFooter>
		</Card>
	)
}
