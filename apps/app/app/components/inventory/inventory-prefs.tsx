import { plural } from '@lingui/core/macro'
import { useLingui } from '@lingui/react/macro'
import {
	defaultUnitSystem,
	inventorySettingsSchema,
	type UnitSystem,
} from '@repo/inventory'
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { useInventoryQuery } from '#app/hooks/use-inventory-client.ts'
import {
	type FormatQuantityOptions,
	formatQuantity,
	formatUnitName,
	type ItemUnitLike,
	type UnitLabels,
} from '#app/utils/inventory/format.ts'

/**
 * Two small shared facts for every Inventory screen: the unit system the
 * organization shows (metric or US; the region's default until its settings
 * arrive) and a change counter that a save bumps so lists refetch.
 */

const UnitSystemContext = createContext<UnitSystem>('metric')
/** The organization's target food cost in basis points; null until settings arrive. */
const TargetFoodCostContext = createContext<number | null>(null)

export function InventoryPrefsProvider({
	dataRegion,
	children,
}: {
	dataRegion: 'us' | 'ksa'
	children: ReactNode
}) {
	const settings = useInventoryQuery('/settings', inventorySettingsSchema)
	const { reload } = settings
	const revision = useInventoryRevision()
	const seenRevision = useRef(revision)
	useEffect(() => {
		if (revision !== seenRevision.current) {
			seenRevision.current = revision
			reload()
		}
	}, [revision, reload])
	const unitSystem = settings.data?.unitSystem ?? defaultUnitSystem(dataRegion)
	return (
		<UnitSystemContext.Provider value={unitSystem}>
			<TargetFoodCostContext.Provider
				value={settings.data?.targetFoodCostBp ?? null}
			>
				{children}
			</TargetFoodCostContext.Provider>
		</UnitSystemContext.Provider>
	)
}

/** Target food cost (3000 = 30%) from the one settings read, or null while it loads. */
export function useInventoryTargetFoodCostBp(): number | null {
	return useContext(TargetFoodCostContext)
}

export function useInventoryUnitSystem(): UnitSystem {
	return useContext(UnitSystemContext)
}

const ChangeContext = createContext<{ revision: number; notify: () => void }>({
	revision: 0,
	notify: () => {},
})

/** Holds the counter; mount once in the layout. */
export function InventoryChangeProvider({ children }: { children: ReactNode }) {
	const [revision, setRevision] = useState(0)
	const notify = useCallback(() => setRevision((value) => value + 1), [])
	const value = useMemo(() => ({ revision, notify }), [revision, notify])
	return (
		<ChangeContext.Provider value={value}>{children}</ChangeContext.Provider>
	)
}

/** Changes whenever something saved (waste logged, item added); refetch on it. */
export function useInventoryRevision(): number {
	return useContext(ChangeContext).revision
}

/** Call after a save so every mounted list reloads. */
export function useNotifyInventoryChanged(): () => void {
	return useContext(ChangeContext).notify
}

/** Quantity and unit text in the viewer's language and the organization's unit system. */
export function useQuantityFormat() {
	const { t, i18n } = useLingui()
	const system = useInventoryUnitSystem()
	const labels = useMemo<UnitLabels>(
		() => ({
			piece: (amount) =>
				`${new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 3 }).format(amount)} ${plural(amount, { one: 'piece', other: 'pieces' })}`,
			pieceName: plural(2, { one: 'piece', other: 'pieces' }),
			quart: (amount) =>
				`${new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 3 }).format(amount)} ${t`qt`}`,
			quartName: t`qt`,
		}),
		[i18n.locale, t],
	)
	return useMemo(() => {
		const base = { system, locale: i18n.locale, labels }
		return {
			system,
			locale: i18n.locale,
			labels,
			format: (
				quantity: number,
				item: Pick<FormatQuantityOptions, 'baseUnit' | 'countUnit' | 'units'>,
			) => formatQuantity(quantity, { ...base, ...item }),
			unitName: (unitRef: string, units: readonly ItemUnitLike[] | undefined) =>
				formatUnitName(unitRef, { units, locale: i18n.locale, labels }),
		}
	}, [system, i18n.locale, labels])
}
