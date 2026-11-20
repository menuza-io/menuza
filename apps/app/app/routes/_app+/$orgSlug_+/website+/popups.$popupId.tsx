import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	parseLocalizedString,
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	COUPON_NOT_VALID_ONLINE,
	popupCouponHref,
	SITE_POPUP_DEFAULT_DELAY_SECONDS,
	SITE_POPUP_DEFAULT_SCROLL_PERCENT,
	sitePopupInputSchema,
	type SitePopupCapture,
	type SitePopupFrequency,
	type SitePopupPageKey,
	type SitePopupTrigger,
} from '@repo/common/site-popup'
import { db, and, eq, SitePopup } from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState } from 'react'
import {
	Link,
	redirect,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import {
	LocaleContext,
	LocalizedInput,
	LocalizedTextarea,
	LocaleSwitcher,
} from '#app/components/website/locale-fields.tsx'
import { TranslateProvider } from '#app/components/website/translate-provider.tsx'
import { loadCouponDiscountOptions } from '#app/utils/discounts/marketing-offers.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import {
	draftPopupCopy,
	fixturePopupGenerator,
	livePopupGenerator,
	type PopupCopyFacts,
	type PopupCopyGenerator,
} from '#app/utils/popups/popup-copy.server.ts'
import {
	checkPopupCoupon,
	deletePopup,
	popupsEnabled,
	savePopup,
	setPopupStatus,
} from '#app/utils/popups/popups.server.ts'
import {
	AI_DRAFT_OPERATOR_RATE_LIMIT,
	AI_DRAFT_ORGANIZATION_RATE_LIMIT,
	checkRateLimit,
} from '#app/utils/rate-limit.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	fromDateTimeInputValue,
	toDateTimeInputValue,
} from '#app/utils/website/schedule-format.ts'
import { getSiteTimeZone } from '#app/utils/website/site-time-zone.server.ts'

/**
 * Website, Popups, one popup (#132): title, text, image, button and an optional
 * online coupon. "Write it for me" drafts the copy from the coupon with
 * `@repo/ai` (a fixture without a model key), rate limited per member and per
 * organization. Saving a coupon that cannot be used online fails with
 * `coupon_not_valid_online`.
 */

type PopupState = {
	name: string
	title: string
	body: string
	buttonLabel: string
	buttonUrl: string
	imageUrl: string
	discountId: string
	trigger: SitePopupTrigger
	triggerValue: number
	frequency: SitePopupFrequency
	pages: SitePopupPageKey[]
	startsAtLocal: string
	endsAtLocal: string
	captureContact: SitePopupCapture
	consentText: string
}

const bodySchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('save'),
		values: z.object({
			name: z.string(),
			title: z.string(),
			body: z.string(),
			buttonLabel: z.string(),
			buttonUrl: z.string(),
			imageUrl: z.string(),
			discountId: z.string(),
			trigger: z.string(),
			triggerValue: z.number(),
			frequency: z.string(),
			pages: z.array(z.string()),
			startsAtLocal: z.string(),
			endsAtLocal: z.string(),
			captureContact: z.string(),
			consentText: z.string(),
		}),
	}),
	z.object({ intent: z.literal('publish') }),
	z.object({ intent: z.literal('unpublish') }),
	z.object({ intent: z.literal('delete') }),
	z.object({
		intent: z.literal('generate-copy'),
		discountId: z.string(),
		language: z.enum(['en', 'ar']).default('en'),
	}),
])

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		dataRegion: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	if (!(await popupsEnabled(organization.id))) {
		throw new Response('Not found', { status: 404 })
	}
	const userId = await requireUserId(request)
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const timeZone = await getSiteTimeZone(organization.id)
	const localesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	let initial: PopupState = {
		name: '',
		title: '',
		body: '',
		buttonLabel: '',
		buttonUrl: '',
		imageUrl: '',
		discountId: '',
		trigger: 'delay',
		triggerValue: SITE_POPUP_DEFAULT_DELAY_SECONDS,
		frequency: 'day',
		pages: ['all'],
		startsAtLocal: '',
		endsAtLocal: '',
		captureContact: 'none',
		consentText: '',
	}
	let status: 'draft' | 'published' = 'draft'
	if (params.popupId !== 'new') {
		const [popup] = await db
			.select()
			.from(SitePopup)
			.where(
				and(
					eq(SitePopup.id, params.popupId ?? ''),
					eq(SitePopup.organizationId, organization.id),
				),
			)
			.limit(1)
		if (!popup) throw new Response('Not found', { status: 404 })
		status = popup.status
		let pages: SitePopupPageKey[] = ['all']
		try {
			const parsed: unknown = JSON.parse(popup.pages)
			if (Array.isArray(parsed)) pages = parsed as SitePopupPageKey[]
		} catch {
			/* keeps the default */
		}
		initial = {
			name: popup.name,
			title: popup.title,
			body: popup.body,
			buttonLabel: popup.buttonLabel,
			buttonUrl: popup.buttonUrl ?? '',
			imageUrl: popup.imageUrl ?? '',
			discountId: popup.discountId ?? '',
			trigger: popup.trigger,
			triggerValue: popup.triggerValue,
			frequency: popup.frequency,
			pages,
			startsAtLocal: popup.startsAt
				? toDateTimeInputValue(popup.startsAt, timeZone)
				: '',
			endsAtLocal: popup.endsAt
				? toDateTimeInputValue(popup.endsAt, timeZone)
				: '',
			captureContact: popup.captureContact,
			consentText: popup.consentText,
		}
	}
	// Coupons the member may attach (`read:discount:any`, discounts and coupons
	// on); null hides the picker.
	const coupons = await loadCouponDiscountOptions(userId, organization.id)
	return {
		popupId: params.popupId ?? 'new',
		status,
		initial,
		coupons,
		timeZone,
		aiAvailable:
			Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
			process.env.MOCKS === 'true',
		locales: localesConfig.locales,
		defaultLocale: localesConfig.defaultLocale,
	}
}

function fail(error: string, status: number, extra?: Record<string, unknown>) {
	return Response.json({ error, ...extra }, { status })
}

export async function action(
	{ request, params }: ActionFunctionArgs,
	deps: { generate?: PopupCopyGenerator } = {},
) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		name: true,
		slug: true,
		dataRegion: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	if (!(await popupsEnabled(organization.id))) {
		throw new Response('Not found', { status: 404 })
	}
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	const parsed = bodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) return fail('invalid_request', 400)
	const body = parsed.data
	const org = { id: organization.id, dataRegion: organization.dataRegion }
	const popupId = params.popupId === 'new' ? null : (params.popupId ?? null)

	if (body.intent === 'generate-copy') {
		const operator = await checkRateLimit(
			{ type: 'user', value: userId },
			AI_DRAFT_OPERATOR_RATE_LIMIT,
		)
		const perOrg = operator.allowed
			? await checkRateLimit(
					{ type: 'org', value: organization.id },
					AI_DRAFT_ORGANIZATION_RATE_LIMIT,
				)
			: null
		if (!operator.allowed || !perOrg?.allowed)
			return fail('ai_draft_limit', 429)
		let offer: string | null = null
		let code: string | null = null
		if (body.discountId) {
			const check = await checkPopupCoupon({
				organization: org,
				discountId: body.discountId,
			})
			if (!check.ok) return fail(COUPON_NOT_VALID_ONLINE, 422)
			code = check.code
			const { Discount } = await import('@repo/database')
			const [discount] = await db
				.select({
					valueType: Discount.valueType,
					percentBp: Discount.percentBp,
					amountMinor: Discount.amountMinor,
					currency: Discount.currency,
				})
				.from(Discount)
				.where(eq(Discount.id, body.discountId))
				.limit(1)
			if (discount?.valueType === 'percent' && discount.percentBp) {
				offer = `${discount.percentBp / 100}% off`
			} else if (discount?.amountMinor) {
				offer =
					`${(discount.amountMinor / 100).toFixed(2)} ${discount.currency ?? ''} off`.replace(
						/\s+/gu,
						' ',
					)
			} else {
				offer = 'a discount'
			}
		}
		const facts: PopupCopyFacts = {
			restaurantName: organization.name,
			offer,
			code,
			language: body.language,
		}
		const generate =
			deps.generate ??
			(process.env.GOOGLE_GENERATIVE_AI_API_KEY
				? await livePopupGenerator()
				: process.env.MOCKS === 'true'
					? fixturePopupGenerator(facts)
					: null)
		if (!generate) return fail('ai_not_configured', 503)
		return Response.json({ copy: await draftPopupCopy(facts, generate) })
	}

	if (body.intent === 'delete') {
		if (popupId) await deletePopup(organization.id, popupId)
		await purgeOrganizationSiteCache(organization.id)
		return redirect(`/${params.orgSlug}/website/popups`)
	}

	if (body.intent === 'publish' || body.intent === 'unpublish') {
		if (!popupId) return fail('not_found', 404)
		const result = await setPopupStatus({
			organization: org,
			popupId,
			status: body.intent === 'publish' ? 'published' : 'draft',
		})
		if (!result.ok) {
			return fail(result.error, result.error === 'not_found' ? 404 : 422)
		}
		await purgeOrganizationSiteCache(organization.id)
		return { ok: true }
	}

	// save
	const timeZone = await getSiteTimeZone(organization.id)
	const startsAt = body.values.startsAtLocal
		? fromDateTimeInputValue(body.values.startsAtLocal, timeZone)
		: null
	const endsAt = body.values.endsAtLocal
		? fromDateTimeInputValue(body.values.endsAtLocal, timeZone)
		: null
	if (
		(body.values.startsAtLocal && !startsAt) ||
		(body.values.endsAtLocal && !endsAt)
	) {
		return fail('invalid_time', 400)
	}
	const input = sitePopupInputSchema.safeParse({
		name: body.values.name,
		title: body.values.title,
		body: body.values.body,
		buttonLabel: body.values.buttonLabel,
		buttonUrl: body.values.buttonUrl || null,
		imageUrl: body.values.imageUrl || null,
		discountId: body.values.discountId || null,
		trigger: body.values.trigger,
		triggerValue: body.values.triggerValue,
		frequency: body.values.frequency,
		pages: body.values.pages,
		startsAt: startsAt?.toISOString() ?? null,
		endsAt: endsAt?.toISOString() ?? null,
		captureContact: body.values.captureContact,
		consentText: body.values.consentText,
	})
	if (!input.success) {
		return fail('invalid_popup', 400, {
			message: input.error.issues[0]?.message ?? 'Check the popup.',
		})
	}
	const result = await savePopup({
		userId,
		organization: org,
		popupId,
		values: input.data,
	})
	if (!result.ok) {
		return fail(
			result.error,
			result.error === 'not_found'
				? 404
				: result.error === 'limit_reached'
					? 409
					: 422,
		)
	}
	await purgeOrganizationSiteCache(organization.id)
	if (!popupId)
		return redirect(`/${params.orgSlug}/website/popups/${result.id}`)
	return { ok: true }
}

const PAGE_OPTIONS: Array<{
	key: SitePopupPageKey
	label: ReturnType<typeof msg>
}> = [
	{ key: 'all', label: msg`All pages` },
	{ key: 'home', label: msg`Home page` },
	{ key: 'menu', label: msg`Menu pages` },
	{ key: 'other', label: msg`Other pages` },
]

export default function WebsitePopupEditorRoute() {
	const data = useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const fetcher = useFetcher<{
		ok?: boolean
		error?: string
		message?: string
		copy?: { title: string; body: string; buttonLabel: string }
	}>()
	const [state, setState] = useState<PopupState>(data.initial)
	const [activeLocale, setActiveLocale] = useState<string>(data.defaultLocale)
	const patch = (changes: Partial<PopupState>) =>
		setState((current) => ({ ...current, ...changes }))
	const busy = fetcher.state !== 'idle'
	const timeZone = data.timeZone
	const coupon = data.coupons?.find((option) => option.id === state.discountId)
	const errorText =
		fetcher.data?.error === COUPON_NOT_VALID_ONLINE
			? _(
					msg`That coupon cannot be used online right now. It must be active, usable on your website, inside its dates and not used up.`,
				)
			: fetcher.data?.error === 'coupon_not_allowed'
				? _(msg`You need permission to view discounts to attach a coupon.`)
				: fetcher.data?.error === 'ai_draft_limit'
					? _(msg`You have used all drafts for now. Try again later.`)
					: fetcher.data?.error === 'ai_not_configured'
						? _(msg`Writing copy for you is not set up yet.`)
						: fetcher.data?.message || fetcher.data?.error || null

	const submit = (body: unknown) =>
		void fetcher.submit(body as Record<string, never>, {
			method: 'post',
			encType: 'application/json',
		})
	// A draft returned by "Write it for me" fills the fields once.
	const [appliedCopy, setAppliedCopy] = useState<unknown>(null)
	if (fetcher.data?.copy && appliedCopy !== fetcher.data.copy) {
		setAppliedCopy(fetcher.data.copy)
		const writeLocalized = (current: string, text: string) =>
			JSON.stringify({
				...parseLocalizedString(current, data.defaultLocale),
				[activeLocale]: text,
			})
		setState((current) => ({
			...current,
			title: writeLocalized(current.title, fetcher.data!.copy!.title),
			body: writeLocalized(current.body, fetcher.data!.copy!.body),
			buttonLabel: writeLocalized(
				current.buttonLabel,
				fetcher.data!.copy!.buttonLabel,
			),
		}))
	}

	const show = (value: string) =>
		pickLocalized(value, activeLocale, data.defaultLocale)

	return (
		<LocaleContext.Provider
			value={{
				activeLocale,
				defaultLocale: data.defaultLocale,
				locales: data.locales,
				setActiveLocale,
			}}
		>
			<TranslateProvider
				activeLocale={activeLocale}
				defaultLocale={data.defaultLocale}
			>
				<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
					<div className="space-y-6">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<Button
								variant="ghost"
								size="sm"
								render={<Link to=".." relative="path" />}
							>
								<Icon name="arrow-left" className="size-4 rtl:rotate-180" />
								<Trans>Popups</Trans>
							</Button>
							<div className="flex items-center gap-2">
								<Badge
									variant={data.status === 'published' ? 'default' : 'outline'}
								>
									{data.status === 'published' ? (
										<Trans>Published</Trans>
									) : (
										<Trans>Draft</Trans>
									)}
								</Badge>
								<LocaleSwitcher />
							</div>
						</div>

						<section className="space-y-4">
							<div className="space-y-2">
								<Label htmlFor="popup-name">
									<Trans>Name (only you see it)</Trans>
								</Label>
								<Input
									id="popup-name"
									value={state.name}
									maxLength={120}
									onChange={(event) => patch({ name: event.target.value })}
								/>
							</div>
							{data.coupons ? (
								<div className="space-y-2">
									<Label htmlFor="popup-coupon">
										<Trans>Coupon (optional)</Trans>
									</Label>
									<select
										id="popup-coupon"
										value={state.discountId}
										onChange={(event) =>
											patch({ discountId: event.target.value })
										}
										className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
									>
										<option value="">{_(msg`No coupon`)}</option>
										{data.coupons
											.filter((option) => option.codes.length > 0)
											.map((option) => (
												<option key={option.id} value={option.id}>
													{option.name}
												</option>
											))}
									</select>
									<p className="text-muted-foreground text-xs">
										<Trans>
											The button opens your menu with the code applied in the
											cart. If the coupon expires or is switched off, the popup
											stops showing.
										</Trans>
									</p>
								</div>
							) : null}
							<div className="flex flex-wrap items-center justify-between gap-2">
								<p className="text-sm font-medium">
									<Trans>Message</Trans>
								</p>
								{data.aiAvailable ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={busy}
										onClick={() =>
											submit({
												intent: 'generate-copy',
												discountId: state.discountId,
												language: activeLocale === 'ar' ? 'ar' : 'en',
											})
										}
									>
										<Icon name="sparkles" className="size-4" />
										<Trans>Write it for me</Trans>
									</Button>
								) : null}
							</div>
							<div className="space-y-2">
								<Label htmlFor="popup-title">
									<Trans>Title</Trans>
								</Label>
								<LocalizedInput
									id="popup-title"
									value={state.title}
									onChange={(title) => patch({ title })}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="popup-body">
									<Trans>Text</Trans>
								</Label>
								<LocalizedTextarea
									id="popup-body"
									rows={3}
									value={state.body}
									onChange={(body) => patch({ body })}
								/>
							</div>
							<div className="space-y-2">
								<Label htmlFor="popup-button">
									<Trans>Button label</Trans>
								</Label>
								<LocalizedInput
									id="popup-button"
									value={state.buttonLabel}
									onChange={(buttonLabel) => patch({ buttonLabel })}
								/>
							</div>
							{!state.discountId ? (
								<div className="space-y-2">
									<Label htmlFor="popup-url">
										<Trans>Button link</Trans>
									</Label>
									<Input
										id="popup-url"
										value={state.buttonUrl}
										placeholder="/menu"
										onChange={(event) =>
											patch({ buttonUrl: event.target.value })
										}
									/>
								</div>
							) : null}
							<div className="space-y-2">
								<Label htmlFor="popup-image">
									<Trans>Image address (optional)</Trans>
								</Label>
								<Input
									id="popup-image"
									value={state.imageUrl}
									placeholder="https://…"
									onChange={(event) => patch({ imageUrl: event.target.value })}
								/>
							</div>
						</section>

						<section className="space-y-4">
							<p className="text-sm font-medium">
								<Trans>When it shows</Trans>
							</p>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-2">
									<Label htmlFor="popup-trigger">
										<Trans>Show it</Trans>
									</Label>
									<select
										id="popup-trigger"
										value={state.trigger}
										onChange={(event) => {
											const trigger = event.target.value as SitePopupTrigger
											patch({
												trigger,
												triggerValue:
													trigger === 'scroll'
														? SITE_POPUP_DEFAULT_SCROLL_PERCENT
														: SITE_POPUP_DEFAULT_DELAY_SECONDS,
											})
										}}
										className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
									>
										<option value="delay">{_(msg`After a delay`)}</option>
										<option value="scroll">
											{_(msg`When they scroll down`)}
										</option>
										<option value="exit">
											{_(msg`When they are about to leave (desktop)`)}
										</option>
									</select>
								</div>
								{state.trigger !== 'exit' ? (
									<div className="space-y-2">
										<Label htmlFor="popup-trigger-value">
											{state.trigger === 'scroll' ? (
												<Trans>Percent of the page</Trans>
											) : (
												<Trans>Seconds</Trans>
											)}
										</Label>
										<Input
											id="popup-trigger-value"
											type="number"
											min={state.trigger === 'scroll' ? 1 : 0}
											max={state.trigger === 'scroll' ? 100 : 600}
											value={state.triggerValue}
											onChange={(event) =>
												patch({ triggerValue: Number(event.target.value) || 0 })
											}
										/>
									</div>
								) : null}
								<div className="space-y-2">
									<Label htmlFor="popup-frequency">
										<Trans>Show to a visitor</Trans>
									</Label>
									<select
										id="popup-frequency"
										value={state.frequency}
										onChange={(event) =>
											patch({
												frequency: event.target.value as SitePopupFrequency,
											})
										}
										className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
									>
										<option value="session">{_(msg`Once per session`)}</option>
										<option value="day">{_(msg`Once per day`)}</option>
										<option value="week">{_(msg`Once per week`)}</option>
										<option value="ever">{_(msg`Only once, ever`)}</option>
									</select>
								</div>
							</div>
							<fieldset className="space-y-2">
								<legend className="text-sm">
									<Trans>Pages</Trans>
								</legend>
								{PAGE_OPTIONS.map((option) => (
									<label
										key={option.key}
										className="flex items-center gap-2 text-sm"
									>
										<input
											type="checkbox"
											className="accent-primary size-4"
											checked={state.pages.includes(option.key)}
											onChange={(event) => {
												const next = new Set(state.pages)
												if (option.key === 'all') {
													patch({
														pages: event.target.checked ? ['all'] : ['home'],
													})
													return
												}
												next.delete('all')
												if (event.target.checked) next.add(option.key)
												else next.delete(option.key)
												patch({ pages: next.size ? [...next] : ['all'] })
											}}
										/>
										{_(option.label)}
									</label>
								))}
								<p className="text-muted-foreground text-xs">
									<Trans>
										Popups never show on checkout, payment, account or booking
										management pages. Only one popup shows per page view.
									</Trans>
								</p>
							</fieldset>
							<div className="grid gap-4 sm:grid-cols-2">
								<div className="space-y-2">
									<Label htmlFor="popup-start">
										<Trans>Show from</Trans>
									</Label>
									<Input
										id="popup-start"
										type="datetime-local"
										value={state.startsAtLocal}
										onChange={(event) =>
											patch({ startsAtLocal: event.target.value })
										}
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="popup-end">
										<Trans>Show until</Trans>
									</Label>
									<Input
										id="popup-end"
										type="datetime-local"
										value={state.endsAtLocal}
										onChange={(event) =>
											patch({ endsAtLocal: event.target.value })
										}
									/>
								</div>
							</div>
							<p className="text-muted-foreground text-xs">
								<Trans>Times are in {timeZone}.</Trans>
							</p>
						</section>

						<section className="space-y-3">
							<p className="text-sm font-medium">
								<Trans>Collect a contact (optional)</Trans>
							</p>
							<select
								aria-label={_(msg`Contact to collect`)}
								value={state.captureContact}
								onChange={(event) =>
									patch({
										captureContact: event.target.value as SitePopupCapture,
									})
								}
								className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
							>
								<option value="none">{_(msg`No signup`)}</option>
								<option value="email">{_(msg`Email address`)}</option>
								<option value="phone">{_(msg`Phone number`)}</option>
							</select>
							{state.captureContact !== 'none' ? (
								<div className="space-y-2">
									<Label htmlFor="popup-consent">
										<Trans>Wording of the consent checkbox</Trans>
									</Label>
									<LocalizedInput
										id="popup-consent"
										value={state.consentText}
										onChange={(consentText) => patch({ consentText })}
									/>
									<p className="text-muted-foreground text-xs">
										<Trans>
											The box is never ticked for the visitor. Contacts are
											saved in your customer data region only, with their
											consent.
										</Trans>
									</p>
								</div>
							) : null}
						</section>

						{errorText ? (
							<p role="alert" className="text-destructive text-sm">
								{errorText}
							</p>
						) : null}
						<div className="flex flex-wrap gap-2">
							<Button
								disabled={busy}
								onClick={() =>
									submit({
										intent: 'save',
										values: {
											name: state.name,
											title: state.title,
											body: state.body,
											buttonLabel: state.buttonLabel,
											buttonUrl: state.buttonUrl,
											imageUrl: state.imageUrl,
											discountId: state.discountId,
											trigger: state.trigger,
											triggerValue: state.triggerValue,
											frequency: state.frequency,
											pages: state.pages,
											startsAtLocal: state.startsAtLocal,
											endsAtLocal: state.endsAtLocal,
											captureContact: state.captureContact,
											consentText: state.consentText,
										},
									})
								}
							>
								<Trans>Save</Trans>
							</Button>
							{data.popupId !== 'new' ? (
								<>
									<Button
										variant="outline"
										disabled={busy}
										onClick={() =>
											submit({
												intent:
													data.status === 'published' ? 'unpublish' : 'publish',
											})
										}
									>
										{data.status === 'published' ? (
											<Trans>Unpublish</Trans>
										) : (
											<Trans>Publish</Trans>
										)}
									</Button>
									<Button
										variant="ghost"
										disabled={busy}
										onClick={() => {
											if (window.confirm(_(msg`Delete this popup?`))) {
												submit({ intent: 'delete' })
											}
										}}
									>
										<Trans>Delete</Trans>
									</Button>
								</>
							) : null}
						</div>
					</div>

					<aside
						aria-label={_(msg`Preview`)}
						className="space-y-3 lg:sticky lg:top-4 lg:self-start"
					>
						<p className="text-sm font-medium">
							<Trans>Preview</Trans>
						</p>
						<div className="bg-muted/40 rounded-xl border p-4">
							<div className="bg-background mx-auto max-w-xs space-y-3 rounded-xl border p-5 shadow-sm">
								{state.imageUrl ? (
									<img
										src={state.imageUrl}
										alt=""
										className="h-32 w-full rounded-md object-cover"
									/>
								) : null}
								<h3 className="text-lg font-semibold">
									{show(state.title) || _(msg`Your title`)}
								</h3>
								<p className="text-muted-foreground text-sm">
									{show(state.body)}
								</p>
								{coupon?.codes[0] ? (
									<p className="bg-muted rounded-md px-3 py-2 text-center font-mono text-sm tracking-wide">
										{coupon.codes[0]}
									</p>
								) : null}
								{state.captureContact !== 'none' ? (
									<div className="space-y-2">
										<Input
											aria-label={_(msg`Contact`)}
											disabled
											placeholder={
												state.captureContact === 'email'
													? _(msg`Email address`)
													: _(msg`Phone number`)
											}
										/>
										<label className="flex items-start gap-2 text-xs">
											<input type="checkbox" disabled className="mt-0.5" />
											{show(state.consentText)}
										</label>
									</div>
								) : null}
								<Button className="w-full" disabled>
									{show(state.buttonLabel) || _(msg`Button`)}
								</Button>
								{coupon?.codes[0] ? (
									<p className="text-muted-foreground text-center text-xs">
										{popupCouponHref(coupon.codes[0])}
									</p>
								) : null}
							</div>
						</div>
					</aside>
				</div>
			</TranslateProvider>
		</LocaleContext.Provider>
	)
}
