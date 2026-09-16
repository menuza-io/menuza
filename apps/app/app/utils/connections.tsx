import {
	type ProviderName,
	providerLabels,
	GITHUB_PROVIDER_NAME,
	GOOGLE_PROVIDER_NAME,
} from '@repo/auth/constants'
import { useIsPending } from '@repo/common'
import { Icon } from '@repo/ui/icon'
import { StatusButton } from '@repo/ui/status-button'
import { Form, useRouteLoaderData } from 'react-router'
import { type loader as rootLoader } from '#app/root.tsx'
import { saveLastLoginMethod, type LoginMethod } from './last-login-method.ts'

export function useConfiguredProviders() {
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	return rootData?.configuredProviders ?? []
}

export const providerIcons: Record<ProviderName, React.ReactNode> = {
	[GITHUB_PROVIDER_NAME]: <Icon name="github" />,
	[GOOGLE_PROVIDER_NAME]: <Icon name="google" />,
} as const

export function ProviderConnectionForm({
	redirectTo,
	type,
	providerName,
}: {
	redirectTo?: string | null
	type: 'Connect' | 'Login' | 'Signup'
	providerName: ProviderName
}) {
	const configuredProviders = useConfiguredProviders()
	const label = providerLabels[providerName]
	const formAction = `/auth/${providerName}`
	const isPending = useIsPending({ formAction })
	if (!configuredProviders.includes(providerName)) return null

	return (
		<Form
			className="flex items-center justify-center gap-2"
			action={formAction}
			method="POST"
			onSubmit={() => {
				// Save the login method when form is submitted
				if (
					type === 'Login' &&
					(providerName === 'github' || providerName === 'google')
				) {
					saveLastLoginMethod(providerName as LoginMethod)
				}
			}}
		>
			{redirectTo ? (
				<input type="hidden" name="redirectTo" value={redirectTo} />
			) : null}
			<StatusButton
				type="submit"
				className="w-full"
				status={isPending ? 'pending' : 'idle'}
			>
				<span className="inline-flex items-center gap-1.5">
					{providerIcons[providerName]}
					<span>
						{type} with {label}
					</span>
				</span>
			</StatusButton>
		</Form>
	)
}
