import { Trans } from '@lingui/macro'
import { getCrossAppUrl } from '@repo/common/url'
import { Card, CardContent, CardFooter, CardHeader } from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { StatusButton } from '@repo/ui/status-button'
import { useState } from 'react'
import { useFetcher, Form } from 'react-router'

import { JiraIntegrationSettings } from './jira-integration-settings'

export const connectIntegrationActionIntent = 'connect-integration'
export const disconnectIntegrationActionIntent = 'disconnect-integration'

interface Integration {
	id: string
	providerName: string
	providerType: string
	isActive: boolean
	lastSyncAt: Date | null
	config: any
	_count?: {
		connections: number
	}
}

interface IntegrationsCardProps {
	integrations: Integration[]
	availableProviders: Array<{
		name: string
		type: string
		displayName: string
		description: string
		icon: string
	}>
}

export function IntegrationsCard({
	integrations,
	availableProviders,
}: IntegrationsCardProps) {
	const fetcher = useFetcher()

	// Create a map of integrations by provider name for easy lookup
	const integrationsMap = new Map(
		integrations.map((integration) => [integration.providerName, integration]),
	)

	// Show all available providers, merging with connected ones
	const allProviders = availableProviders.map((provider) => ({
		...provider,
		integration: integrationsMap.get(provider.name) || null,
	}))

	return (
		<div className="space-y-6">
			<header className="space-y-1">
				<h2 className="text-2xl font-semibold tracking-tight">
					<Trans>Integrations</Trans>
				</h2>
			</header>

			<div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{allProviders.map((provider) => (
					<IntegrationCard
						key={provider.name}
						provider={provider}
						integration={provider.integration}
						fetcher={fetcher}
					/>
				))}
			</div>

			{/* Request Integration Banner */}
			<div className="bg-muted relative flex w-full items-baseline gap-2 rounded-md p-2 px-6 text-sm">
				<div className="relative w-4 shrink-0">
					<Icon name="badge-question-mark" className="h-4 w-4" />
				</div>
				<div className="flex flex-1 flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
					<div className="text-pretty">
						<Trans>Need an integration but don't see it here?</Trans>
					</div>
					<div className="flex items-center justify-start gap-3">
						<a
							href="mailto:support@yourcompany.com?subject=Integration%20request"
							className="font-medium"
						>
							<Trans>Request integration</Trans>
						</a>
					</div>
				</div>
			</div>
		</div>
	)
}

interface IntegrationCardProps {
	provider: {
		name: string
		type: string
		displayName: string
		description: string
		icon: string
		integration?: Integration | null
	}
	integration: Integration | null
	fetcher: ReturnType<typeof useFetcher>
}

function IntegrationCard({
	provider,
	integration,
	fetcher,
}: IntegrationCardProps) {
	const [showSettings, ignored_setShowSettings] = useState(false)
	const isConnected = !!integration
	const isJira = provider.name === 'jira'

	const isProcessing =
		fetcher.state !== 'idle' &&
		(fetcher.formData?.get('integrationId') === integration?.id ||
			fetcher.formData?.get('providerName') === provider.name)

	return (
		<Card className="flex h-full flex-col">
			<CardHeader className="flex w-full items-center gap-3">
				<div className="relative grid h-10 w-10 shrink-0 place-items-center rounded-md after:absolute after:inset-0 after:h-full after:w-full after:rounded-[inherit] after:ring-1 after:ring-black/8 after:ring-inset dark:after:ring-white/8">
					<Icon name={provider.icon as any} className="h-6 w-6" />
				</div>
				<div className="flex min-w-0 flex-1 flex-col">
					<h2 className="truncate text-sm font-medium">
						{provider.displayName}
					</h2>
					<span className="text-muted-foreground text-xs">
						{provider.name === 'jira' && 'atlassian.com'}
						{!['jira'].includes(provider.name) && `${provider.name}.com`}
					</span>
				</div>
			</CardHeader>

			<CardContent className="flex-1">
				<p className="text-muted-foreground text-sm leading-5">
					{provider.description}
				</p>
				<div className="pt-2">
					{provider.name !== 'google-analytics' && (
						<Form method="POST">
							{isConnected ? (
								<>
									<input
										type="hidden"
										name="intent"
										value={disconnectIntegrationActionIntent}
									/>
									<input
										type="hidden"
										name="integrationId"
										value={integration.id}
									/>
									<StatusButton
										type="submit"
										variant="outline"
										size="sm"
										status={isProcessing ? 'pending' : 'idle'}
										className="w-full"
									>
										<Trans>Disconnect</Trans>
									</StatusButton>
								</>
							) : (
								<>
									<input
										type="hidden"
										name="intent"
										value={connectIntegrationActionIntent}
									/>
									<input
										type="hidden"
										name="providerName"
										value={provider.name}
									/>
									<StatusButton
										type="submit"
										variant="outline"
										size="sm"
										status={isProcessing ? 'pending' : 'idle'}
										className="w-full"
									>
										<Trans>Connect</Trans>
									</StatusButton>
								</>
							)}
						</Form>
					)}
				</div>
			</CardContent>

			<CardFooter className="py-2">
				<a
					href={getCrossAppUrl('docs', `/integrations/${provider.name}`)}
					target="_blank"
					rel="noreferrer"
					className="flex w-full items-center justify-between text-xs text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
				>
					<span className="flex items-center gap-1.5">
						<Icon name="book-open" className="h-4 w-4" />
						<Trans>Read documentation</Trans>
					</span>
					<Icon name="chevron-right" />
				</a>
			</CardFooter>

			{isJira && isConnected && showSettings && (
				<div className="border-t px-4 py-4">
					<JiraIntegrationSettings integration={integration} />
				</div>
			)}
		</Card>
	)
}
