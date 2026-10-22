import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from '@repo/ui/dialog'
import { Field, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemMedia,
	ItemTitle,
} from '@repo/ui/item'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Spinner } from '@repo/ui/spinner'
import {
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
	type FormEvent,
} from 'react'
import { useFetcher } from 'react-router'
import { toast } from 'sonner'
import { UserAvatar } from '#app/components/user-avatar.tsx'
import {
	type DashboardActionErrorCode,
	type DashboardActionResult,
} from '#app/utils/dashboards/actions.server.ts'
import {
	DASHBOARD_SHARE_ACCESS,
	type DashboardShareAccess,
} from '#app/utils/dashboards/config.ts'
import { type DashboardSharing } from '#app/utils/dashboards/queries.server.ts'
import { SHARE_ACCESS_OPTIONS } from './access-labels.ts'

type Person = { name: string | null; username: string }

function displayName(person: Person) {
	return person.name?.trim() || person.username
}

function isShareAccess(value: unknown): value is DashboardShareAccess {
	return DASHBOARD_SHARE_ACCESS.some((access) => access === value)
}

function shareErrorMessage(code: DashboardActionErrorCode): MessageDescriptor {
	switch (code) {
		case 'invalid-share-target':
			return msg`Choose an active member of this organization.`
		case 'invalid-access':
			return msg`Choose View or Edit access.`
		case 'forbidden':
			return msg`Only the owner can share this dashboard.`
		default:
			return msg`The dashboard could not be shared. Please try again.`
	}
}

/** Calls `onDone` once for each answer the fetcher gets back. */
function useFetcherResult(
	fetcher: { state: string; data?: DashboardActionResult },
	onDone: (result: DashboardActionResult) => void,
) {
	const handledRef = useRef(fetcher.data)

	useEffect(() => {
		const result = fetcher.data
		if (fetcher.state !== 'idle' || !result || result === handledRef.current) {
			return
		}
		handledRef.current = result
		onDone(result)
	}, [fetcher.data, fetcher.state, onDone])
}

function useAccessItems() {
	const { _ } = useLingui()
	return DASHBOARD_SHARE_ACCESS.map((access) => ({
		value: access,
		label: _(SHARE_ACCESS_OPTIONS[access]),
	}))
}

function AccessOptions({
	items,
}: {
	items: ReturnType<typeof useAccessItems>
}) {
	return items.map((item) => (
		<SelectItem key={item.value} value={item.value}>
			{item.label}
		</SelectItem>
	))
}

/** Picks a member and an access level, then shares with them. */
function ShareForm({
	action,
	sharing,
}: {
	action: string
	sharing: DashboardSharing
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<DashboardActionResult>()
	const personId = useId()
	const accessId = useId()
	const accessItems = useAccessItems()
	const [userId, setUserId] = useState<string | null>(null)
	const [access, setAccess] = useState<DashboardShareAccess>('view')
	const [error, setError] = useState<DashboardActionErrorCode | null>(null)
	const busy = fetcher.state !== 'idle'
	const sharedWith = new Set(sharing.shares.map((share) => share.userId))

	useFetcherResult(
		fetcher,
		useCallback((result: DashboardActionResult) => {
			if (result.ok) {
				setUserId(null)
				setAccess('view')
			} else {
				setError(result.error.code)
			}
		}, []),
	)

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!userId) return
		setError(null)
		void fetcher.submit(
			{ intent: 'share', userId, access },
			{ method: 'POST', action },
		)
	}

	if (sharing.members.length === 0) {
		return (
			<p className="text-muted-foreground text-sm">
				<Trans>There is no one else in this organization to share with.</Trans>
			</p>
		)
	}

	return (
		<form noValidate onSubmit={submit} className="grid gap-3">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end">
				<Field className="min-w-0 flex-1">
					<FieldLabel htmlFor={personId}>
						<Trans>Person</Trans>
					</FieldLabel>
					<Select
						value={userId}
						onValueChange={(value) => {
							setUserId(value)
							setError(null)
						}}
						items={sharing.members.map((member) => ({
							value: member.id,
							label: displayName(member),
						}))}
					>
						<SelectTrigger id={personId} className="w-full min-w-0">
							<SelectValue placeholder={_(msg`Choose a member`)} />
						</SelectTrigger>
						<SelectContent className="w-auto max-w-(--available-width) min-w-(--anchor-width)">
							{sharing.members.map((member) => {
								const hasAccess = sharedWith.has(member.id)
								return (
									<SelectItem
										key={member.id}
										value={member.id}
										disabled={hasAccess}
									>
										<span>{displayName(member)}</span>
										<span className="text-muted-foreground">
											{hasAccess ? (
												<Trans>Has access</Trans>
											) : (
												`@${member.username}`
											)}
										</span>
									</SelectItem>
								)
							})}
						</SelectContent>
					</Select>
				</Field>
				<Field className="sm:w-32">
					<FieldLabel htmlFor={accessId}>
						<Trans>Access</Trans>
					</FieldLabel>
					<Select
						value={access}
						onValueChange={(value) => {
							if (isShareAccess(value)) setAccess(value)
							setError(null)
						}}
						items={accessItems}
					>
						<SelectTrigger id={accessId} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<AccessOptions items={accessItems} />
						</SelectContent>
					</Select>
				</Field>
				<Button type="submit" disabled={!userId || busy}>
					{busy ? <Spinner /> : null}
					<Trans>Share</Trans>
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{_(shareErrorMessage(error))}
				</p>
			) : null}
		</form>
	)
}

/** Someone the dashboard is shared with, whose access can be changed. */
function ShareRow({
	action,
	share,
}: {
	action: string
	share: DashboardSharing['shares'][number]
}) {
	const { _ } = useLingui()
	const accessFetcher = useFetcher<DashboardActionResult>()
	const removeFetcher = useFetcher<DashboardActionResult>()
	const accessItems = useAccessItems()
	const name = displayName(share)
	const pendingAccess = accessFetcher.formData?.get('access')
	const access = isShareAccess(pendingAccess) ? pendingAccess : share.access
	const removing = removeFetcher.state !== 'idle'

	useFetcherResult(
		accessFetcher,
		useCallback(
			(result: DashboardActionResult) => {
				if (!result.ok) {
					toast.error(
						_(msg`The access could not be changed. Please try again.`),
					)
				}
			},
			[_],
		),
	)
	useFetcherResult(
		removeFetcher,
		useCallback(
			(result: DashboardActionResult) => {
				if (!result.ok) {
					toast.error(
						_(msg`The access could not be removed. Please try again.`),
					)
				}
			},
			[_],
		),
	)

	return (
		<Item role="listitem" variant="outline" size="sm">
			<ItemMedia>
				<UserAvatar user={share} />
			</ItemMedia>
			<ItemContent className="min-w-0">
				<ItemTitle className="max-w-full">
					<span className="truncate">{name}</span>
				</ItemTitle>
				<ItemDescription className="truncate">
					{share.isActiveMember ? (
						`@${share.username}`
					) : (
						<Trans>No longer a member of this organization</Trans>
					)}
				</ItemDescription>
			</ItemContent>
			<ItemActions>
				<Select
					value={access}
					disabled={!share.isActiveMember || removing}
					onValueChange={(value) => {
						if (!isShareAccess(value) || value === access) return
						void accessFetcher.submit(
							{ intent: 'share', userId: share.userId, access: value },
							{ method: 'POST', action },
						)
					}}
					items={accessItems}
				>
					<SelectTrigger
						size="sm"
						className="w-24"
						aria-label={_(msg`Access for ${name}`)}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<AccessOptions items={accessItems} />
					</SelectContent>
				</Select>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={_(msg`Remove access for ${name}`)}
					disabled={removing}
					onClick={() =>
						void removeFetcher.submit(
							{ intent: 'unshare', userId: share.userId },
							{ method: 'POST', action },
						)
					}
				>
					{removing ? <Spinner /> : <Icon name="x" />}
				</Button>
			</ItemActions>
		</Item>
	)
}

// A private-use character stands in for the name while the title is
// translated, so word order stays in the catalog but `Trans` never parses a
// name like `<i>Revenue</i>` as markup.
const NAME_SLOT = '\uE000'

/**
 * The owner's Share button for a custom dashboard. Its dialog shares the
 * dashboard with active members of the organization, with View or Edit
 * access, and changes or removes the access of people who have it.
 */
export function ShareDashboardDialog({
	action,
	name,
	sharing,
}: {
	/** The dashboard's URL, which takes its intents. */
	action: string
	name: string
	sharing: DashboardSharing
}) {
	const listLabelId = useId()
	const { _ } = useLingui()
	const [titleBefore = '', titleAfter = ''] = _(
		msg`Share “${{ name: NAME_SLOT }}”`,
	).split(NAME_SLOT)

	return (
		<Dialog>
			<DialogTrigger
				render={<Button type="button" variant="outline" size="sm" />}
			>
				<Icon name="user-plus" />
				<Trans>Share</Trans>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						<span className="wrap-anywhere">
							{titleBefore}
							<bdi>{name}</bdi>
							{titleAfter}
						</span>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							People you share with find this dashboard under “Shared with me”.
							View access lets them look at it. Edit access also lets them
							change its blocks and layout for everyone.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<ShareForm action={action} sharing={sharing} />
				<div className="grid gap-2">
					<h3 id={listLabelId} className="text-sm font-medium">
						<Trans>People with access</Trans>
					</h3>
					{sharing.shares.length === 0 ? (
						<p className="text-muted-foreground text-sm">
							<Trans>Not shared with anyone yet.</Trans>
						</p>
					) : (
						<ItemGroup
							aria-labelledby={listLabelId}
							className="max-h-72 gap-2 overflow-y-auto"
						>
							{sharing.shares.map((share) => (
								<ShareRow key={share.userId} action={action} share={share} />
							))}
						</ItemGroup>
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}
