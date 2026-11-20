import { buildLink } from '@repo/common/links'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import {
	and,
	asc,
	db,
	Discount,
	DiscountCode,
	eq,
	isNull,
	SiteEvent,
} from '@repo/database'
import { getHints } from '@repo/ui/client-hints'
import { PageHeader } from '@repo/ui/page-header'
import {
	useActionData,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { SocialPostComposer } from '#app/components/social/post-composer.tsx'
import { runAfterResponse } from '#app/utils/after-response.server.ts'
import { loadOrganization, siteOrigin } from '#app/utils/gbp/context.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { localizedRecord } from '#app/utils/seo/cuisine-form.server.ts'
import { requireSocialAccess } from '#app/utils/social/access.server.ts'
import { listSocialAccounts } from '#app/utils/social/accounts.server.ts'
import {
	GOOGLE_TITLE_MAX,
	offerDetailsFromCoupon,
	type GooglePostDetails,
	type GoogleTopicType,
} from '#app/utils/social/google-post.ts'
import { isGoogleSocialEnabled } from '#app/utils/social/google-posts.server.ts'
import { handleSocialPostForm } from '#app/utils/social/post-form.server.ts'
import { schedulePrefillForDay, dayKey } from '#app/utils/social/time.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug, {
		write: true,
	})
	const { timeZone } = getHints(request)
	const url = new URL(request.url)
	// Opened from a calendar day: suggest 9:00 that day.
	const date = url.searchParams.get('date')
	const validDate =
		date &&
		/^\d{4}-\d{2}-\d{2}$/u.test(date) &&
		date >= dayKey(new Date(), timeZone)
			? date
			: null
	const now = new Date()
	const [allAccounts, googleEnabled] = await Promise.all([
		listSocialAccounts(access.organization.id),
		isGoogleSocialEnabled(access.organization.id),
	])
	const accounts = googleEnabled
		? allAccounts
		: allAccounts.filter((account) => account.platform !== 'google_business')

	let prefillBody = ''
	let prefillAccountIds: string[] = []
	let prefillTopicType: GoogleTopicType | undefined
	let prefillDetails: GooglePostDetails | undefined

	const discountId = url.searchParams.get('discountId')
	const eventId = url.searchParams.get('eventId')

	if (googleEnabled && discountId) {
		const canReadDiscount = await userHasOrganizationPermission(
			access.userId,
			access.organization.id,
			ORG_PERMISSIONS.READ_DISCOUNT_ANY,
		)
		if (canReadDiscount) {
			const [discount] = await db
				.select({
					id: Discount.id,
					name: Discount.name,
					description: Discount.description,
					startsAt: Discount.startsAt,
					endsAt: Discount.endsAt,
				})
				.from(Discount)
				.where(
					and(
						eq(Discount.id, discountId),
						eq(Discount.organizationId, access.organization.id),
					),
				)
				.limit(1)
			if (discount) {
				const [codeRow] = await db
					.select({ code: DiscountCode.code })
					.from(DiscountCode)
					.where(
						and(
							eq(DiscountCode.discountId, discount.id),
							eq(DiscountCode.organizationId, access.organization.id),
							isNull(DiscountCode.archivedAt),
						),
					)
					.orderBy(asc(DiscountCode.createdAt))
					.limit(1)
				const org = await loadOrganization(access.organization.id)
				const origin = org ? siteOrigin(org) : ''
				const code = codeRow?.code ?? ''
				const redeemUrl =
					(code
						? buildLink('coupon', { coupon: code }, { origin })
						: buildLink('menu_home', {}, { origin })) ?? ''
				prefillTopicType = 'OFFER'
				prefillDetails = offerDetailsFromCoupon({
					title: discount.name,
					code,
					startDate: discount.startsAt?.slice(0, 10) ?? dayKey(now, timeZone),
					endDate: discount.endsAt?.slice(0, 10) ?? null,
					redeemUrl,
				})
				prefillBody = discount.description?.trim() || discount.name
				prefillAccountIds = accounts
					.filter(
						(account) =>
							account.platform === 'google_business' &&
							account.status === 'active',
					)
					.map((account) => account.id)
			}
		}
	} else if (googleEnabled && eventId) {
		const [event] = await db
			.select({
				id: SiteEvent.id,
				slug: SiteEvent.slug,
				title: SiteEvent.title,
				description: SiteEvent.description,
				startLocal: SiteEvent.startLocal,
				endLocal: SiteEvent.endLocal,
				linkUrl: SiteEvent.linkUrl,
			})
			.from(SiteEvent)
			.where(
				and(
					eq(SiteEvent.id, eventId),
					eq(SiteEvent.organizationId, access.organization.id),
				),
			)
			.limit(1)
		if (event) {
			const org = await loadOrganization(access.organization.id)
			const defaultLocale = 'en'
			const titleMap = localizedRecord(event.title, defaultLocale)
			const descMap = localizedRecord(event.description, defaultLocale)
			const title = (
				titleMap[defaultLocale] ??
				Object.values(titleMap)[0] ??
				''
			).trim()
			const description = (
				descMap[defaultLocale] ??
				Object.values(descMap)[0] ??
				''
			).trim()
			const origin = org ? siteOrigin(org) : ''
			const buttonUrl =
				event.linkUrl || (origin ? `${origin}/events/${event.slug}` : '')
			prefillTopicType = 'EVENT'
			prefillDetails = {
				...(buttonUrl
					? { button: { type: 'LEARN_MORE' as const, url: buttonUrl } }
					: {}),
				event: {
					title: title.slice(0, GOOGLE_TITLE_MAX),
					startDate: event.startLocal.slice(0, 10),
					startTime: event.startLocal.slice(11, 16),
					endDate: event.endLocal.slice(0, 10),
					endTime: event.endLocal.slice(11, 16),
				},
			}
			prefillBody = description || title
			prefillAccountIds = accounts
				.filter(
					(account) =>
						account.platform === 'google_business' &&
						account.status === 'active',
				)
				.map((account) => account.id)
		}
	}

	return {
		orgSlug: access.organization.slug,
		timeZone,
		scheduledAt: validDate
			? schedulePrefillForDay(validDate, timeZone, now)
			: '',
		accounts,
		prefill: {
			body: prefillBody,
			accountIds: prefillAccountIds,
			googleTopicType: prefillTopicType,
			googleDetails: prefillDetails,
		},
	}
}

export async function action({ request, params, context }: ActionFunctionArgs) {
	const access = await requireSocialAccess(request, params.orgSlug, {
		write: true,
	})
	return handleSocialPostForm(request, access, undefined, {
		publishInBackground: (task) => runAfterResponse(context, task),
	})
}

export default function NewSocialPostRoute() {
	const { _ } = useLingui()
	const { orgSlug, timeZone, scheduledAt, accounts, prefill } =
		useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>()
	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`New post`)}
				description={_(
					msg`Write once, then publish now, schedule it, or keep it as a draft.`,
				)}
			/>
			<SocialPostComposer
				id="new-social-post"
				orgSlug={orgSlug}
				accounts={accounts}
				defaults={{
					body: prefill.body,
					accountIds: prefill.accountIds,
					media: [],
					scheduledAt,
					googleTopicType: prefill.googleTopicType,
					googleDetails: prefill.googleDetails,
				}}
				lastResult={actionData?.result}
				timeZone={timeZone}
				cancelTo={`/${orgSlug}/marketing/social`}
			/>
		</div>
	)
}
