import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { countSummarySchema, listCountListsResultSchema } from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	ChoiceCard,
	ChoiceCardContent,
	ChoiceCardDescription,
	ChoiceCardTitle,
} from '@repo/ui/choice-card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Skeleton } from '@repo/ui/skeleton'
import { useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useNotifyInventoryChanged } from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { inventoryCountPath } from '#app/utils/inventory/nav.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

const EVERYTHING = 'all'

/**
 * Start a count. It asks one thing: which list. "Everything" counts every
 * item kept at this location; a saved count list ("Proteins daily") counts
 * only its items. Only one count per list can be open at a time: starting
 * another points to the one that is.
 */
export function StartCountDialog({
	open,
	onOpenChange,
	orgSlug,
	locationId,
	search,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	orgSlug: string
	locationId: string
	/** The query string to keep on links, with its `?`. */
	search: string
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const navigate = useNavigate()
	const notifyChanged = useNotifyInventoryChanged()
	const groupId = useId()
	const lists = useInventoryQuery(
		open ? `/count-lists?locationId=${encodeURIComponent(locationId)}` : null,
		listCountListsResultSchema,
	)
	const [choice, setChoice] = useState(EVERYTHING)
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [openCountId, setOpenCountId] = useState<string | null>(null)
	// A retry replays the same start, never a second count.
	const clientIdRef = useRef(newClientId('s'))

	async function start() {
		if (submitting) return
		setSubmitting(true)
		setError(null)
		setOpenCountId(null)
		try {
			const count = countSummarySchema.parse(
				await request('/counts', {
					method: 'POST',
					body: JSON.stringify({
						clientId: clientIdRef.current,
						locationId,
						listId: choice === EVERYTHING ? null : choice,
					}),
				}),
			)
			clientIdRef.current = newClientId('s')
			notifyChanged()
			onOpenChange(false)
			void navigate(`${inventoryCountPath(orgSlug, count.id)}${search}`)
		} catch (caught) {
			if (
				caught instanceof OperatorRequestError &&
				caught.code === 'count_in_progress' &&
				typeof caught.body?.countId === 'string'
			) {
				setOpenCountId(caught.body.countId)
			} else {
				setError(i18n._(inventorySaveErrorMessage(caught)))
			}
		} finally {
			setSubmitting(false)
		}
	}

	const savedLists = lists.data?.lists ?? []

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!submitting) onOpenChange(next)
			}}
		>
			<DialogContent className="sm:max-w-md" data-testid="start-count-dialog">
				<DialogHeader>
					<DialogTitle>
						<Trans>Start a count</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Choose what to count. You walk your storage areas in order and
							enter what is there.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{openCountId ? (
					<Alert data-testid="start-count-in-progress">
						<Icon name="alert-triangle" />
						<AlertDescription>
							<Trans>This count is already in progress.</Trans>
						</AlertDescription>
						<AlertAction>
							<Button
								variant="outline"
								size="sm"
								render={
									<Link
										to={`${inventoryCountPath(orgSlug, openCountId)}${search}`}
									/>
								}
								onClick={() => onOpenChange(false)}
							>
								<Trans>Resume it</Trans>
							</Button>
						</AlertAction>
					</Alert>
				) : null}

				{error ? (
					<Alert variant="destructive" data-testid="start-count-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				{lists.error && !lists.data ? (
					<Alert variant="destructive">
						<AlertDescription>
							{i18n._(inventoryErrorMessage(lists.error))}
						</AlertDescription>
						<AlertAction>
							<Button variant="outline" size="sm" onClick={lists.reload}>
								<Trans>Try again</Trans>
							</Button>
						</AlertAction>
					</Alert>
				) : lists.loading && !lists.data ? (
					<div role="status" className="flex flex-col gap-2">
						<span className="sr-only">
							<Trans>Loading your count lists</Trans>
						</span>
						<Skeleton className="h-14 w-full" />
						<Skeleton className="h-14 w-full" />
					</div>
				) : (
					<RadioGroup
						value={choice}
						onValueChange={setChoice}
						className="gap-2"
						aria-label={t`What to count`}
						data-testid="start-count-choices"
					>
						<ChoiceCard htmlFor={`${groupId}-all`}>
							<RadioGroupItem id={`${groupId}-all`} value={EVERYTHING} />
							<ChoiceCardContent>
								<ChoiceCardTitle>
									<Trans>Everything</Trans>
								</ChoiceCardTitle>
								<ChoiceCardDescription>
									<Trans>Every item you keep at this location.</Trans>
								</ChoiceCardDescription>
							</ChoiceCardContent>
						</ChoiceCard>
						{savedLists.map((list) => (
							<ChoiceCard key={list.id} htmlFor={`${groupId}-${list.id}`}>
								<RadioGroupItem
									id={`${groupId}-${list.id}`}
									value={list.id}
									data-testid={`start-count-list-${list.id}`}
								/>
								<ChoiceCardContent>
									<ChoiceCardTitle>
										<span className="wrap-anywhere">{list.name}</span>
									</ChoiceCardTitle>
									<ChoiceCardDescription>
										<Plural
											value={list.itemIds.length}
											one="# item"
											other="# items"
										/>
									</ChoiceCardDescription>
								</ChoiceCardContent>
							</ChoiceCard>
						))}
					</RadioGroup>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={() => void start()}
						disabled={submitting}
						data-testid="start-count-submit"
					>
						{submitting ? <Trans>Starting…</Trans> : <Trans>Start count</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
