import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { userHasOrganizationPermission } from '@repo/auth'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
	Link,
	useNavigation,
} from 'react-router'
import { ArchiveDiscountDialog } from '#app/components/discounts/archive-discount-button.tsx'
import {
	DiscountForm,
	UNSAVED_CHANGES_NOTE_ID,
} from '#app/components/discounts/discount-form.tsx'
import {
	type ImpactChoice,
	ResumeWithAutomationsDialog,
	UsedInPanel,
	useMessageImpact,
} from '#app/components/discounts/message-impact.tsx'
import { requireDiscountsAccess } from '#app/utils/discounts/access.server.ts'
import {
	getDiscount,
	getDiscountCreatedBy,
} from '#app/utils/discounts/discounts.server.ts'
import {
	loadDiscountAudienceChoices,
	loadDiscountEditorData,
} from '#app/utils/discounts/editor-data.server.ts'
import { stateFromDefinition } from '#app/utils/discounts/editor-model.ts'
import { listDiscountHistory } from '#app/utils/discounts/history.server.ts'
import {
	discountEditableInScope,
	discountVisibleInScope,
} from '#app/utils/discounts/location-scope.server.ts'
import { describePairedAutomations } from '#app/utils/discounts/message-impact.server.ts'
import {
	type DiscountEditorActionData,
	saveDiscountEditor,
} from '#app/utils/discounts/save.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { couponPrintHref } from '#app/utils/print/restaurant/coupon.server.ts'
import { isGoogleSocialEnabled } from '#app/utils/social/google-posts.server.ts'
import { getOperatorTenantClient } from '#app/utils/tenant-api.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireDiscountsAccess(request, params.orgSlug)
	const discountId = params.discountId
	if (!discountId) throw new Response('Not Found', { status: 404 })
	const loaded = await getDiscount(access.organization.id, discountId)
	if (!loaded) throw new Response('Not Found', { status: 404 })
	// A row that no longer parses has no location list to check, so only a
	// member with every location sees it (to archive it); `undefined` fails
	// closed in both checks.
	const locationIds = loaded.stored
		? loaded.stored.definition.locationIds
		: undefined
	if (!discountVisibleInScope(locationIds, access.locationIds)) {
		throw new Response('Not Found', { status: 404 })
	}
	const editableHere = discountEditableInScope(locationIds, access.locationIds)
	const [editor, audiences] = await Promise.all([
		loadDiscountEditorData(access.organization.id),
		loadDiscountAudienceChoices({
			request,
			orgSlug: access.organization.slug,
			organizationId: access.organization.id,
			userId: access.userId,
		}),
	])
	const status = asStatus(loaded.row.status)
	const storedCurrency = loaded.row.currency ?? access.currency
	const stored = loaded.stored
	const [
		canChangeAutomations,
		canChangeBroadcasts,
		canOpenAutomations,
		canOpenBroadcasts,
	] = await Promise.all(
		[
			ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
			ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
			ORG_PERMISSIONS.READ_AUTOMATION_ANY,
			ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
		].map((permission) =>
			userHasOrganizationPermission(
				access.userId,
				access.organization.id,
				permission,
			),
		),
	)
	// Automations paused together with this discount, offered back on resume.
	const pairedAutomations =
		status === 'paused' && access.canWrite
			? await getOperatorTenantClient(request, access.organization.slug)
					.then(({ fetchTenant }) =>
						describePairedAutomations({
							fetchTenant,
							organizationId: access.organization.id,
							discountId,
						}),
					)
					.catch(() => [])
			: []
	const [createdBy, history, printHref, googleSocialEnabled] =
		await Promise.all([
			getDiscountCreatedBy(loaded.row.createdById),
			listDiscountHistory(access.organization.id, discountId),
			stored
				? couponPrintHref({
						userId: access.userId,
						organization: access.organization,
						discount: {
							id: discountId,
							status: loaded.row.status,
							definition: stored.definition,
							codeCount: loaded.codes.length,
						},
					})
				: null,
			isGoogleSocialEnabled(access.organization.id),
		])
	const googleOfferHref =
		googleSocialEnabled &&
		canChangeBroadcasts &&
		loaded.row.status === 'active' &&
		loaded.codes.length > 0 &&
		(stored?.definition.channels.includes('web') ?? true)
			? `/${access.organization.slug}/marketing/social/new?discountId=${encodeURIComponent(discountId)}`
			: null
	return {
		orgSlug: access.organization.slug,
		// The form takes the currency of the chosen locations; this one serves an
		// organization without locations (see the action).
		currency: storedCurrency,
		features: access.features,
		canWrite: access.canWrite && editableHere,
		// May change discounts, but this one is shared with other locations.
		sharedWithOtherLocations: access.canWrite && !editableHere,
		// A coupon card for this discount, when the Print shop can make one.
		printHref,
		// Pre-fill a Google Business Profile Offer post from this coupon (#135).
		googleOfferHref,
		editor,
		audiences,
		discountId,
		permissions: {
			canChangeAutomations: Boolean(canChangeAutomations),
			canChangeBroadcasts: Boolean(canChangeBroadcasts),
			canOpenAutomations: Boolean(canOpenAutomations),
			canOpenBroadcasts: Boolean(canOpenBroadcasts),
		},
		pairedAutomations,
		cascade: parseCascade(new URL(request.url).searchParams.get('cascade')),
		name: loaded.row.name,
		version: loaded.row.version,
		status,
		createdBy,
		history,
		createdAt: loaded.row.createdAt.toISOString(),
		initial: stored
			? stateFromDefinition(
					stored.definition,
					loaded.codes,
					storedCurrency,
					editor.siteLocales,
				)
			: null,
	}
}

/** `<paused>.<cancelled>.<resumed>.<not done>`, counts the action sent along. */
function parseCascade(value: string | null) {
	const parts = (value ?? '').split('.').map((part) => Number(part))
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
		return null
	}
	const [paused = 0, cancelled = 0, resumed = 0, notDone = 0] = parts
	return { paused, cancelled, resumed, notDone }
}

export async function action({ request, params }: ActionFunctionArgs) {
	const access = await requireDiscountsAccess(request, params.orgSlug, {
		write: true,
	})
	return saveDiscountEditor({ request, params, access })
}

export default function EditDiscountRoute() {
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<DiscountEditorActionData>()
	const navigation = useNavigation()
	const { t } = useLingui()
	const [archiveOpen, setArchiveOpen] = useState(false)
	const [resumeOpen, setResumeOpen] = useState(false)
	const impact = useMessageImpact({
		orgSlug: data.orgSlug,
		permissions: data.permissions,
	})
	/** Posts the status form with the status and what the operator chose about messages. */
	const submitStatus = (status: string, extra: Record<string, string> = {}) => {
		const form = document.getElementById(
			'discount-status',
		) as HTMLFormElement | null
		if (!form) return
		for (const [name, value] of Object.entries({ status, ...extra })) {
			const input = document.createElement('input')
			input.type = 'hidden'
			input.name = name
			input.value = value
			form.appendChild(input)
		}
		form.requestSubmit()
	}
	const choiceFields = (choice: ImpactChoice | null) => ({
		...(choice?.pauseAutomations ? { pauseAutomations: '1' } : {}),
		...(choice?.cancelBroadcasts ? { cancelBroadcasts: '1' } : {}),
	})
	const keepEdits = actionData?.keepEdits === true
	// The form opens with the saved discount and is rebuilt when a new version
	// arrives. A stale save is the exception: it brings the other person's
	// version, but the operator's edits stay on screen so nothing is retyped.
	const [mount, setMount] = useState({
		version: data.version,
		generation: 0,
	})
	if (mount.version !== data.version) {
		setMount({
			version: data.version,
			generation: keepEdits ? mount.generation : mount.generation + 1,
		})
	}

	if (!data.initial) {
		return (
			<div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-10">
				<h1 className="text-lg font-medium">{data.name}</h1>
				<p role="alert">
					<Trans>
						This discount was saved in a form the editor can't open. Archive it,
						then create it again.
					</Trans>
				</p>
				{data.canWrite && data.status !== 'archived' ? (
					<form method="post">
						<input type="hidden" name="intent" value="set-status" />
						<input
							type="hidden"
							name="expectedVersion"
							value={String(data.version)}
						/>
						<Button type="submit" name="status" value="archived">
							<Trans>Archive</Trans>
						</Button>
					</form>
				) : null}
			</div>
		)
	}

	const initial = data.initial
	return (
		<>
			<form id="discount-status" method="post" className="hidden">
				<input type="hidden" name="intent" value="set-status" />
				<input
					type="hidden"
					name="expectedVersion"
					value={String(data.version)}
				/>
			</form>
			<form id="discount-duplicate" method="post" className="hidden">
				<input type="hidden" name="intent" value="duplicate" />
				<input type="hidden" name="discountId" value={data.discountId} />
				<input type="hidden" name="copyWord" value={t`copy`} />
			</form>
			{actionData?.noCodes ? (
				<p role="alert" className="text-destructive px-4 pt-4 text-sm md:px-6">
					<Trans>Add a code before turning this discount on.</Trans>
				</p>
			) : null}
			{actionData?.scope ? (
				<p role="alert" className="text-destructive px-4 pt-4 text-sm md:px-6">
					<Trans>
						This discount also runs at locations outside yours, so you can't
						change it.
					</Trans>
				</p>
			) : null}
			{data.cascade ? <CascadeNotice cascade={data.cascade} /> : null}
			<UsedInPanel
				orgSlug={data.orgSlug}
				discountId={data.discountId}
				permissions={data.permissions}
			/>
			<DiscountForm
				key={`${data.discountId}:${mount.generation}`}
				confirmBeforeSave={({ state, initial, submit }) => {
					// An earlier end, a code that goes, or a new amount would break
					// what scheduled and running messages promise: ask first.
					const shortened = Boolean(
						state.endsAt && (!initial.endsAt || state.endsAt < initial.endsAt),
					)
					const keep = new Set(
						state.codes.map((row) => row.code.trim().toUpperCase()),
					)
					const codeGone = initial.codes.some((row) => {
						const code = row.code.trim().toUpperCase()
						return code !== '' && !keep.has(code)
					})
					const amountChanged =
						state.valueType !== initial.valueType ||
						state.percent !== initial.percent ||
						state.amount !== initial.amount ||
						JSON.stringify(state.tiers) !== JSON.stringify(initial.tiers)
					if (!shortened && !codeGone && !amountChanged) return false
					impact.guard({
						discountId: data.discountId,
						discountName: data.name,
						kind: shortened ? 'shorten_end' : 'edit',
						proceed: (choice) => submit(choiceFields(choice)),
					})
					return true
				}}
				mode="edit"
				orgSlug={data.orgSlug}
				currency={data.currency}
				features={data.features}
				catalog={data.editor.catalog}
				locations={data.editor.locations}
				choices={data.editor.choices}
				siteLocales={data.editor.siteLocales}
				packagingFeeEnabled={data.editor.packagingFeeEnabled}
				audiences={data.audiences}
				initial={initial}
				version={data.version}
				status={data.status}
				canWrite={data.canWrite}
				errors={actionData?.errors ?? {}}
				stale={actionData?.stale === true}
				keepEdits={keepEdits}
				formError={
					actionData?.formError !== undefined || actionData?.archived === true
				}
				limit={actionData?.limit ?? null}
				isSubmitting={navigation.state === 'submitting'}
				createdBy={data.createdBy}
				history={data.history}
				createdAt={data.createdAt}
				sharedWithOtherLocations={data.sharedWithOtherLocations}
				statusActions={({ dirty }) =>
					data.canWrite || data.printHref || data.googleOfferHref ? (
						<>
							{data.canWrite ? (
								<Button
									type="button"
									variant="outline"
									disabled={dirty || impact.checking}
									aria-describedby={dirty ? UNSAVED_CHANGES_NOTE_ID : undefined}
									onClick={() => {
										if (data.status === 'active') {
											// Messages that promise it would break: ask first.
											impact.guard({
												discountId: data.discountId,
												discountName: data.name,
												kind: 'pause',
												proceed: (choice) =>
													submitStatus('paused', choiceFields(choice)),
											})
										} else if (
											data.status === 'paused' &&
											data.pairedAutomations.length > 0
										) {
											setResumeOpen(true)
										} else {
											submitStatus(
												data.status === 'archived' ? 'paused' : 'active',
											)
										}
									}}
								>
									{data.status === 'active'
										? t`Pause`
										: data.status === 'archived'
											? t`Restore`
											: t`Resume`}
								</Button>
							) : null}
							{/* The rarer actions on the saved discount share one menu. */}
							<DropdownMenu>
								<DropdownMenuTrigger
									disabled={dirty}
									render={
										<Button
											type="button"
											variant="outline"
											size="icon"
											aria-label={t`More actions`}
											aria-describedby={
												dirty ? UNSAVED_CHANGES_NOTE_ID : undefined
											}
										>
											<Icon name="more-horizontal" className="size-4" />
										</Button>
									}
								/>
								<DropdownMenuContent align="end" className="min-w-44">
									{data.googleOfferHref ? (
										<DropdownMenuItem
											render={<Link to={data.googleOfferHref} />}
										>
											<Icon name="google" />
											<Trans>Post this offer to Google</Trans>
										</DropdownMenuItem>
									) : null}
									{data.printHref ? (
										<DropdownMenuItem render={<Link to={data.printHref} />}>
											<Icon name="printer" />
											<Trans>Print coupons</Trans>
										</DropdownMenuItem>
									) : null}
									{data.canWrite ? (
										<DropdownMenuItem
											onClick={() => {
												const form = document.getElementById(
													'discount-duplicate',
												) as HTMLFormElement | null
												form?.requestSubmit()
											}}
										>
											<Icon name="copy" />
											<Trans>Duplicate</Trans>
										</DropdownMenuItem>
									) : null}
									{data.canWrite && data.status !== 'archived' ? (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onClick={() => setArchiveOpen(true)}
											>
												<Trans>Archive</Trans>
											</DropdownMenuItem>
										</>
									) : null}
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					) : null
				}
			/>
			{data.canWrite && data.status !== 'archived' ? (
				<ArchiveDiscountDialog
					name={data.name}
					hasCodes={initial.application === 'code'}
					open={archiveOpen}
					onOpenChange={setArchiveOpen}
					onConfirm={() =>
						impact.guard({
							discountId: data.discountId,
							discountName: data.name,
							kind: 'archive',
							proceed: (choice) =>
								submitStatus('archived', choiceFields(choice)),
						})
					}
				/>
			) : null}
			<ResumeWithAutomationsDialog
				open={resumeOpen}
				discountName={data.name}
				automations={data.pairedAutomations}
				onClose={() => setResumeOpen(false)}
				onResume={(withAutomations) => {
					setResumeOpen(false)
					submitStatus(
						'active',
						withAutomations ? { resumeAutomations: '1' } : {},
					)
				}}
			/>
			{impact.render}
		</>
	)
}

function asStatus(value: string): 'active' | 'paused' | 'archived' {
	if (value === 'paused' || value === 'archived') return value
	return 'active'
}

/** What the status change did to messages, from the counts the action sent along. */
function CascadeNotice({
	cascade,
}: {
	cascade: {
		paused: number
		cancelled: number
		resumed: number
		notDone: number
	}
}) {
	const { paused, cancelled, resumed, notDone } = cascade
	return (
		<div role="status" className="space-y-1 px-4 pt-4 text-sm md:px-6">
			{paused > 0 ? (
				<p>
					<Plural
						value={paused}
						one="Paused 1 automation with this discount."
						other="Paused # automations with this discount."
					/>
				</p>
			) : null}
			{cancelled > 0 ? (
				<p>
					<Plural
						value={cancelled}
						one="Cancelled 1 scheduled broadcast."
						other="Cancelled # scheduled broadcasts."
					/>
				</p>
			) : null}
			{resumed > 0 ? (
				<p>
					<Plural
						value={resumed}
						one="Resumed 1 automation with this discount."
						other="Resumed # automations with this discount."
					/>
				</p>
			) : null}
			{notDone > 0 ? (
				<p className="text-destructive">
					<Trans>
						Some messages could not be changed. Ask someone who manages
						broadcasts and automations to check them.
					</Trans>
				</p>
			) : null}
		</div>
	)
}
