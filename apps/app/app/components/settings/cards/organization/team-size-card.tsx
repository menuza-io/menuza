import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { t, Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Field, FieldLabel, FieldError } from '@repo/ui/field'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Form } from 'react-router'
import { z } from 'zod'
import {
	ErrorList,
	convertErrorsToFieldFormat,
} from '#app/components/forms.tsx'

export const TeamSizeSchema = z.object({
	size: z.string().min(1, 'Team size is required'),
	organizationId: z.string(),
})

export default function TeamSizeCard({
	organization,
	actionData,
}: {
	organization: { id: string; size?: string | null }
	actionData?: any
}) {
	const [form, fields] = useForm({
		id: 'team-size-form',
		constraint: getZodConstraint(TeamSizeSchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: TeamSizeSchema })
		},
		defaultValue: {
			size: organization.size || '',
			organizationId: organization.id,
		},
	})

	const teamSizeOptions = [
		{ value: '1-10', label: t`1-10 people` },
		{ value: '11-50', label: t`11-50 people` },
		{ value: '51-200', label: t`51-200 people` },
		{ value: '201-500', label: t`201-500 people` },
		{ value: '500+', label: t`500+ people` },
	]

	return (
		<Form method="POST" {...getFormProps(form)}>
			<Card>
				<CardHeader className="pb-3">
					<CardTitle className="text-base">
						<Trans>Team Size</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>Help us tailor recommendations to your restaurant.</Trans>
					</CardDescription>
				</CardHeader>
				<input type="hidden" name="intent" value="update-team-size" />
				<input {...getInputProps(fields.organizationId, { type: 'hidden' })} />
				<CardContent className="pt-0">
					<Field data-invalid={fields.size.errors?.length ? true : undefined}>
						<FieldLabel htmlFor={fields.size.id}>
							<Trans>Restaurant Size</Trans>
						</FieldLabel>
						<div className="flex flex-col gap-3 sm:flex-row sm:items-start">
							<div className="min-w-0 flex-1">
								<Select
									name={fields.size.name}
									defaultValue={organization.size || ''}
									items={[
										{ label: 'Select team size', value: null },
										...teamSizeOptions,
									]}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{teamSizeOptions.map((option) => (
											<SelectItem key={option.value} value={option.value}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<FieldError
									errors={convertErrorsToFieldFormat(fields.size.errors)}
								/>
							</div>
							<Button
								size="sm"
								type="submit"
								className="shrink-0 self-stretch sm:self-auto"
							>
								<Trans>Update</Trans>
							</Button>
						</div>
					</Field>
					<ErrorList errors={form.errors} id={form.errorId} />
				</CardContent>
			</Card>
		</Form>
	)
}
