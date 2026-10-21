import { parseWithZod } from '@conform-to/zod'
import { requireUserId } from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { db, eq, User as UserTable } from '@repo/database'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	redirect,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'

import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ShopCard } from '#app/components/settings/cards/organization/shop-card.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import {
	getPaymentsMockStatus,
	requirePaymentsMock,
} from '#app/utils/payments-mock/gate.server.ts'
import {
	checkRateLimit,
	SHOP_CONNECT_ONBOARDING_RATE_LIMIT,
} from '#app/utils/rate-limit.server.ts'
import {
	createConnectDashboardLink,
	getCheckoutShopDashboardUrl,
	getHostedShopDashboardUrl,
	inviteCheckoutSubEntityOnboarding,
	isHostedShopConfigured,
	listConfiguredShopProcessors,
	listOrganizationShopOrders,
	startConnectOnboarding,
	syncCheckoutSubEntityStatus,
	syncConnectAccountStatus,
	syncHostedShopProduct,
	updateShopProduct,
} from '#app/utils/shop.server.ts'
import { normalizeShopProcessor } from '#app/utils/shop.types.ts'

const shopFields = {
	id: true,
	name: true,
	slug: true,
	dataRegion: true,
	hasProvisionedDb: true,
	customDomain: true,
	sitePublished: true,
	shopPaymentProvider: true,
	stripeConnectAccountId: true,
	stripeConnectChargesEnabled: true,
	stripeConnectPayoutsEnabled: true,
	checkoutSubEntityId: true,
	checkoutChargesEnabled: true,
	checkoutPayoutsEnabled: true,
	polarProductId: true,
	shopProductName: true,
	shopProductDescription: true,
	shopProductPriceCents: true,
	shopEnabled: true,
} as const

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug,
		shopFields,
	)

	const url = new URL(request.url)
	const connectParam = url.searchParams.get('connect')
	if (
		(connectParam === 'return' || connectParam === 'refresh') &&
		organization.stripeConnectAccountId
	) {
		try {
			await syncConnectAccountStatus(organization.id)
		} catch (error) {
			console.error(
				'Failed to sync payout account status:',
				error instanceof Error ? error.message : error,
			)
		}
	}

	if (organization.checkoutSubEntityId) {
		try {
			await syncCheckoutSubEntityStatus(organization.id)
		} catch (error) {
			console.error(
				'Failed to sync Checkout.com sub-entity status:',
				error instanceof Error ? error.message : error,
			)
		}
	}

	let orders: Awaited<ReturnType<typeof listOrganizationShopOrders>> = []
	let ordersUnavailable = false
	if (organization.dataRegion === 'us' && organization.hasProvisionedDb) {
		try {
			orders = await listOrganizationShopOrders(organization.id)
		} catch (error) {
			console.error(
				'Failed to load shop orders:',
				error instanceof Error ? error.message : error,
			)
			ordersUnavailable = true
		}
	}

	const refreshedOrg = await requireUserOrganization(
		request,
		params.orgSlug,
		shopFields,
	)

	return {
		organization: {
			...refreshedOrg,
			shopPaymentProvider: normalizeShopProcessor(
				refreshedOrg.shopPaymentProvider,
			),
		},
		orders,
		ordersUnavailable,
		configuredProcessors: listConfiguredShopProcessors(),
		// Dev and CI only: always `enabled: false` in a production build.
		paymentsMock: getPaymentsMockStatus(request),
	}
}

const ShopProductSchema = z.object({
	productName: z.string().trim().min(1, 'Product name is required'),
	productDescription: z.string().trim().optional(),
	priceDollars: z
		.string()
		.min(1, 'Price is required')
		.refine((value) => {
			const parsed = Number.parseFloat(value)
			return Number.isFinite(parsed) && parsed >= 0.5
		}, 'Minimum price is $0.50'),
	enabled: z
		.string()
		.optional()
		.transform((value) => value === 'on' || value === 'true'),
	paymentProcessor: z.enum(['connect', 'mor', 'checkout']).optional(),
})

export async function action({ request, params }: ActionFunctionArgs) {
	const organization = await requireUserOrganization(
		request,
		params.orgSlug,
		shopFields,
	)

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_SETTINGS_ANY,
	)

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'connect-payout') {
		if (organization.dataRegion !== 'us') {
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'US only',
				description: 'Shop payouts are available for US organizations only.',
				type: 'error',
			})
		}

		const rateLimitCheck = await checkRateLimit(
			{ type: 'token', value: organization.id },
			SHOP_CONNECT_ONBOARDING_RATE_LIMIT,
		)
		if (!rateLimitCheck.allowed) {
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Please wait',
				description:
					'Payout onboarding can only be started once every 30 seconds.',
				type: 'error',
			})
		}

		try {
			const url = await startConnectOnboarding(request, organization)
			return redirect(url)
		} catch (error) {
			const description =
				error instanceof Error ? error.message : 'Unable to start onboarding'
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Payout setup failed',
				description,
				type: 'error',
			})
		}
	}

	if (intent === 'open-payout-dashboard') {
		if (!organization.stripeConnectAccountId) {
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Not connected',
				description: 'Connect a payout account before opening the dashboard.',
				type: 'error',
			})
		}

		try {
			const url = await createConnectDashboardLink(
				organization.stripeConnectAccountId,
			)
			return redirect(url)
		} catch (error) {
			const description =
				error instanceof Error
					? error.message
					: 'Unable to open payout dashboard'
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Dashboard unavailable',
				description,
				type: 'error',
			})
		}
	}

	if (intent === 'invite-checkout-payout') {
		// Open to every region: KSA organizations pay through Checkout.com.
		const userId = await requireUserId(request)
		const [user] = await db
			.select({ email: UserTable.email })
			.from(UserTable)
			.where(eq(UserTable.id, userId))
			.limit(1)

		if (!user?.email) {
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Email required',
				description:
					'Add an email to your operator account before inviting a Checkout.com payout contact.',
				type: 'error',
			})
		}

		try {
			await inviteCheckoutSubEntityOnboarding(organization, user.email)
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Checkout.com invite sent',
				description:
					'Checkout.com emailed your payout contact a hosted onboarding invite.',
				type: 'success',
			})
		} catch (error) {
			const description =
				error instanceof Error
					? error.message
					: 'Unable to invite Checkout.com payout contact'
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Checkout.com setup failed',
				description,
				type: 'error',
			})
		}
	}

	if (intent === 'open-checkout-dashboard') {
		const url = getCheckoutShopDashboardUrl()
		if (!url) {
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Dashboard unavailable',
				description: 'Checkout.com is not configured on this platform.',
				type: 'error',
			})
		}
		return redirect(url)
	}

	if (intent === 'mock-onboard-stripe' || intent === 'mock-onboard-checkout') {
		// Dev and CI only. The branch is compiled out of the Cloudflare
		// production build; elsewhere the gate answers 404 unless the mock is on
		// and the request is local.
		if (
			typeof __PAYMENTS_MOCK_BUNDLED__ !== 'undefined' &&
			__PAYMENTS_MOCK_BUNDLED__
		) {
			const provider = intent === 'mock-onboard-stripe' ? 'stripe' : 'checkout'
			requirePaymentsMock(request, provider)
			const { mockOnboardOrganization } =
				await import('#app/utils/payments-mock/onboard.server.ts')
			const result = await mockOnboardOrganization({
				orgSlug: organization.slug,
				provider,
			})
			if (!result.ok) {
				return redirectWithToast(`/${organization.slug}/settings/shop`, {
					title: 'Mock setup failed',
					description:
						result.error === 'stripe_us_only'
							? 'Stripe payouts are only available for US organizations.'
							: 'The mock could not enable this provider.',
					type: 'error',
				})
			}
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Mock payments enabled',
				description: 'This organization can now take mock online payments.',
				type: 'success',
			})
		}
		throw new Response('Not Found', { status: 404 })
	}

	if (intent === 'enable-hosted-checkout') {
		if (organization.dataRegion !== 'us') {
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'US only',
				description: 'Shop checkout is available for US organizations only.',
				type: 'error',
			})
		}

		if (!isHostedShopConfigured()) {
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Hosted checkout unavailable',
				description:
					'Ask a platform admin to configure hosted checkout before enabling it.',
				type: 'error',
			})
		}

		try {
			await syncHostedShopProduct({
				...organization,
				shopProductName: organization.shopProductName,
				shopProductDescription: organization.shopProductDescription,
				shopProductPriceCents: organization.shopProductPriceCents,
			})
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Hosted checkout enabled',
				description:
					'Your shop will use hosted checkout. Save your product to keep the listing in sync.',
				type: 'success',
			})
		} catch (error) {
			const description =
				error instanceof Error
					? error.message
					: 'Unable to enable hosted checkout'
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Hosted checkout setup failed',
				description,
				type: 'error',
			})
		}
	}

	if (intent === 'open-hosted-dashboard') {
		const url = getHostedShopDashboardUrl()
		if (!url) {
			return redirectWithToast(`/${organization.slug}/settings/shop`, {
				title: 'Dashboard unavailable',
				description: 'Hosted checkout is not configured on this platform.',
				type: 'error',
			})
		}
		return redirect(url)
	}

	if (intent === 'update-shop-product') {
		const submission = parseWithZod(formData, { schema: ShopProductSchema })

		if (submission.status !== 'success') {
			return Response.json({ result: submission.reply() })
		}

		const priceCents = Math.round(
			Number.parseFloat(submission.value.priceDollars) * 100,
		)

		await updateShopProduct(organization.id, {
			productName: submission.value.productName,
			productDescription: submission.value.productDescription,
			priceCents,
			enabled: submission.value.enabled,
			paymentProvider: submission.value.paymentProcessor,
		})

		if (submission.value.paymentProcessor === 'mor') {
			try {
				await syncHostedShopProduct({
					...organization,
					shopProductName: submission.value.productName,
					shopProductDescription: submission.value.productDescription ?? null,
					shopProductPriceCents: priceCents,
				})
			} catch (error) {
				const description =
					error instanceof Error
						? error.message
						: 'Product saved, but hosted listing could not be synced'
				return redirectWithToast(`/${organization.slug}/settings/shop`, {
					title: 'Hosted sync failed',
					description,
					type: 'error',
				})
			}
		}

		return redirectWithToast(`/${organization.slug}/settings/shop`, {
			title: 'Shop updated',
			description: 'Your product listing has been saved.',
			type: 'success',
		})
	}

	return Response.json({ error: `Invalid intent: ${intent}` }, { status: 400 })
}

export default function ShopSettingsRoute() {
	const {
		organization,
		orders,
		ordersUnavailable,
		configuredProcessors,
		paymentsMock,
	} = useLoaderData<typeof loader>()

	return (
		<AnnotatedLayout>
			<AnnotatedSection>
				<ShopCard
					organization={organization}
					orders={orders}
					ordersUnavailable={ordersUnavailable}
					configuredProcessors={configuredProcessors}
					paymentsMock={paymentsMock}
				/>
			</AnnotatedSection>
		</AnnotatedLayout>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
