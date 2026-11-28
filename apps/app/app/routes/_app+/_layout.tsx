import { requireUserId } from '@repo/auth'
import {
	getOnboardingProgress,
	autoDetectCompletedSteps,
	type OnboardingProgressData,
} from '@repo/common/onboarding'
import { getSidebarState } from '@repo/common/sidebar-cookie'
import { db, and, eq, Organization, UserOrganization } from '@repo/database'
import { Outlet, useLoaderData } from 'react-router'
import { ENV } from 'varlock/env'
import { AIPanelProvider } from '#app/components/ai/ai-panel-context.tsx'
import { GlobalAIChat } from '#app/components/ai/global-ai-panel.tsx'
import { AppShellErrorScope } from '#app/components/error-boundary.tsx'
import {
	AgreementDialog,
	type PendingAgreementView,
} from '#app/components/legal/agreement-dialog.tsx'
import { MarketingLayout } from '#app/components/marketing-layout.tsx'
import { billingPastDueFor } from '#app/utils/billing/past-due.server.ts'
import { agreementPromptFor } from '#app/utils/legal/agreements.server.ts'
import { getUserDefaultOrganization } from '#app/utils/organization/organizations.server.ts'
import { getTrialStatus } from '#app/utils/payments.server.ts'

export async function loader({
	request,
	params,
}: {
	request: Request
	params: { orgSlug?: string }
}) {
	const isCollapsed = await getSidebarState(request)
	const userId = await requireUserId(request)

	// Owners are asked to accept new Menuza agreements (#194, #89). The
	// organization is the one in the address, else the person's default.
	let billingPastDue: { orgSlug: string } | null = null
	let agreementPrompt: {
		pending: PendingAgreementView[]
		blocking: boolean
		canAccept: boolean
		orgSlug: string | null
	} = { pending: [], blocking: false, canAccept: false, orgSlug: null }
	try {
		const slug = params.orgSlug
		const target = slug
			? (
					await db
						.select({ id: Organization.id, slug: Organization.slug })
						.from(Organization)
						.innerJoin(
							UserOrganization,
							and(
								eq(UserOrganization.organizationId, Organization.id),
								eq(UserOrganization.userId, userId),
								eq(UserOrganization.active, true),
							),
						)
						.where(
							and(eq(Organization.slug, slug), eq(Organization.active, true)),
						)
						.limit(1)
				)[0]
			: ((await getUserDefaultOrganization(userId))?.organization ?? null)
		if (target?.id) {
			// A past-due subscription shows a banner to the people who can fix it
			// (#237); nobody else sees anything.
			billingPastDue = await billingPastDueFor({
				userId,
				organization: { id: target.id, slug: target.slug },
			})
			agreementPrompt = {
				...(await agreementPromptFor({
					request,
					userId,
					organizationId: target.id,
				})),
				orgSlug: target.slug,
			}
		}
	} catch (error) {
		console.error('Could not read the pending agreements', {
			error: error instanceof Error ? error.message : String(error),
		})
	}

	let onboardingProgress = null
	let trialStatus = null
	try {
		// Get user's default organization
		const defaultOrg = await getUserDefaultOrganization(userId)

		if (defaultOrg?.organization?.id) {
			// Auto-detect completed steps first
			try {
				await autoDetectCompletedSteps(userId, defaultOrg.organization.id)
			} catch {
				// Continue without auto-detection if there's an error
			}

			// Get current progress
			try {
				onboardingProgress = await getOnboardingProgress(
					userId,
					defaultOrg.organization.id,
				)
			} catch {
				// Continue without onboarding progress if there's an error
				onboardingProgress = null
			}

			// Get trial status using environment variables
			try {
				trialStatus = await getTrialStatus(userId, defaultOrg.organization.slug)
			} catch {
				// Continue without trial status if there's an error
			}
		}
	} catch {
		// Don't throw, just continue without onboarding progress
	}

	return {
		isCollapsed,
		onboardingProgress,
		trialStatus,
		extensionId: ENV.EXTENSION_ID,
		agreementPrompt,
		billingPastDue,
	}
}

export default function MarketingLayoutRoute() {
	const {
		isCollapsed,
		onboardingProgress,
		trialStatus,
		extensionId,
		agreementPrompt,
		billingPastDue,
	} = useLoaderData<{
		isCollapsed: boolean
		onboardingProgress: OnboardingProgressData | null
		trialStatus: { isActive: boolean; daysRemaining: number } | null
		extensionId: string | null
		agreementPrompt: {
			pending: PendingAgreementView[]
			blocking: boolean
			canAccept: boolean
			orgSlug: string | null
		}
		billingPastDue: { orgSlug: string } | null
	}>()

	return (
		<AIPanelProvider>
			<GlobalAIChat />
			<MarketingLayout
				isCollapsed={isCollapsed}
				onboardingProgress={onboardingProgress}
				trialStatus={trialStatus}
				extensionId={extensionId}
				billingPastDue={billingPastDue}
			>
				<AppShellErrorScope>
					<Outlet />
				</AppShellErrorScope>
				{agreementPrompt.orgSlug ? (
					<AgreementDialog
						orgSlug={agreementPrompt.orgSlug}
						pending={agreementPrompt.pending}
						blocking={agreementPrompt.blocking}
						canAccept={agreementPrompt.canAccept}
					/>
				) : null}
			</MarketingLayout>
		</AIPanelProvider>
	)
}
