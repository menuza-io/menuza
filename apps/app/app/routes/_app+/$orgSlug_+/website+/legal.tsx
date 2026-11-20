/**
 * Website, Legal pages (#89, #260): generate the privacy policy, terms of
 * service, cookie policy and accessibility statement from versioned templates
 * (one generator for all four), edit them like any page, and regenerate them
 * when the restaurant's details or features change. A page the operator edited
 * is never overwritten without showing the difference and asking first.
 * Reading needs `read:website:any`, changing `update:website:any`.
 */
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { LEGAL_KINDS, type DiffLine, type LegalKind } from '@repo/common/legal'
import { getSiteLocaleLabel } from '@repo/common/site-locales'
import { db, eq, Organization } from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Spinner } from '@repo/ui/spinner'
import { Textarea } from '@repo/ui/textarea'
import { useEffect, useState } from 'react'
import {
	type ActionFunctionArgs,
	Link,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import {
	LegalContactSchema,
	serializeLegalContact,
} from '#app/utils/legal/contact.server.ts'
import {
	buildLegalContextFor,
	generateLegalPages,
	listLegalPages,
	planRegenerate,
	regenerateLegalPage,
	suggestContactEmail,
} from '#app/utils/legal/pages.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

function isKind(value: unknown): value is LegalKind {
	return (
		typeof value === 'string' &&
		(LEGAL_KINDS as readonly string[]).includes(value)
	)
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const [pages, built, suggestedEmail] = await Promise.all([
		listLegalPages(organization.id!),
		buildLegalContextFor(organization.id!),
		suggestContactEmail(organization.id!),
	])
	return {
		organization,
		pages,
		contact: built.contact,
		locales: built.localesConfig.locales,
		region: built.region,
		suggestedEmail,
		features: built.context.features,
		// What the generated text is filled with beyond the contact details.
		detected: {
			phone: built.context.phone,
			address: built.context.address,
			trackingTags: built.context.trackingTags,
			paymentProviders: built.context.paymentProviders,
		},
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		customDomain: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	const form = await request.formData()
	const intent = form.get('intent')
	const orgId = organization.id!

	if (intent === 'save-contact') {
		const parsed = LegalContactSchema.safeParse(Object.fromEntries(form))
		if (!parsed.success) {
			return Response.json(
				{ status: 'error', error: 'invalid_contact' },
				{ status: 400 },
			)
		}
		await db
			.update(Organization)
			.set({ legalContact: serializeLegalContact(parsed.data) })
			.where(eq(Organization.id, orgId))
		return Response.json({ status: 'success' })
	}

	if (intent === 'generate') {
		const wanted = form.getAll('kind').filter(isKind)
		const result = await generateLegalPages({
			organizationId: orgId,
			userId,
			kinds: wanted.length > 0 ? wanted : LEGAL_KINDS,
			request,
		})
		if (!result.ok) {
			return Response.json(
				{ status: 'error', error: 'missing_details', missing: result.missing },
				{ status: 400 },
			)
		}
		return Response.json({
			status: 'success',
			created: result.created,
			skipped: result.skipped,
		})
	}

	if (intent === 'preview-regenerate' || intent === 'regenerate') {
		const kind = form.get('kind')
		if (!isKind(kind)) {
			return Response.json(
				{ status: 'error', error: 'invalid_request' },
				{ status: 400 },
			)
		}
		if (intent === 'preview-regenerate') {
			const plan = await planRegenerate({ organizationId: orgId, kind })
			if (!plan.ok) {
				return Response.json(
					{ status: 'error', error: plan.error, missing: plan.missing },
					{ status: plan.error === 'not_found' ? 404 : 400 },
				)
			}
			return Response.json({ status: 'plan', kind, ...plan })
		}
		const result = await regenerateLegalPage({
			organizationId: orgId,
			userId,
			kind,
			confirm: form.get('confirm') === 'true',
			request,
		})
		if (!result.ok) {
			return Response.json(
				{ status: 'error', error: result.error, missing: result.missing },
				{ status: result.error === 'edited_needs_confirm' ? 409 : 400 },
			)
		}
		// A draft only: nothing public changes until the operator publishes.
		return Response.json({ status: 'success', kind })
	}

	return Response.json(
		{ status: 'error', error: 'invalid_intent' },
		{ status: 400 },
	)
}

type Plan = {
	status: 'plan'
	kind: LegalKind
	pageId: string
	edited: boolean
	unchanged: boolean
	diffs: Record<string, DiffLine[]>
}

function KindLabel({ kind }: { kind: LegalKind }) {
	switch (kind) {
		case 'privacy':
			return <Trans>Privacy policy</Trans>
		case 'terms':
			return <Trans>Terms of service</Trans>
		case 'cookies':
			return <Trans>Cookie policy</Trans>
		case 'accessibility':
			return <Trans>Accessibility statement</Trans>
	}
}

function DiffView({ lines }: { lines: DiffLine[] }) {
	return (
		<pre
			className="bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap"
			dir="auto"
		>
			{lines.map((line, index) => (
				<span
					key={index}
					className={
						line.kind === 'added'
							? 'block bg-emerald-500/15'
							: line.kind === 'removed'
								? 'block bg-red-500/15 line-through'
								: 'block opacity-70'
					}
				>
					{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
					{line.text || ' '}
				</span>
			))}
		</pre>
	)
}

export default function WebsiteLegalRoute() {
	const { organization, pages, contact, locales, suggestedEmail, detected } =
		useLoaderData<typeof loader>()
	const { _ } = useLingui()
	const contactFetcher = useFetcher<{ status?: string; error?: string }>()
	const generateFetcher = useFetcher<{
		status?: string
		error?: string
		missing?: string[]
	}>()
	const planFetcher = useFetcher<Plan | { status: 'error'; error: string }>()
	const regenerateFetcher = useFetcher<{ status?: string; error?: string }>()
	const publishFetcher = useFetcher()
	const [plan, setPlan] = useState<Plan | null>(null)

	useEffect(() => {
		const data = planFetcher.data
		if (data && data.status === 'plan') {
			if (!data.edited) {
				// Nothing of the operator's to lose: regenerate straight away.
				void regenerateFetcher.submit(
					{ intent: 'regenerate', kind: data.kind },
					{ method: 'POST' },
				)
			} else {
				setPlan(data)
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [planFetcher.data])

	const missing = generateFetcher.data?.missing ?? []
	const localeNames = locales.map((locale) => getSiteLocaleLabel(locale)).join(', ')
	const [email, setEmail] = useState(contact.email || suggestedEmail)

	return (
		<div className="space-y-8">
			<PageHeader
				title={<Trans>Legal pages</Trans>}
				description={
					<Trans>
						Generate a privacy policy, terms of service, cookie policy and
						accessibility statement from a template filled with your details.
						They are normal pages you can edit.
					</Trans>
				}
				headingLevel="h2"
				size="section"
			/>
			<p
				role="note"
				className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
			>
				<Trans>
					These texts are a starting point, not legal advice. Have them reviewed
					by a lawyer before you rely on them.
				</Trans>
			</p>

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Your details</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							The pages are filled with these. An email is needed; the
							accessibility statement also needs a phone number so guests can
							ask for help.
						</Trans>
					</CardDescription>
				</CardHeader>
				<contactFetcher.Form method="post">
					<input type="hidden" name="intent" value="save-contact" />
					<CardContent className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-1.5">
							<Label htmlFor="legal-name">
								<Trans>Legal name of the business</Trans>
							</Label>
							<Input
								id="legal-name"
								name="legalName"
								defaultValue={contact.legalName}
								placeholder={organization.name ?? ''}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="legal-email">
								<Trans>Contact email</Trans>
							</Label>
							<Input
								id="legal-email"
								name="email"
								type="email"
								value={email}
								onChange={(event) => setEmail(event.currentTarget.value)}
								required
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="legal-phone">
								<Trans>Contact phone</Trans>
							</Label>
							<Input
								id="legal-phone"
								name="phone"
								type="tel"
								defaultValue={contact.phone}
								placeholder={detected.phone}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="legal-country">
								<Trans>Country (two letters, for example US or SA)</Trans>
							</Label>
							<Input
								id="legal-country"
								name="country"
								maxLength={2}
								defaultValue={contact.country}
							/>
						</div>
						<div className="space-y-1.5 sm:col-span-2">
							<Label htmlFor="legal-address">
								<Trans>Address</Trans>
							</Label>
							<Input
								id="legal-address"
								name="address"
								defaultValue={contact.address}
								placeholder={detected.address}
							/>
						</div>
						<div className="space-y-1.5 sm:col-span-2">
							<Label htmlFor="legal-refund">
								<Trans>Refund policy (optional)</Trans>
							</Label>
							<Textarea
								id="legal-refund"
								name="refundText"
								rows={3}
								defaultValue={contact.refundText}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									Left empty, the terms say to contact the restaurant.
								</Trans>
							</p>
						</div>
						<div className="space-y-1.5 sm:col-span-2">
							<Label htmlFor="legal-bookings">
								<Trans>Booking deposits and cancellations (optional)</Trans>
							</Label>
							<Textarea
								id="legal-bookings"
								name="reservationText"
								rows={3}
								defaultValue={contact.reservationText}
							/>
							<p className="text-muted-foreground text-xs">
								<Trans>
									The terms already say that deposits and cancellation rules are
									shown when a guest books. Add your own wording here if you
									want it in the terms too.
								</Trans>
							</p>
						</div>
					</CardContent>
					<CardFooter className="gap-3">
						<Button type="submit" disabled={contactFetcher.state !== 'idle'}>
							{contactFetcher.state !== 'idle' ? <Spinner /> : null}
							<Trans>Save details</Trans>
						</Button>
						{contactFetcher.data?.status === 'success' ? (
							<span role="status" className="text-muted-foreground text-xs">
								<Trans>Saved</Trans>
							</span>
						) : null}
					</CardFooter>
				</contactFetcher.Form>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>
						<Trans>Pages</Trans>
					</CardTitle>
					<CardDescription>
						<Trans>
							Generated in every site language: {localeNames}. Publish a page to link it from the footer, checkout, booking, job
							applications and sign-in.
						</Trans>
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{missing.length > 0 ? (
						<p role="alert" className="text-destructive text-sm">
							{missing.includes('phone') && missing.includes('email') ? (
								<Trans>Add a contact email and phone number first.</Trans>
							) : missing.includes('phone') ? (
								<Trans>
									Add a contact phone number first: the accessibility statement
									names it so guests can ask for help.
								</Trans>
							) : (
								<Trans>Add a contact email first.</Trans>
							)}
						</p>
					) : null}
					<ul className="divide-border divide-y">
						{pages.map((page) => (
							<li
								key={page.kind}
								className="flex flex-wrap items-center justify-between gap-3 py-3"
							>
								<div className="min-w-0">
									<p className="text-sm font-medium">
										<KindLabel kind={page.kind} />
									</p>
									<div className="mt-1 flex flex-wrap items-center gap-2">
										<Badge variant="outline">
											{page.status === 'missing' ? (
												<Trans>Not generated</Trans>
											) : page.status === 'published' ? (
												<Trans>Published</Trans>
											) : (
												<Trans>Draft</Trans>
											)}
										</Badge>
										{page.edited ? (
											<Badge variant="outline">
												<Trans>Edited</Trans>
											</Badge>
										) : null}
										{page.outdated ? (
											<Badge variant="outline">
												<Trans>Newer template available</Trans>
											</Badge>
										) : null}
									</div>
								</div>
								<div className="flex flex-wrap gap-2">
									{page.pageId ? (
										<>
											<Button
												variant="outline"
												size="sm"
												render={
													<Link
														to={`/${organization.slug}/website/pages/${page.pageId}`}
													/>
												}
											>
												<Trans>Edit</Trans>
											</Button>
											<Button
												variant="outline"
												size="sm"
												disabled={planFetcher.state !== 'idle'}
												onClick={() => {
													void planFetcher.submit(
														{ intent: 'preview-regenerate', kind: page.kind },
														{ method: 'POST' },
													)
												}}
											>
												<Trans>Regenerate</Trans>
											</Button>
											<Button
												size="sm"
												variant={
													page.status === 'published' ? 'ghost' : 'default'
												}
												disabled={publishFetcher.state !== 'idle'}
												onClick={() => {
													void publishFetcher.submit(
														{
															intent:
																page.status === 'published'
																	? 'unpublish-page'
																	: 'publish-page',
															pageId: page.pageId!,
															...(page.status === 'published'
																? { confirmRedirects: 'true' }
																: {}),
														},
														{
															method: 'POST',
															action: `/${organization.slug}/website/pages`,
														},
													)
												}}
											>
												{page.status === 'published' ? (
													<Trans>Unpublish</Trans>
												) : (
													<Trans>Publish</Trans>
												)}
											</Button>
										</>
									) : (
										<Button
											size="sm"
											disabled={generateFetcher.state !== 'idle'}
											onClick={() => {
												void generateFetcher.submit(
													{ intent: 'generate', kind: page.kind },
													{ method: 'POST' },
												)
											}}
										>
											{generateFetcher.state !== 'idle' ? <Spinner /> : null}
											<Trans>Generate</Trans>
										</Button>
									)}
								</div>
							</li>
						))}
					</ul>
				</CardContent>
				<CardFooter>
					<Button
						variant="outline"
						disabled={
							generateFetcher.state !== 'idle' ||
							pages.every((page) => page.pageId)
						}
						onClick={() => {
							void generateFetcher.submit(
								{ intent: 'generate' },
								{ method: 'POST' },
							)
						}}
					>
						<Trans>Generate all missing pages</Trans>
					</Button>
				</CardFooter>
			</Card>

			<Dialog
				open={Boolean(plan)}
				onOpenChange={(open) => {
					if (!open) setPlan(null)
				}}
			>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							<Trans>You edited this page</Trans>
						</DialogTitle>
						<DialogDescription>
							<Trans>
								Regenerating replaces your text with the new version. Here is
								what would change. Lines in red are removed, lines in green are
								added.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<div className="space-y-4">
						{plan
							? Object.entries(plan.diffs).map(([locale, lines]) => (
									<div key={locale} className="space-y-1.5">
										<p className="text-sm font-medium">
											{getSiteLocaleLabel(locale)}
										</p>
										<DiffView lines={lines} />
									</div>
								))
							: null}
					</div>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" type="button" />}>
							<Trans>Keep my text</Trans>
						</DialogClose>
						<Button
							type="button"
							disabled={regenerateFetcher.state !== 'idle'}
							onClick={() => {
								if (!plan) return
								void regenerateFetcher.submit(
									{ intent: 'regenerate', kind: plan.kind, confirm: 'true' },
									{ method: 'POST' },
								)
								setPlan(null)
							}}
						>
							<Trans>Replace with the new text</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<p className="text-muted-foreground text-xs">
				<Trans>
					The cookie banner is set under Analytics, next to your tracking tags.
				</Trans>{' '}
				<Link
					className="underline"
					to={`/${organization.slug}/website/analytics`}
				>
					<Trans>Open Analytics</Trans>
				</Link>
				<span className="sr-only">{_(msg`Cookie banner settings`)}</span>
			</p>
		</div>
	)
}
