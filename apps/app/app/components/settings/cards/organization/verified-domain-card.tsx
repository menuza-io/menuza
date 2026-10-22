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
import { Icon } from '@repo/ui/icon'
import { Switch } from '@repo/ui/switch'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import { z } from 'zod'
import { ErrorList, Field } from '#app/components/forms.tsx'
import { useConformSaveBar } from '#app/components/save-bar.tsx'

export const VerifiedDomainSchema = z.object({
	intent: z.string().optional(),
	verifiedDomain: z.string().min(1, 'Domain is required'),
	organizationId: z.string(),
})

export default function VerifiedDomainCard({
	organization,
	actionData,
}: {
	organization: { id: string; verifiedDomain?: string | null }
	actionData?: any
}) {
	const [isChecked, setIsChecked] = useState(!!organization.verifiedDomain)
	const saveFetcher = useFetcher()

	const [form, fields] = useForm({
		id: 'verified-domain',
		constraint: getZodConstraint(VerifiedDomainSchema),
		lastResult: saveFetcher.data?.result ?? actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, {
				schema: VerifiedDomainSchema,
			})
		},
		// Hidden inputs belong in the defaults, or Conform reports the form dirty.
		defaultValue: {
			intent: 'verified-domain',
			verifiedDomain: organization.verifiedDomain || '',
			organizationId: organization.id,
		},
	})

	const toggleFetcher = useFetcher()
	useConformSaveBar(form, saveFetcher)

	const handleSwitchChange = (checked: boolean) => {
		setIsChecked(checked)
		form.reset()
		if (!checked) {
			void toggleFetcher.submit(
				{ intent: 'toggle-verified-domain', organizationId: organization.id },
				{ method: 'POST' },
			)
		}
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<CardTitle className="flex gap-2">
						<Switch checked={isChecked} onCheckedChange={handleSwitchChange} />
						<span>
							<Trans>Verified domain</Trans>
						</span>
					</CardTitle>
				</div>
				<CardDescription>
					<Trans>
						When someone signs up using an email that matches your verified
						domain, they will be automatically added to your organization as a
						member.
					</Trans>
				</CardDescription>
			</CardHeader>
			<div
				className={`grid transition-[grid-template-rows] duration-300 ease-out ${
					isChecked ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
				}`}
			>
				<div className="overflow-hidden">
					<saveFetcher.Form method="POST" {...getFormProps(form)}>
						<input type="hidden" name="intent" value="verified-domain" />
						<input
							{...getInputProps(fields.organizationId, { type: 'hidden' })}
						/>
						<CardContent className="pb-4">
							<FieldGroup>
								<Field
									labelProps={{ children: <Trans>Verified domain</Trans> }}
									inputProps={{
										...getInputProps(fields.verifiedDomain, { type: 'text' }),
										placeholder: 'example.com',
									}}
									className="w-full pt-2"
									errors={fields.verifiedDomain.errors}
								/>
							</FieldGroup>
							<ErrorList id={form.errorId} errors={form.errors} />
						</CardContent>
						<CardFooter className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
							<div className="text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs">
								<Icon name="help-circle" className="mt-0.5 h-4 w-4 shrink-0" />
								<p className="text-pretty">
									<Trans>
										Verified domain must match your current email address domain
										for security.{' '}
										<a href="#" className="underline">
											Learn more
										</a>
									</Trans>
								</p>
							</div>
						</CardFooter>
					</saveFetcher.Form>
				</div>
			</div>
		</Card>
	)
}
