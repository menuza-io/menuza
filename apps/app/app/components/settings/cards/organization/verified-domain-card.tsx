import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
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

type DomainClaim = { domain: string; recordName: string; recordValue: string }

export default function VerifiedDomainCard({
	organization,
	actionData,
}: {
	organization: {
		id: string
		verifiedDomain?: string | null
		verifiedDomainProvedAt?: Date | string | null
		domainClaim?: DomainClaim | null
	}
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
	const checkFetcher = useFetcher<{
		domainCheck?: { status: string; message: string }
	}>()
	useConformSaveBar(form, saveFetcher)
	// A claim just started (save response) or one still waiting (loader).
	const claim: DomainClaim | null =
		saveFetcher.data?.domainClaim ?? organization.domainClaim ?? null
	const verifiedDomain = organization.verifiedDomain
	const claimDomain = claim?.domain
	const needsReverification =
		Boolean(organization.verifiedDomain) &&
		!organization.verifiedDomainProvedAt &&
		!claim

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
						Prove you control your domain with a DNS record. People who sign up
						with an email on that domain then join your organization as members,
						and people who already have an account are invited.
					</Trans>
				</CardDescription>
				{organization.verifiedDomain && organization.verifiedDomainProvedAt ? (
					<p className="flex items-center gap-1.5 text-sm">
						<Icon name="check" className="size-4" />
						<Trans>{verifiedDomain} is verified.</Trans>
					</p>
				) : null}
				{needsReverification ? (
					<p className="text-muted-foreground text-sm">
						<Trans>
							{verifiedDomain} was added before DNS proof was required. Save it
							again below to get a DNS record, then check it to finish
							verifying.
						</Trans>
					</p>
				) : null}
			</CardHeader>
			<div
				className={`grid transition-[grid-template-rows] duration-240 ease-out ${
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
						{claim ? (
							<CardContent className="space-y-3 pb-4">
								<p className="text-sm">
									<Trans>
										To verify {claimDomain}, add this TXT record at your DNS
										provider, then check it.
									</Trans>
								</p>
								<dl className="bg-muted grid gap-2 rounded-md p-3 font-mono text-xs break-all">
									<div>
										<dt className="text-muted-foreground font-sans">
											<Trans>Name</Trans>
										</dt>
										<dd>{claim.recordName}</dd>
									</div>
									<div>
										<dt className="text-muted-foreground font-sans">
											<Trans>Value</Trans>
										</dt>
										<dd>{claim.recordValue}</dd>
									</div>
								</dl>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={checkFetcher.state !== 'idle'}
									onClick={() =>
										void checkFetcher.submit(
											{
												intent: 'check-verified-domain',
												organizationId: organization.id,
											},
											{ method: 'POST' },
										)
									}
								>
									{checkFetcher.state !== 'idle' ? (
										<Trans>Checking…</Trans>
									) : (
										<Trans>Check DNS record</Trans>
									)}
								</Button>
								{checkFetcher.data?.domainCheck ? (
									<p className="text-destructive text-sm" role="alert">
										{checkFetcher.data.domainCheck.message}
									</p>
								) : null}
							</CardContent>
						) : null}
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
