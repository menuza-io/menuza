import { getFormProps, getInputProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod/v4'
import { Trans, t } from '@lingui/macro'
import { type SEOHandle } from '@nasa-gcn/remix-seo'
import { useIsPending } from '@repo/common'
import { checkHoneypot } from '@repo/security'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { StatusButton } from '@repo/ui/status-button'
import { useState } from 'react'
import { Form, Link, useSearchParams } from 'react-router'
import { HoneypotInputs } from 'remix-utils/honeypot/react'
import { z } from 'zod'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList, OTPField } from '#app/components/forms.tsx'

import { type Route } from './+types/verify.ts'
import { validateRequest } from './verify.server.tsx'

export const handle: SEOHandle = {
	getSitemapEntries: () => null,
}

export const codeQueryParam = 'code'
export const targetQueryParam = 'target'
export const typeQueryParam = 'type'
export const redirectToQueryParam = 'redirectTo'
const types = ['onboarding', 'reset-password', 'change-email', '2fa'] as const
const VerificationTypeSchema = z.enum(types)
export type VerificationTypes = z.infer<typeof VerificationTypeSchema>

// Accept both 6-char TOTP codes and 8-9 char backup codes (XXXX-XXXX format)
export const VerifySchema = z.object({
	[codeQueryParam]: z.string().min(6).max(9),
	[typeQueryParam]: VerificationTypeSchema,
	[targetQueryParam]: z.string(),
	[redirectToQueryParam]: z.string().optional(),
})

export async function action({ request }: Route.ActionArgs) {
	const formData = await request.formData()
	await checkHoneypot(formData)
	return validateRequest(request, formData)
}

export default function VerifyRoute({ actionData }: Route.ComponentProps) {
	const [searchParams] = useSearchParams()
	const isPending = useIsPending()
	const [useBackupCode, setUseBackupCode] = useState(false)
	const parseWithZoddType = VerificationTypeSchema.safeParse(
		searchParams.get(typeQueryParam),
	)
	const type = parseWithZoddType.success ? parseWithZoddType.data : null

	const checkEmail = {
		title: t`Check your email`,
		description: t`We've sent you a code to verify your email address.`,
	}

	const headings: Record<
		VerificationTypes,
		{ title: string; description: string }
	> = {
		onboarding: checkEmail,
		'reset-password': checkEmail,
		'change-email': checkEmail,
		'2fa': {
			title: useBackupCode ? t`Enter backup code` : t`Check your 2FA app`,
			description: useBackupCode
				? t`Enter one of your backup codes to verify your identity.`
				: t`Please enter your 2FA code to verify your identity.`,
		},
	}

	const [form, fields] = useForm({
		id: 'verify-form',
		constraint: getZodConstraint(VerifySchema),
		lastResult: actionData?.result,
		onValidate({ formData }) {
			return parseWithZod(formData, { schema: VerifySchema })
		},
		defaultValue: {
			code: searchParams.get(codeQueryParam),
			type: type,
			target: searchParams.get(targetQueryParam),
			redirectTo: searchParams.get(redirectToQueryParam),
		},
	})

	const currentHeading = type
		? headings[type]
		: {
				title: t`Invalid Verification Type`,
				description: t`Please check your verification link.`,
			}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-xl">{currentHeading.title}</CardTitle>
				<CardDescription>{currentHeading.description}</CardDescription>
			</CardHeader>
			<CardContent>
				<Form method="POST" {...getFormProps(form)}>
					<HoneypotInputs />
					<div className="grid gap-6">
						{type === '2fa' && useBackupCode ? (
							<div className="space-y-2">
								<Label htmlFor={fields[codeQueryParam].id}>
									<Trans>Backup Code</Trans>
								</Label>
								<Input
									{...getInputProps(fields[codeQueryParam], { type: 'text' })}
									placeholder="XXXX-XXXX"
									autoComplete="off"
									autoFocus
									className="text-center font-mono text-lg tracking-widest"
								/>
								{fields[codeQueryParam].errors && (
									<ErrorList
										errors={fields[codeQueryParam].errors}
										id={`${fields[codeQueryParam].id}-error`}
									/>
								)}
							</div>
						) : (
							<div className="flex items-center justify-center">
								<OTPField
									labelProps={{
										htmlFor: fields[codeQueryParam].id,
										children: <Trans>Verification Code</Trans>,
									}}
									inputProps={{
										...getInputProps(fields[codeQueryParam], { type: 'text' }),
										autoComplete: 'one-time-code',
										autoFocus: true,
									}}
									errors={fields[codeQueryParam].errors}
								/>
							</div>
						)}

						<input
							{...getInputProps(fields[typeQueryParam], { type: 'hidden' })}
						/>
						<input
							{...getInputProps(fields[targetQueryParam], { type: 'hidden' })}
						/>
						<input
							{...getInputProps(fields[redirectToQueryParam], {
								type: 'hidden',
							})}
						/>

						<ErrorList errors={form.errors} id={form.errorId} />

						<StatusButton
							className="w-full"
							status={isPending ? 'pending' : (form.status ?? 'idle')}
							type="submit"
							disabled={isPending}
						>
							<Trans>Verify</Trans>
						</StatusButton>

						{type === 'reset-password' && (
							<Link
								to="/forgot-password"
								className="text-muted-foreground text-center text-sm underline-offset-4 hover:underline"
							>
								<Trans>Need a new code? Request one here.</Trans>
							</Link>
						)}

						{type === '2fa' && (
							<Button
								type="button"
								variant="link"
								className="text-muted-foreground text-sm"
								onClick={() => setUseBackupCode(!useBackupCode)}
							>
								{useBackupCode ? (
									<Trans>Use authenticator app instead</Trans>
								) : (
									<Trans>Use a backup code instead</Trans>
								)}
							</Button>
						)}
					</div>
				</Form>
			</CardContent>
		</Card>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
