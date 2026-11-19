import {
	ConfigFlag,
	db,
	Discount,
	DiscountCode,
	eq,
	GbpLocationSync,
	Integration,
	OrganizationLocation,
	OrganizationMediaAsset,
	SocialAccount,
	SocialPostTarget,
} from '@repo/database'
import {
	gbpMockCalls,
	mockGbpClient,
	resetGbpMock,
	setGbpMockState,
} from '@repo/integrations'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	GOOGLE_POST_MAX_TEXT,
	type GooglePostDetails,
	type buildLocalPostBody,
	googlePostProblems,
	offerDetailsFromCoupon,
} from './google-post.ts'
import {
	googlePostServerProblems,
	publishToGoogle,
	refreshGooglePostStates,
	removePostFromGoogle,
	syncGoogleSocialAccounts,
} from './google-posts.server.ts'
import {
	getSocialPost,
	publishSocialPost,
	saveSocialPost,
} from './posts.server.ts'

async function enableSocialGoogleFlag(organizationId: string) {
	await db.insert(ConfigFlag).values({
		key: 'social.google',
		level: 'organization',
		organizationId,
		value: true,
	})
}

async function setupGoogleOrg(options?: {
	activeIntegration?: boolean
	syncState?: string
	verificationState?: string
}) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id)
	await enableSocialGoogleFlag(organization.id)

	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: organization.id,
			name: 'Downtown Bistro',
			slug: `downtown-bistro-${organization.id.slice(0, 6)}`,
			isActive: true,
			isDefault: true,
		})
		.returning()

	const accountName = `accounts/acc-${organization.id}`
	const locationName = `locations/loc-${location!.id}`
	const [integration] = await db
		.insert(Integration)
		.values({
			organizationId: organization.id,
			organizationLocationId: location!.id,
			providerName: 'google_business_profile',
			providerType: 'listings',
			isActive: options?.activeIntegration ?? true,
			accessToken: 'MOCK_TOKEN',
			config: JSON.stringify({
				accountName,
				locationName,
				locationTitle: 'Downtown Bistro',
			}),
		})
		.returning()

	await db.insert(GbpLocationSync).values({
		organizationId: organization.id,
		organizationLocationId: location!.id,
		integrationId: integration!.id,
		googleAccountName: accountName,
		googleLocationName: locationName,
		fieldsSynced: '{}',
		state: options?.syncState ?? 'ok',
		verificationState: options?.verificationState ?? 'verified',
	})

	const [photo] = await db
		.insert(OrganizationMediaAsset)
		.values({
			organizationId: organization.id,
			objectKey: `media/${organization.id}/dish.jpg`,
			mimeType: 'image/jpeg',
			width: 1200,
			height: 900,
		})
		.returning()

	return {
		user,
		organization,
		owner: { userId: user.id, organization: { id: organization.id } },
		location: location!,
		integration: integration!,
		accountName,
		locationName,
		photo: photo!,
	}
}

beforeEach(() => {
	resetGbpMock()
})

describe('Google Business Profile social posts (#135)', () => {
	it('surfaces a linked Google location as a social account', async () => {
		const { organization, location, locationName } = await setupGoogleOrg()
		await syncGoogleSocialAccounts(organization.id)

		const accounts = await db
			.select()
			.from(SocialAccount)
			.where(eq(SocialAccount.organizationId, organization.id))
		expect(accounts).toHaveLength(1)
		expect(accounts[0]).toMatchObject({
			platform: 'google_business',
			externalId: locationName,
			organizationLocationId: location.id,
			name: 'Downtown Bistro',
			status: 'active',
		})
	})

	it('publishes Update, Offer and Event posts with the right localPosts body', async () => {
		const { organization, owner, locationName, photo } = await setupGoogleOrg()
		await syncGoogleSocialAccounts(organization.id)
		const [account] = await db
			.select()
			.from(SocialAccount)
			.where(eq(SocialAccount.organizationId, organization.id))

		const mock = mockGbpClient()
		setGbpMockState(locationName, { verified: true })

		// 1. Update (STANDARD)
		const updateRes = await publishToGoogle({
			post: {
				id: 'post-update',
				organizationId: organization.id,
				body: 'Fresh sourdough straight from the oven every morning.',
				media: [{ mediaId: photo.id }],
				googleTopicType: 'STANDARD',
				googleDetails: JSON.stringify({
					button: { type: 'ORDER', url: 'https://bistro.menuza.app/menu' },
				}),
			},
			account: account!,
			client: mock,
		})
		expect(updateRes.externalPostId).toContain('/localPosts/')

		// 2. Offer (OFFER) with an active online coupon
		const [discount] = await db
			.insert(Discount)
			.values({
				organizationId: organization.id,
				name: '20% off lunch',
				application: 'code',
				valueType: 'percent',
				percentBp: 2000,
				target: 'order',
				status: 'active',
				channels: JSON.stringify(['web']),
				startsAt: '2026-06-01T00:00',
				endsAt: '2099-06-30T23:59',
			})
			.returning()
		await db.insert(DiscountCode).values({
			organizationId: organization.id,
			discountId: discount!.id,
			code: 'LUNCH20',
			normalizedCode: 'LUNCH20',
		})

		const offerDetails = offerDetailsFromCoupon({
			title: '20% off lunch',
			code: 'LUNCH20',
			startDate: '2026-06-01',
			endDate: '2099-06-30',
			redeemUrl: 'https://bistro.menuza.app/menu?coupon=LUNCH20',
		})
		await publishToGoogle({
			post: {
				id: 'post-offer',
				organizationId: organization.id,
				body: 'Enjoy 20% off weekday lunch.',
				media: [],
				googleTopicType: 'OFFER',
				googleDetails: JSON.stringify(offerDetails),
			},
			account: account!,
			client: mock,
		})

		// 3. Event (EVENT)
		const eventDetails: GooglePostDetails = {
			button: { type: 'BOOK', url: 'https://bistro.menuza.app/reserve' },
			event: {
				title: 'Friday Jazz Night',
				startDate: '2026-07-03',
				startTime: '19:30',
				endDate: '2026-07-03',
				endTime: '22:00',
			},
		}
		const eventPost = await saveSocialPost(owner, {
			body: 'Live jazz quartet on the terrace.',
			mediaIds: [photo.id],
			accountIds: [account!.id],
			status: 'scheduled',
			scheduledAt: new Date(Date.now() - 60_000),
			googleTopicType: 'EVENT',
			googleDetails: JSON.stringify(eventDetails),
		})
		const eventResult = await publishToGoogle({
			post: {
				id: eventPost.id,
				organizationId: organization.id,
				body: 'Live jazz quartet on the terrace.',
				media: [{ mediaId: photo.id }],
				googleTopicType: 'EVENT',
				googleDetails: JSON.stringify(eventDetails),
			},
			account: account!,
			client: mock,
		})
		expect(eventResult.permalink).toBeTruthy()

		const createCalls = gbpMockCalls.filter(
			(call) => call.method === 'createLocalPost',
		)
		expect(createCalls).toHaveLength(3)

		const standardBody = createCalls[0]!.args[2] as ReturnType<
			typeof buildLocalPostBody
		>
		expect(standardBody).toMatchObject({
			topicType: 'STANDARD',
			summary: 'Fresh sourdough straight from the oven every morning.',
			callToAction: {
				actionType: 'ORDER',
				url: 'https://bistro.menuza.app/menu',
			},
			media: [{ mediaFormat: 'PHOTO' }],
		})

		const offerBody = createCalls[1]!.args[2] as ReturnType<
			typeof buildLocalPostBody
		>
		expect(offerBody).toMatchObject({
			topicType: 'OFFER',
			event: {
				title: '20% off lunch',
				schedule: {
					startDate: { year: 2026, month: 6, day: 1 },
					endDate: { year: 2099, month: 6, day: 30 },
				},
			},
			offer: {
				couponCode: 'LUNCH20',
				redeemOnlineUrl: 'https://bistro.menuza.app/menu?coupon=LUNCH20',
			},
		})
		expect(offerBody.callToAction).toEqual({
			actionType: 'ORDER',
			url: 'https://bistro.menuza.app/menu?coupon=LUNCH20',
		})

		const eventBody = createCalls[2]!.args[2] as ReturnType<
			typeof buildLocalPostBody
		>
		expect(eventBody).toMatchObject({
			topicType: 'EVENT',
			callToAction: {
				actionType: 'BOOK',
				url: 'https://bistro.menuza.app/reserve',
			},
			event: {
				title: 'Friday Jazz Night',
				schedule: {
					startDate: { year: 2026, month: 7, day: 3 },
					startTime: { hours: 19, minutes: 30 },
					endDate: { year: 2026, month: 7, day: 3 },
					endTime: { hours: 22, minutes: 0 },
				},
			},
		})
	})

	it('pre-fills coupon code, dates, and redeem link for an Offer post', async () => {
		const { organization } = await setupGoogleOrg()
		const [discount] = await db
			.insert(Discount)
			.values({
				organizationId: organization.id,
				name: 'Summer Feast',
				description: '15% off every summer salad',
				application: 'code',
				valueType: 'percent',
				percentBp: 1500,
				target: 'order',
				startsAt: '2026-07-01T00:00',
				endsAt: '2026-07-31T23:59',
			})
			.returning()
		await db.insert(DiscountCode).values({
			organizationId: organization.id,
			discountId: discount!.id,
			code: 'SUMMER15',
			normalizedCode: 'SUMMER15',
		})

		const details = offerDetailsFromCoupon({
			title: discount!.name,
			code: 'SUMMER15',
			startDate: discount!.startsAt!.slice(0, 10),
			endDate: discount!.endsAt!.slice(0, 10),
			redeemUrl: `https://${organization.slug}.menuza.app/menu?coupon=SUMMER15`,
		})
		expect(details.offer?.couponCode).toBe('SUMMER15')
		expect(details.offer?.redeemUrl).toBe(
			`https://${organization.slug}.menuza.app/menu?coupon=SUMMER15`,
		)
		expect(details.offer?.startDate).toBe('2026-07-01')
		expect(details.offer?.endDate).toBe('2026-07-31')
	})

	it('marks the account Reconnect needed and does not call Google when connection is broken', async () => {
		const { organization, owner, integration, location } =
			await setupGoogleOrg()
		await syncGoogleSocialAccounts(organization.id)
		const [account] = await db
			.select()
			.from(SocialAccount)
			.where(eq(SocialAccount.organizationId, organization.id))
		expect(account?.status).toBe('active')

		// Now simulate the Google connection breaking after the account was synced.
		await db
			.update(Integration)
			.set({ isActive: false })
			.where(eq(Integration.id, integration.id))
		await db
			.update(GbpLocationSync)
			.set({ state: 'token_expired' })
			.where(eq(GbpLocationSync.organizationLocationId, location.id))

		const mock = mockGbpClient()
		const spy = vi.spyOn(mock, 'createLocalPost')

		await expect(
			publishToGoogle({
				post: {
					id: 'post-broken',
					organizationId: organization.id,
					body: 'Should not call Google',
					media: [],
					googleTopicType: 'STANDARD',
					googleDetails: null,
				},
				account: account!,
				client: mock,
			}),
		).rejects.toThrow()

		expect(spy).not.toHaveBeenCalled()

		// End-to-end via publishSocialPost: marks target failed & account needs_reauth without calling Google.
		const post = await saveSocialPost(owner, {
			body: 'Trying to publish on broken account',
			mediaIds: [],
			accountIds: [account!.id],
			status: 'scheduled',
			scheduledAt: new Date(Date.now() - 60_000),
		})
		await publishSocialPost(post.id)
		const reloaded = await getSocialPost(organization.id, post.id)
		expect(reloaded?.status).toBe('failed')
		const [reloadedAccount] = await db
			.select()
			.from(SocialAccount)
			.where(eq(SocialAccount.id, account!.id))
		expect(reloadedAccount?.status).toBe('needs_reauth')
		expect(
			gbpMockCalls.filter((call) => call.method === 'createLocalPost'),
		).toHaveLength(0)
	})

	it('rejects over-long text and missing offer dates on both composer and server', async () => {
		const { organization } = await setupGoogleOrg()
		const tooLong = 'a'.repeat(GOOGLE_POST_MAX_TEXT + 1)

		const [tinyPhoto] = await db
			.insert(OrganizationMediaAsset)
			.values({
				organizationId: organization.id,
				objectKey: `media/${organization.id}/tiny.jpg`,
				mimeType: 'image/jpeg',
				width: 200,
				height: 150,
			})
			.returning()

		// Composer (client) validation
		const clientProblems = googlePostProblems({
			body: tooLong,
			topicType: 'OFFER',
			details: {
				offer: {
					title: 'Big Deal',
					startDate: '',
					endDate: '',
					couponCode: 'SAVE',
					redeemUrl: '',
					termsConditions: '',
				},
			},
			media: [{ mimeType: 'image/svg+xml', width: 200, height: 200 }],
		})
		expect(clientProblems).toContain('too_long')
		expect(clientProblems).toContain('dates_required')
		expect(clientProblems).toContain('media_type')

		// Server validation
		const serverProblems = await googlePostServerProblems({
			organizationId: organization.id,
			body: tooLong,
			topicType: 'OFFER',
			details: {
				offer: {
					title: 'Big Deal',
					startDate: '',
					endDate: '',
					couponCode: '',
					redeemUrl: '',
					termsConditions: '',
				},
			},
			media: [{ mediaId: tinyPhoto!.id }],
		})
		expect(serverProblems).toContain('too_long')
		expect(serverProblems).toContain('dates_required')
		expect(serverProblems).toContain('media_too_small')
	})

	it('refreshes pending Google post states and deletes from Google when requested', async () => {
		const { organization, owner, accountName, locationName } =
			await setupGoogleOrg()
		await syncGoogleSocialAccounts(organization.id)
		const [account] = await db
			.select()
			.from(SocialAccount)
			.where(eq(SocialAccount.organizationId, organization.id))

		const mock = mockGbpClient()
		setGbpMockState(locationName, { verified: true })
		const created = await mock.createLocalPost(accountName, locationName, {
			topicType: 'STANDARD',
			summary: 'Check out our seasonal menu',
		})

		const post = await saveSocialPost(owner, {
			body: 'Check out our seasonal menu',
			mediaIds: [],
			accountIds: [account!.id],
			status: 'draft',
			scheduledAt: null,
			googleTopicType: 'STANDARD',
		})
		await db
			.update(SocialPostTarget)
			.set({
				status: 'published',
				externalPostId: created.name,
				reviewState: 'pending',
			})
			.where(eq(SocialPostTarget.postId, post.id))

		const refreshed = await refreshGooglePostStates({ client: mock })
		expect(refreshed.live).toBe(1)

		const [targetAfterRefresh] = await db
			.select()
			.from(SocialPostTarget)
			.where(eq(SocialPostTarget.postId, post.id))
		expect(targetAfterRefresh?.reviewState).toBe('live')

		const removed = await removePostFromGoogle(organization.id, post.id, {
			client: mock,
		})
		expect(removed).toBe(1)
		expect(
			gbpMockCalls.filter((call) => call.method === 'deleteLocalPost'),
		).toHaveLength(1)
	})
})
