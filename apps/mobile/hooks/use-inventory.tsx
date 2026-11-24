import AsyncStorage from '@react-native-async-storage/async-storage'
import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { useOrganizations } from '../lib/api/hooks/use-organizations'
import { fetchInventoryAccess } from '../lib/inventory/access-api'
import {
	createRegionClient,
	type InventoryAccess,
	type RegionClient,
	RegionError,
} from '../lib/inventory/region-client'

export type InventoryStatus =
	| 'loading'
	| 'ready'
	/** The module is not turned on for this organization. */
	| 'off'
	/** The member has no inventory role. */
	| 'no_access'
	| 'error'

export interface InventoryContextValue {
	status: InventoryStatus
	organizationId: string | null
	client: RegionClient | null
	access: InventoryAccess | null
	locationId: string | null
	setLocationId: (id: string) => void
	can: (grant: string) => boolean
	reload: () => void
}

const InventoryContext = createContext<InventoryContextValue | null>(null)

const LOCATION_KEY = 'menuza.inventory.location'

/**
 * The phone's inventory session: the selected organization (the one the
 * switcher made the default), a region client that fetches and renews the
 * short-lived inventory token, the member's grants and locations, and the
 * location the screens work on. The location is limited to the member's own
 * (the token route only names those) and remembered per organization.
 */
export function InventoryProvider({ children }: { children: React.ReactNode }) {
	const { organizations, isLoading } = useOrganizations()
	const organizationId = organizations.find((org) => org.isDefault)?.id ?? null
	const [access, setAccess] = useState<InventoryAccess | null>(null)
	const [status, setStatus] = useState<InventoryStatus>('loading')
	const [locationId, setLocation] = useState<string | null>(null)
	const [attempt, setAttempt] = useState(0)

	const client = useMemo(
		() =>
			organizationId
				? createRegionClient({
						organizationId,
						fetchAccess: fetchInventoryAccess,
					})
				: null,
		[organizationId],
	)

	useEffect(() => {
		if (!client || !organizationId) {
			setAccess(null)
			setStatus(isLoading ? 'loading' : 'error')
			return
		}
		let live = true
		setStatus('loading')
		void (async () => {
			try {
				const granted = await client.access('read')
				const saved = await AsyncStorage.getItem(
					`${LOCATION_KEY}:${organizationId}`,
				).catch(() => null)
				if (!live) return
				setAccess(granted)
				setLocation(
					granted.locations.find((location) => location.id === saved)?.id ??
						granted.locations[0]?.id ??
						null,
				)
				setStatus('ready')
			} catch (error) {
				if (!live) return
				setAccess(null)
				setStatus(
					error instanceof RegionError && error.status === 404
						? 'off'
						: error instanceof RegionError && error.status === 403
							? 'no_access'
							: 'error',
				)
			}
		})()
		return () => {
			live = false
		}
	}, [client, organizationId, isLoading, attempt])

	const setLocationId = useCallback(
		(id: string) => {
			setLocation(id)
			if (organizationId) {
				void AsyncStorage.setItem(
					`${LOCATION_KEY}:${organizationId}`,
					id,
				).catch(() => undefined)
			}
		},
		[organizationId],
	)

	const value = useMemo<InventoryContextValue>(
		() => ({
			status,
			organizationId,
			client,
			access,
			locationId,
			setLocationId,
			can: (grant) => access?.grants.includes(grant) ?? false,
			reload: () => setAttempt((count) => count + 1),
		}),
		[status, organizationId, client, access, locationId, setLocationId],
	)
	return (
		<InventoryContext.Provider value={value}>
			{children}
		</InventoryContext.Provider>
	)
}

export function useInventory(): InventoryContextValue {
	const value = useContext(InventoryContext)
	if (!value)
		throw new Error('useInventory must be used inside InventoryProvider')
	return value
}
