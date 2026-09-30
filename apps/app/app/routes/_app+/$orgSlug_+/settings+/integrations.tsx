import { invariantResponse } from '@epic-web/invariant'
import { redirectWithToast } from '@repo/common/toast'
import {
	asc,
	db,
	eq,
	OrganizationLocation,
	OrganizationMenu,
} from '@repo/database'
import {
	ensureDefaultOrganizationLocation,
	getAvailablePosProviders,
	getAvailableProviders,
	hasAppCredentials,
	importCatalog,
	integrationManager,
	isPosSandboxConnectAllowed,
	localizedText,
	listGoogleBusinessLocations,
	importGoogleBusinessLocation,
	parsePosConfig,
	pushMenu,
} from '@repo/integrations'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	Form,
	Link,
	useLoaderData,
} from 'react-router'

import {
	IntegrationsCard,
	connectIntegrationActionIntent,
	disconnectIntegrationActionIntent,
} from '#app/components/settings/cards/organization/integrations-card.tsx'
import {
	PosIntegrationsCard,
	connectPosActionIntent,
	disconnectPosActionIntent,
	importPosMenuActionIntent,
	syncPosMenuActionIntent,
} from '#app/components/settings/cards/organization/pos-integrations-card.tsx'

import { connectGoogleBusinessProfile } from '#app/utils/integrations/google-business-profile.server.ts'
import { connectPosPlatform } from '#app/utils/integrations/pos-connect.server.ts'
import { getLocationDisplayName } from '#app/utils/location/locations.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { requireOrganizationAdmin } from '#app/utils/organization/require-org-admin.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
	})

	const url = new URL(request.url)
	const availablePosProviders = getAvailablePosProviders()
	const availableNoteProviders = getAvailableProviders()
	const posProviderNames = new Set(availablePosProviders.map((p) => p.name))

	const [integrations, menus, locationRows] = await Promise.all([
		integrationManager.getOrganizationIntegrations(organization.id),
		db.query.OrganizationMenu.findMany({
			where: eq(OrganizationMenu.organizationId, organization.id),
			orderBy: [asc(OrganizationMenu.position)],
		}),
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				isDefault: OrganizationLocation.isDefault,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organization.id))
			.orderBy(asc(OrganizationLocation.name)),
	])

	let locations = locationRows
	if (!locations.length) {
		const defaultId = await ensureDefaultOrganizationLocation(organization.id)
		locations = [
			{
				id: defaultId,
				name: organization.name,
				isDefault: true,
			},
		]
	}

	const defaultLocationId =
		locations.find((location) => location.isDefault)?.id ??
		locations[0]?.id ??
		''
	const selectedLocationId =
		url.searchParams.get('locationId')?.trim() || defaultLocationId
	const scopedIntegrations = integrations.filter(
		(item) => item.organizationLocationId === selectedLocationId,
	)

	const googleIntegration = scopedIntegrations.find(
		(item) => item.providerName === 'google-business-profile',
	)
	let googleLocations: Array<{ name: string; title: string }> = []
	let googleError: string | null = null
	if (googleIntegration?.isActive) {
		try {
			googleLocations = (
				await listGoogleBusinessLocations(organization.id, selectedLocationId)
			).map(({ name, title }) => ({ name, title }))
		} catch (error) {
			googleError =
				error instanceof Error
					? error.message
					: 'Could not load Google locations'
		}
	}

	return {
		organization,
		googleIntegration: googleIntegration
			? {
					id: googleIntegration.id,
					isActive: googleIntegration.isActive,
				}
			: null,
		googleLocations,
		googleError,
		availablePosProviders,
		availableNoteProviders,
		selectedLocationId,
		noteIntegrations: integrations.filter(
			(integration) =>
				!posProviderNames.has(integration.providerName) &&
				integration.providerName !== 'google-business-profile',
		),
		integrations: scopedIntegrations
			.filter((integration) => posProviderNames.has(integration.providerName))
			.map((integration) => ({
				id: integration.id,
				providerName: integration.providerName,
				isActive: integration.isActive,
				lastSyncAt: integration.lastSyncAt
					? integration.lastSyncAt.toISOString()
					: null,
				environment: parsePosConfig(integration.config).environment,
			})),
		menus: menus.map((menu) => ({
			id: menu.id,
			name: localizedText(menu.displayName, 'Menu'),
		})),
		locations,
		doorDashLiveConfigured: hasAppCredentials('doordash'),
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
	})

	const formData = await request.formData()
	const intent = formData.get('intent')
	const locationFromForm = String(
		formData.get('organizationLocationId') ?? '',
	).trim()
	const redirectTo = locationFromForm
		? `/${organization.slug}/settings/integrations?locationId=${encodeURIComponent(locationFromForm)}`
		: `/${organization.slug}/settings/integrations`

	const adminRequired = new Set([
		connectIntegrationActionIntent,
		disconnectIntegrationActionIntent,
		'connect-google-business-profile',
		'disconnect-google-business-profile',
		'import-google-business-profile',
		connectPosActionIntent,
		disconnectPosActionIntent,
		importPosMenuActionIntent,
		syncPosMenuActionIntent,
	])
	if (typeof intent === 'string' && adminRequired.has(intent)) {
		await requireOrganizationAdmin(request, organization.id)
	}

	if (intent === connectIntegrationActionIntent) {
		const providerName = String(formData.get('providerName') ?? '')
		if (!providerName) {
			return redirectWithToast(redirectTo, {
				title: 'Integration failed',
				description: 'No provider was selected.',
				type: 'error',
			})
		}
		try {
			const url = new URL(request.url)
			const protocol = url.protocol === 'https:' ? 'https:' : 'http:'
			const redirectUri = `${protocol}//${url.host}/api/integrations/oauth/callback?provider=${encodeURIComponent(providerName)}`
			const { authUrl } = await integrationManager.initiateOAuth(
				organization.id,
				providerName,
				redirectUri,
				{ redirectUrl: redirectTo },
			)
			return Response.redirect(authUrl)
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Integration failed',
				description:
					error instanceof Error ? error.message : 'Failed to initiate OAuth',
				type: 'error',
			})
		}
	}

	if (intent === disconnectIntegrationActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		const integration = await integrationManager.getIntegration(integrationId)
		invariantResponse(integration, 'Integration not found', { status: 404 })
		invariantResponse(
			integration.organizationId === organization.id,
			'Unauthorized',
			{ status: 403 },
		)
		await integrationManager.disconnectIntegration(integrationId)
		return redirectWithToast(redirectTo, {
			title: 'Disconnected',
			description: 'The integration was disconnected.',
			type: 'success',
		})
	}

	if (intent === 'connect-google-business-profile') {
		if (!locationFromForm) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: 'Select a restaurant location first.',
				type: 'error',
			})
		}
		try {
			return await connectGoogleBusinessProfile(
				request,
				organization.id,
				redirectTo,
				locationFromForm,
			)
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description:
					error instanceof Error ? error.message : 'Could not connect Google',
				type: 'error',
			})
		}
	}
	if (intent === 'import-google-business-profile') {
		try {
			await importGoogleBusinessLocation(
				organization.id,
				String(formData.get('locationName') ?? ''),
				locationFromForm || undefined,
			)
			return redirectWithToast(redirectTo, {
				title: 'Restaurant imported',
				description:
					'Restaurant details and location were imported from Google.',
				type: 'success',
			})
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Import failed',
				description:
					error instanceof Error
						? error.message
						: 'Could not import Google location',
				type: 'error',
			})
		}
	}
	if (intent === 'disconnect-google-business-profile') {
		const integrationsForOrg =
			await integrationManager.getOrganizationIntegrations(organization.id)
		const google = integrationsForOrg.find(
			(item) =>
				item.providerName === 'google-business-profile' &&
				item.organizationLocationId === locationFromForm,
		)
		if (google) await integrationManager.disconnectIntegration(google.id)
		return redirectWithToast(redirectTo, {
			title: 'Disconnected',
			description: 'Google Business Profile was disconnected.',
			type: 'success',
		})
	}

	if (intent === connectPosActionIntent) {
		if (!locationFromForm) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: 'Select a restaurant location first.',
				type: 'error',
			})
		}
		const providerName = String(formData.get('providerName') ?? '')
		if (!providerName) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: 'No provider was selected.',
				type: 'error',
			})
		}
		try {
			const oauthRedirect = await connectPosPlatform(
				request,
				organization.id,
				providerName,
				{
					afterRedirectUrl: redirectTo,
					organizationLocationId: locationFromForm,
					doorDashStoreId: String(formData.get('doorDashStoreId') ?? ''),
				},
			)
			if (oauthRedirect) return oauthRedirect
			return redirectWithToast(redirectTo, {
				title: 'Connected',
				description: isPosSandboxConnectAllowed()
					? 'Platform connected in sandbox mode. Store details were imported when available.'
					: 'Platform connected. Store details were imported when available.',
				type: 'success',
			})
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Connection failed',
				description: error instanceof Error ? error.message : 'Unknown error',
				type: 'error',
			})
		}
	}

	if (intent === disconnectPosActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		const integration = await integrationManager.getIntegration(integrationId)
		invariantResponse(integration, 'Integration not found', { status: 404 })
		invariantResponse(
			integration.organizationId === organization.id,
			'Unauthorized',
			{ status: 403 },
		)
		await integrationManager.disconnectIntegration(integrationId)
		return redirectWithToast(redirectTo, {
			title: 'Disconnected',
			description: 'The platform was disconnected.',
			type: 'success',
		})
	}

	if (intent === importPosMenuActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		try {
			const result = await importCatalog(integrationId, organization.id)
			return redirectWithToast(redirectTo, {
				title: 'Menu imported',
				description: `${result.created} item${result.created === 1 ? '' : 's'} imported, ${result.skipped} already linked.`,
				type: 'success',
			})
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Import failed',
				description: error instanceof Error ? error.message : 'Unknown error',
				type: 'error',
			})
		}
	}

	if (intent === syncPosMenuActionIntent) {
		const integrationId = String(formData.get('integrationId') ?? '')
		const menuId = String(formData.get('menuId') ?? '')
		invariantResponse(integrationId, 'Integration ID is required', {
			status: 400,
		})
		invariantResponse(menuId, 'Menu ID is required', { status: 400 })
		try {
			const result = await pushMenu(integrationId, organization.id, menuId)
			return redirectWithToast(redirectTo, {
				title: 'Menu synced',
				description: `${result.pushed} item${result.pushed === 1 ? '' : 's'} pushed to the platform.`,
				type: 'success',
			})
		} catch (error) {
			return redirectWithToast(redirectTo, {
				title: 'Sync failed',
				description: error instanceof Error ? error.message : 'Unknown error',
				type: 'error',
			})
		}
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function IntegrationsSettings() {
	const {
		integrations,
		availablePosProviders,
		availableNoteProviders,
		noteIntegrations,
		menus,
		locations,
		doorDashLiveConfigured,
		selectedLocationId,
		googleIntegration,
		googleLocations,
		googleError,
	} = useLoaderData<typeof loader>()

	const locationPicker =
		locations.length > 1 ? (
			<Card>
				<CardHeader>
					<CardTitle>Restaurant location</CardTitle>
					<CardDescription>
						Integrations apply to the selected location. Each location can have
						its own POS, delivery, and Google Business Profile connections.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap gap-2">
					{locations.map((location) => (
						<Link
							key={location.id}
							to={`?locationId=${location.id}`}
							className={
								location.id === selectedLocationId
									? 'bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium'
									: 'bg-muted hover:bg-muted/80 rounded-md px-3 py-1.5 text-sm'
							}
						>
							{getLocationDisplayName(location.name)}
						</Link>
					))}
				</CardContent>
			</Card>
		) : null

	return (
		<div className="space-y-6">
			{locationPicker}
			<IntegrationsCard
				integrations={noteIntegrations}
				availableProviders={availableNoteProviders}
			/>
			<Card>
				<CardHeader>
					<CardTitle>Google Business Profile</CardTitle>
					<CardDescription>
						Bring your restaurant name, description, address, phone and opening
						hours into Menuza.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{googleIntegration?.isActive ? (
						<>
							<p>Connected to Google Business Profile</p>
							{googleError ? <p role="alert">{googleError}</p> : null}
							{googleLocations.length ? (
								<Form method="post" className="flex gap-2">
									<input
										type="hidden"
										name="intent"
										value="import-google-business-profile"
									/>
									<input
										type="hidden"
										name="organizationLocationId"
										value={selectedLocationId}
									/>
									<select
										name="locationName"
										aria-label="Google location"
										className="border-input bg-background rounded-md border px-3"
										required
									>
										{googleLocations.map((location) => (
											<option key={location.name} value={location.name}>
												{location.title}
											</option>
										))}
									</select>
									<Button type="submit">Import location</Button>
								</Form>
							) : null}
							<Form method="post">
								<input
									type="hidden"
									name="organizationLocationId"
									value={selectedLocationId}
								/>
								<Button
									type="submit"
									name="intent"
									value="disconnect-google-business-profile"
									variant="outline"
								>
									Disconnect
								</Button>
							</Form>
						</>
					) : (
						<Form method="post">
							<input
								type="hidden"
								name="organizationLocationId"
								value={selectedLocationId}
							/>
							<Button
								type="submit"
								name="intent"
								value="connect-google-business-profile"
							>
								Connect Google Business Profile
							</Button>
						</Form>
					)}
				</CardContent>
			</Card>
			<PosIntegrationsCard
				selectedLocationId={selectedLocationId}
				integrations={integrations}
				availableProviders={availablePosProviders}
				menus={menus}
				locations={locations}
				doorDashLiveConfigured={doorDashLiveConfigured}
			/>
		</div>
	)
}
