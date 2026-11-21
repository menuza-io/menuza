import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isImpersonating, requireUserId } from '@repo/auth'
import {
	GUEST_PHOTO_STATUSES,
	type GuestPhotoStatus,
	type GuestPhotoSubmission,
} from '@repo/common/guest-photos'
import {
	getLocalizedMenuValue,
	parseMenuItemImageKeys,
} from '@repo/common/menu-types'
import { db, eq, OrganizationMenuItem } from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	type ActionFunctionArgs,
	data,
	type LoaderFunctionArgs,
	useLoaderData,
	useRevalidator,
} from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	addGuestPhotoToDish,
	GUEST_PHOTO_MAX_DISH_PHOTOS,
	removeGuestPhotoFromDish,
	requireMenuGuestPhotosAccess,
} from '#app/utils/menu/guest-photos.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'

type OperatorPhotoItem = GuestPhotoSubmission & { previewUrl: string | null }

type TokenPayload = {
	jwt: string
	tenantApiUrl: string
	expiresAt: number
	impersonated: boolean
}

const AddActionSchema = z.object({
	intent: z.literal('add-to-dish'),
	submissionId: z.string().trim().min(1).max(128),
	itemId: z.string().trim().min(1).max(128),
	makePrimary: z
		.union([z.literal('true'), z.literal('false')])
		.optional()
		.transform((v) => v === 'true'),
})

const RemoveActionSchema = z.object({
	intent: z.literal('remove-from-dish'),
	submissionId: z.string().trim().min(1).max(128),
	itemId: z.string().trim().min(1).max(128),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
		siteDefaultLocale: true,
	})
	await requireMenuGuestPhotosAccess(request, organization)

	const rawItems = await db
		.select({
			id: OrganizationMenuItem.id,
			displayName: OrganizationMenuItem.displayName,
			imageKey: OrganizationMenuItem.imageKey,
			imageKeys: OrganizationMenuItem.imageKeys,
		})
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, organization.id))

	const items = rawItems.map((item) => ({
		id: item.id,
		displayName: item.displayName,
		photoCount: parseMenuItemImageKeys(item.imageKeys, item.imageKey).length,
	}))

	return {
		organization,
		items,
		maxDishPhotos: GUEST_PHOTO_MAX_DISH_PHOTOS,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		dataRegion: true,
	})
	await requireMenuGuestPhotosAccess(request, organization)
	const impersonated = await isImpersonating(request)

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'add-to-dish') {
		const parsed = AddActionSchema.safeParse({
			intent,
			submissionId: formData.get('submissionId'),
			itemId: formData.get('itemId'),
			makePrimary: formData.get('makePrimary') ?? undefined,
		})
		if (!parsed.success) {
			return data({ error: 'invalid_request' }, { status: 400 })
		}
		const result = await addGuestPhotoToDish({
			organization,
			userId,
			impersonated,
			submissionId: parsed.data.submissionId,
			itemId: parsed.data.itemId,
			makePrimary: parsed.data.makePrimary,
			request,
		})
		if (!result.ok) {
			return data({ error: result.error }, { status: result.status })
		}
		return data({
			ok: true,
			submissionId: parsed.data.submissionId,
			imageKeys: result.imageKeys,
		})
	}

	if (intent === 'remove-from-dish') {
		const parsed = RemoveActionSchema.safeParse({
			intent,
			submissionId: formData.get('submissionId'),
			itemId: formData.get('itemId'),
		})
		if (!parsed.success) {
			return data({ error: 'invalid_request' }, { status: 400 })
		}
		const result = await removeGuestPhotoFromDish({
			organization,
			userId,
			impersonated,
			submissionId: parsed.data.submissionId,
			itemId: parsed.data.itemId,
			request,
		})
		if (!result.ok) {
			return data({ error: result.error }, { status: result.status })
		}
		return data({
			ok: true,
			submissionId: parsed.data.submissionId,
			imageKeys: result.imageKeys,
		})
	}

	return data({ error: 'invalid_intent' }, { status: 400 })
}

export default function GuestPhotosModerationPage() {
	const { _ } = useLingui()
	const { organization, items, maxDishPhotos } = useLoaderData<typeof loader>()
	const revalidator = useRevalidator()

	const [statusFilter, setStatusFilter] = useState<GuestPhotoStatus>('pending')
	const [token, setToken] = useState<TokenPayload | null>(null)
	const [submissions, setSubmissions] = useState<OperatorPhotoItem[]>([])
	const [loading, setLoading] = useState(true)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [bulkBusy, setBulkBusy] = useState(false)
	const [loadError, setLoadError] = useState<string | null>(null)

	const defaultLocale = organization.siteDefaultLocale || 'en'
	const itemMap = useMemo(
		() => new Map(items.map((item) => [item.id, item])),
		[items],
	)

	const ensureToken = useCallback(async (): Promise<TokenPayload> => {
		if (token && token.expiresAt - Date.now() > 30_000) {
			return token
		}
		const res = await fetch(`/${organization.slug}/menu/photos-token`, {
			headers: { Accept: 'application/json' },
		})
		if (!res.ok) {
			throw new Error('Failed to obtain guest photo moderation token')
		}
		const next = (await res.json()) as TokenPayload
		setToken(next)
		return next
	}, [organization.slug, token])

	const loadSubmissions = useCallback(
		async (status: GuestPhotoStatus) => {
			setLoading(true)
			setLoadError(null)
			try {
				const creds = await ensureToken()
				const params = new URLSearchParams({ status, limit: '50' })
				const res = await fetch(
					`${creds.tenantApiUrl}/operator/photos?${params}`,
					{
						headers: {
							Accept: 'application/json',
							Authorization: `Bearer ${creds.jwt}`,
						},
					},
				)
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}`)
				}
				const payload = (await res.json()) as {
					submissions?: OperatorPhotoItem[]
				}
				setSubmissions(payload.submissions ?? [])
			} catch {
				setLoadError(_(msg`Could not load guest photos. Please try again.`))
			} finally {
				setLoading(false)
			}
		},
		[_, ensureToken],
	)

	useEffect(() => {
		void loadSubmissions(statusFilter)
	}, [loadSubmissions, statusFilter])

	const handleDecide = async (
		submissionId: string,
		decision: 'approve' | 'reject',
	) => {
		setBusyId(submissionId)
		try {
			const creds = await ensureToken()
			const res = await fetch(
				`${creds.tenantApiUrl}/operator/photos/${encodeURIComponent(submissionId)}/decide`,
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${creds.jwt}`,
					},
					body: JSON.stringify({ decision }),
				},
			)
			if (!res.ok) {
				const err = (await res.json().catch(() => null)) as {
					error?: string
				} | null
				toast.error(
					err?.error === 'already_decided'
						? _(msg`This photo has already been decided.`)
						: _(msg`Could not update submission.`),
				)
				await loadSubmissions(statusFilter)
				return
			}
			toast.success(
				decision === 'approve'
					? _(msg`Photo approved`)
					: _(msg`Photo rejected`),
			)
			await loadSubmissions(statusFilter)
		} finally {
			setBusyId(null)
		}
	}

	const addSingleToDish = async (
		submission: OperatorPhotoItem,
		makePrimary = false,
	): Promise<boolean> => {
		const formData = new FormData()
		formData.set('intent', 'add-to-dish')
		formData.set('submissionId', submission.id)
		formData.set('itemId', submission.itemId)
		if (makePrimary) formData.set('makePrimary', 'true')

		const actionRes = await fetch(`/${organization.slug}/menu/guest-photos`, {
			method: 'POST',
			body: formData,
		})
		if (!actionRes.ok) {
			const err = (await actionRes.json().catch(() => null)) as {
				error?: string
			} | null
			toast.error(
				err?.error === 'dish_photos_full'
					? _(msg`This dish already has the maximum number of photos.`)
					: err?.error === 'not_approved'
						? _(msg`Only approved photos can be added to a dish.`)
						: _(msg`Could not add photo to dish.`),
			)
			return false
		}
		return true
	}

	const handleAddToDish = async (
		submission: OperatorPhotoItem,
		makePrimary = false,
	) => {
		setBusyId(submission.id)
		try {
			const ok = await addSingleToDish(submission, makePrimary)
			if (ok) {
				toast.success(_(msg`Photo added to dish`))
				await Promise.all([
					loadSubmissions(statusFilter),
					revalidator.revalidate(),
				])
			}
		} finally {
			setBusyId(null)
		}
	}

	const handleAddAllApproved = async () => {
		setBulkBusy(true)
		try {
			let addedCount = 0
			for (const sub of submissions) {
				if (sub.status !== 'approved') continue
				const item = itemMap.get(sub.itemId)
				if (item && item.photoCount >= maxDishPhotos) continue
				const ok = await addSingleToDish(sub, false)
				if (ok) addedCount += 1
			}
			if (addedCount > 0) {
				toast.success(_(msg`Added approved photos to dishes`))
			}
			await Promise.all([
				loadSubmissions(statusFilter),
				revalidator.revalidate(),
			])
		} finally {
			setBulkBusy(false)
		}
	}

	const handleRemoveFromDish = async (submission: OperatorPhotoItem) => {
		setBusyId(submission.id)
		try {
			const formData = new FormData()
			formData.set('intent', 'remove-from-dish')
			formData.set('submissionId', submission.id)
			formData.set('itemId', submission.itemId)
			const res = await fetch(`/${organization.slug}/menu/guest-photos`, {
				method: 'POST',
				body: formData,
			})
			if (!res.ok) {
				toast.error(_(msg`Could not remove photo from dish.`))
				return
			}
			toast.success(_(msg`Removed from dish (kept approved)`))
			await Promise.all([
				loadSubmissions(statusFilter),
				revalidator.revalidate(),
			])
		} finally {
			setBusyId(null)
		}
	}

	const statusLabel = (status: GuestPhotoStatus) => {
		switch (status) {
			case 'pending':
				return _(msg`Pending`)
			case 'approved':
				return _(msg`Approved`)
			case 'added':
				return _(msg`Added`)
			case 'rejected':
				return _(msg`Rejected`)
		}
	}

	return (
		<div className="space-y-4">
			<Frame>
				<FrameHeader>
					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div>
							<FrameTitle>
								<Trans>Guest photos</Trans>
							</FrameTitle>
							<FrameDescription>
								<Trans>
									Review photos guests shared after ordering. Nothing appears
									publicly until you approve and add it to a dish.
								</Trans>
							</FrameDescription>
						</div>
						<div className="flex flex-wrap items-center gap-2">
							{GUEST_PHOTO_STATUSES.map((status) => (
								<Button
									key={status}
									type="button"
									size="sm"
									variant={statusFilter === status ? 'default' : 'outline'}
									aria-pressed={statusFilter === status}
									onClick={() => setStatusFilter(status)}
								>
									{statusLabel(status)}
								</Button>
							))}
							{statusFilter === 'approved' && submissions.length > 0 ? (
								<Button
									type="button"
									size="sm"
									disabled={bulkBusy || Boolean(token?.impersonated)}
									onClick={() => void handleAddAllApproved()}
								>
									<Trans>Add all approved</Trans>
								</Button>
							) : null}
						</div>
					</div>
				</FrameHeader>
				<FramePanel>
					{loadError ? (
						<p
							className="text-destructive text-sm"
							role="alert"
							aria-live="assertive"
						>
							{loadError}
						</p>
					) : loading ? (
						<p
							className="text-muted-foreground text-sm"
							role="status"
							aria-live="polite"
						>
							<Trans>Loading guest photos…</Trans>
						</p>
					) : submissions.length === 0 ? (
						<EmptyState
							icons={['image']}
							title={_(msg`No guest photos here`)}
							description={_(
								msg`Photos guests submit after ordering appear here for your review.`,
							)}
						/>
					) : (
						<ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
							{submissions.map((submission) => {
								const dish = itemMap.get(submission.itemId)
								const dishName = dish
									? getLocalizedMenuValue(
											dish.displayName,
											defaultLocale,
											defaultLocale,
										) || dish.displayName
									: submission.itemId
								const dishFull = (dish?.photoCount ?? 0) >= maxDishPhotos
								const isBusy = busyId === submission.id || bulkBusy

								return (
									<li
										key={submission.id}
										className="border-border bg-card flex flex-col overflow-hidden rounded-lg border"
									>
										<div className="bg-muted aspect-[4/3] w-full">
											{submission.previewUrl ? (
												<img
													src={submission.previewUrl}
													alt={_(msg`Guest photo of ${dishName}`)}
													className="size-full object-cover"
												/>
											) : (
												<div className="text-muted-foreground flex size-full items-center justify-center">
													<Icon name="image" className="size-8" />
												</div>
											)}
										</div>
										<div className="flex flex-1 flex-col gap-3 p-4">
											<div className="flex items-start justify-between gap-2">
												<div className="min-w-0">
													<p className="text-foreground truncate font-medium wrap-anywhere">
														{dishName}
													</p>
													<p className="text-muted-foreground text-xs">
														{new Date(submission.createdAt).toLocaleString()}
													</p>
												</div>
												<Badge variant="secondary">
													{statusLabel(submission.status)}
												</Badge>
											</div>

											{submission.status === 'pending' ? (
												<div className="mt-auto flex gap-2">
													<Button
														type="button"
														size="sm"
														className="flex-1"
														disabled={isBusy || Boolean(token?.impersonated)}
														onClick={() =>
															void handleDecide(submission.id, 'approve')
														}
													>
														<Trans>Approve</Trans>
													</Button>
													<Button
														type="button"
														size="sm"
														variant="outline"
														className="flex-1"
														disabled={isBusy || Boolean(token?.impersonated)}
														onClick={() =>
															void handleDecide(submission.id, 'reject')
														}
													>
														<Trans>Reject</Trans>
													</Button>
												</div>
											) : null}

											{submission.status === 'approved' ? (
												<div className="mt-auto space-y-2">
													{dishFull ? (
														<p className="text-muted-foreground text-xs">
															<Trans>
																This dish already has the maximum{' '}
																{maxDishPhotos} photos.
															</Trans>
														</p>
													) : null}
													<div className="flex flex-wrap gap-2">
														<Button
															type="button"
															size="sm"
															className="flex-1"
															disabled={
																isBusy ||
																dishFull ||
																Boolean(token?.impersonated)
															}
															onClick={() =>
																void handleAddToDish(submission, false)
															}
														>
															<Trans>Add to dish</Trans>
														</Button>
														<Button
															type="button"
															size="sm"
															variant="outline"
															disabled={
																isBusy ||
																dishFull ||
																Boolean(token?.impersonated)
															}
															onClick={() =>
																void handleAddToDish(submission, true)
															}
														>
															<Trans>Make main</Trans>
														</Button>
													</div>
												</div>
											) : null}

											{submission.status === 'added' ? (
												<div className="mt-auto flex gap-2">
													<Button
														type="button"
														size="sm"
														variant="outline"
														className="w-full"
														disabled={isBusy || Boolean(token?.impersonated)}
														onClick={() =>
															void handleRemoveFromDish(submission)
														}
													>
														<Trans>Remove from dish</Trans>
													</Button>
												</div>
											) : null}
										</div>
									</li>
								)
							})}
						</ul>
					)}
				</FramePanel>
			</Frame>
		</div>
	)
}
