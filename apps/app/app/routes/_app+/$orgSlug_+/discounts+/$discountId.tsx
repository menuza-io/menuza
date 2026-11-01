import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useActionData,
	useLoaderData,
	Link,
	useNavigation,
} from 'react-router'
import { ArchiveDiscountButton } from '#app/components/discounts/archive-discount-button.tsx'
import { DiscountForm } from '#app/components/discounts/discount-form.tsx'
import { requireDiscountsAccess } from '#app/utils/discounts/access.server.ts'
import {
	getDiscount,
	getDiscountCreatedBy,
} from '#app/utils/discounts/discounts.server.ts'
import { loadDiscountEditorData } from '#app/utils/discounts/editor-data.server.ts'
import { stateFromDefinition } from '#app/utils/discounts/editor-model.ts'
import { listDiscountHistory } from '#app/utils/discounts/history.server.ts'
import { discountVisibleInScope } from '#app/utils/discounts/location-scope.server.ts'
import {
	type DiscountEditorActionData,
	saveDiscountEditor,
} from '#app/utils/discounts/save.server.ts'
import { couponPrintHref } from '#app/utils/print/restaurant/coupon.server.ts'

export async function loader({ request, params }: LoaderFunctionArgs) {
	const access = await requireDiscountsAccess(request, params.orgSlug)
	const discountId = params.discountId
	if (!discountId) throw new Response('Not Found', { status: 404 })
	const loaded = await getDiscount(access.organization.id, discountId)
	if (
		!loaded?.stored ||
		!discountVisibleInScope(
			loaded.stored.definition.locationIds,
			access.locationIds,
		)
	) {
		throw new Response('Not Found', { status: 404 })
	}
	const editor = await loadDiscountEditorData(access.organization.id)
	const status = asStatus(loaded.row.status)
	const storedCurrency = loaded.row.currency ?? access.currency
	const [createdBy, history, printHref] = await Promise.all([
		getDiscountCreatedBy(loaded.row.createdById),
		listDiscountHistory(access.organization.id, discountId),
		couponPrintHref({
			userId: access.userId,
			organization: access.organization,
			discount: {
				id: discountId,
				status: loaded.row.status,
				definition: loaded.stored.definition,
				codeCount: loaded.codes.length,
			},
		}),
	])
	return {
		orgSlug: access.organization.slug,
		// The form takes the currency of the chosen locations; this one serves an
		// organization without locations (see the action).
		currency: storedCurrency,
		features: access.features,
		canWrite: access.canWrite,
		// A coupon card for this discount, when the Print shop can make one.
		printHref,
		editor,
		discountId,
		name: loaded.row.name,
		version: loaded.row.version,
		status,
		createdBy,
		history,
		createdAt: loaded.row.createdAt.toISOString(),
		initial: loaded.stored
			? stateFromDefinition(
					loaded.stored.definition,
					loaded.codes,
					storedCurrency,
				)
			: null,
	}
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
	const nextStatus = data.status === 'active' ? 'paused' : 'active'
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
			<DiscountForm
				key={`${data.discountId}:${mount.generation}`}
				mode="edit"
				orgSlug={data.orgSlug}
				currency={data.currency}
				features={data.features}
				catalog={data.editor.catalog}
				locations={data.editor.locations}
				choices={data.editor.choices}
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
				statusActions={({ dirty }) =>
					data.canWrite || data.printHref ? (
						<>
							{data.printHref ? (
								<Button
									variant="outline"
									disabled={dirty}
									title={
										dirty ? t`Save or discard your changes first.` : undefined
									}
									render={<Link to={data.printHref} />}
								>
									<Trans>Print coupons</Trans>
								</Button>
							) : null}
							{data.canWrite ? (
								<>
									<Button
										type="submit"
										form="discount-status"
										name="status"
										value={data.status === 'archived' ? 'paused' : nextStatus}
										variant="outline"
										disabled={dirty}
										title={
											dirty ? t`Save or discard your changes first.` : undefined
										}
									>
										{data.status === 'active'
											? t`Pause`
											: data.status === 'archived'
												? t`Restore`
												: t`Resume`}
									</Button>
									<Button
										type="submit"
										form="discount-duplicate"
										variant="outline"
										disabled={dirty}
										title={
											dirty ? t`Save or discard your changes first.` : undefined
										}
									>
										<Trans>Duplicate</Trans>
									</Button>
									{data.status !== 'archived' ? (
										<ArchiveDiscountButton
											name={data.name}
											hasCodes={initial.application === 'code'}
											variant="outline"
											size="default"
											disabled={dirty}
											title={
												dirty
													? t`Save or discard your changes first.`
													: undefined
											}
											onConfirm={() => {
												const form = document.getElementById(
													'discount-status',
												) as HTMLFormElement | null
												if (!form) return
												const status = document.createElement('input')
												status.type = 'hidden'
												status.name = 'status'
												status.value = 'archived'
												form.appendChild(status)
												form.requestSubmit()
											}}
										/>
									) : null}
								</>
							) : null}
						</>
					) : null
				}
			/>
		</>
	)
}

function asStatus(value: string): 'active' | 'paused' | 'archived' {
	if (value === 'paused' || value === 'archived') return value
	return 'active'
}
