import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage, WorkspaceTabBar } from '@repo/ui/workspace'
import { createContext, type ReactNode, useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation } from 'react-router'
import { LogWasteDialog } from '#app/components/inventory/log-waste-dialog.tsx'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	type InventoryNavAccess,
	type InventoryRoute,
	inventoryRouteFromPath,
	inventorySettingsPath,
	type InventoryTab,
	inventoryTabFromPath,
	inventoryTabPath,
	visibleInventoryTabs,
} from '#app/utils/inventory/nav.ts'

export type InventoryChromeLocation = { id: string; name: string }

const TAB_LABELS = {
	today: msg`Today`,
	stock: msg`Stock`,
	counts: msg`Counts`,
	purchasing: msg`Purchasing`,
	prep: msg`Prep`,
	waste: msg`Waste`,
} as const

const TAB_HEADERS: Record<
	InventoryRoute,
	{ title: ReturnType<typeof msg>; description: ReturnType<typeof msg> }
> = {
	today: {
		title: msg`Inventory`,
		description: msg`What needs you today.`,
	},
	stock: {
		title: msg`Stock`,
		description: msg`Every item, how much you have, where you keep it and what it is worth.`,
	},
	counts: {
		title: msg`Counts`,
		description: msg`Start, continue and review stock counts.`,
	},
	purchasing: {
		title: msg`Purchasing`,
		description: msg`Deliveries, orders and the suppliers you buy from.`,
	},
	prep: {
		title: msg`Prep`,
		description: msg`What to make today, and what is done.`,
	},
	waste: {
		title: msg`Waste`,
		description: msg`What was thrown away, why, and what it cost.`,
	},
	transfers: {
		title: msg`Transfers`,
		description: msg`Move stock between your locations.`,
	},
	settings: {
		title: msg`Inventory settings`,
		description: msg`Units, target food cost, count reminders, and receiving rules.`,
	},
}

const InventoryActionsSlotContext = createContext<HTMLElement | null>(null)

/**
 * Renders `children` in the page header's action area (a tab's primary
 * action). Waits for the header to mount rather than flash in the wrong place.
 */
export function InventoryHeaderActions({ children }: { children: ReactNode }) {
	const target = useContext(InventoryActionsSlotContext)
	if (!target) return null
	return createPortal(children, target)
}

/** The location picker: no control at all for a single location. */
export function InventoryHeaderControls({
	locations,
	selectedLocationId,
	onChange,
}: {
	locations: readonly InventoryChromeLocation[]
	selectedLocationId: string
	onChange: (locationId: string) => void
}) {
	const { t } = useLingui()
	return locations.length > 1 ? (
		<FilterSelect
			id="inventory-location-select"
			testId="inventory-location-select"
			label={t`Location`}
			options={locations.map((loc) => ({ value: loc.id, label: loc.name }))}
			value={selectedLocationId}
			onValueChange={onChange}
		/>
	) : null
}

/**
 * The Inventory page chrome: one PageHeader (per-tab title and description,
 * actions, location picker), one underline tab bar with the five tabs, then
 * the screen.
 */
export function InventoryChrome({
	orgSlug,
	nav,
	locations,
	selectedLocationId,
	onLocationChange,
	canLogWaste = false,
	canSeeCost = false,
	currency = 'USD',
	userName = '',
	children,
}: {
	orgSlug: string
	nav: InventoryNavAccess
	locations: readonly InventoryChromeLocation[]
	selectedLocationId: string
	onLocationChange: (locationId: string) => void
	/** Shows "Log waste" in every tab's header (needs `update:inventory:any`). */
	canLogWaste?: boolean
	canSeeCost?: boolean
	currency?: string
	/** The signed-in member, for "Logged as". */
	userName?: string
	children: ReactNode
}) {
	const { t, i18n } = useLingui()
	const location = useLocation()
	const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null)
	const [wasteOpen, setWasteOpen] = useState(false)

	const activeRoute: InventoryRoute =
		inventoryRouteFromPath(location.pathname, orgSlug) ?? 'today'
	const routeKey: InventoryTab | null =
		inventoryTabFromPath(location.pathname, orgSlug) ??
		(activeRoute === 'settings' || activeRoute === 'transfers' ? null : 'today')
	const header = TAB_HEADERS[activeRoute]
	const locParam = new URLSearchParams(location.search).get('locationId')
	const search =
		locations.length > 1 && locParam
			? `?locationId=${encodeURIComponent(locParam)}`
			: ''

	const tabs = visibleInventoryTabs(nav).map((tab) => ({
		label: i18n._(TAB_LABELS[tab]),
		href: `${inventoryTabPath(orgSlug, tab)}${search}`,
		isActive: tab === routeKey,
	}))

	return (
		<InventoryActionsSlotContext.Provider value={actionsSlot}>
			<WorkspacePage>
				<div className="flex flex-col gap-6" data-testid="inventory-chrome">
					<PageHeader
						title={i18n._(header.title)}
						description={i18n._(header.description)}
						actions={
							<>
								{canLogWaste ? (
									<Button
										type="button"
										variant="outline"
										onClick={() => setWasteOpen(true)}
										data-testid="inventory-log-waste"
									>
										<Icon name="trash-2" />
										<Trans>Log waste</Trans>
									</Button>
								) : null}
								<Button
									variant={activeRoute === 'settings' ? 'secondary' : 'outline'}
									size="icon-sm"
									render={
										<Link to={`${inventorySettingsPath(orgSlug)}${search}`} />
									}
									aria-label={t`Inventory settings`}
									data-testid="inventory-settings-link"
								>
									<Icon name="settings" />
								</Button>
								<div ref={setActionsSlot} className="contents" />
								<InventoryHeaderControls
									locations={locations}
									selectedLocationId={selectedLocationId}
									onChange={onLocationChange}
								/>
							</>
						}
					/>
					<WorkspaceTabBar
						label={t`Inventory sections`}
						className="print:hidden"
						tabs={tabs}
					/>
					{children}
				</div>
				{canLogWaste ? (
					<LogWasteDialog
						open={wasteOpen}
						onOpenChange={setWasteOpen}
						orgSlug={orgSlug}
						locationId={selectedLocationId}
						canSeeCost={canSeeCost}
						currency={currency}
						userName={userName}
					/>
				) : null}
			</WorkspacePage>
		</InventoryActionsSlotContext.Provider>
	)
}
