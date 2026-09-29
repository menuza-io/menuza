import hotkeys from 'hotkeys-js'
import { useEffect } from 'react'
import { useNavigate, useRouteLoaderData } from 'react-router'
import { type loader as rootLoader } from '#app/root.tsx'

interface HotkeyConfig {
	key: string
	action: () => void
	description?: string
}

export function useHotkeys(configs: HotkeyConfig[]) {
	useEffect(() => {
		// Register all hotkeys
		configs.forEach(({ key, action }) => {
			hotkeys(key, (event) => {
				event.preventDefault()
				action()
			})
		})

		// Cleanup on unmount
		return () => {
			configs.forEach(({ key }) => {
				hotkeys.unbind(key)
			})
		}
	}, [configs])
}

export function useGlobalHotkeys(setCommandOpen: (open: boolean) => void) {
	const navigate = useNavigate()
	const rootData = useRouteLoaderData<typeof rootLoader>('root')
	const orgSlug =
		rootData?.userOrganizations?.currentOrganization?.organization.slug

	const configs: HotkeyConfig[] = [
		{
			key: 'f',
			action: () => setCommandOpen(true),
			description: 'Open command menu',
		},
		{
			key: 'p',
			action: () => void navigate('/profile'),
			description: 'Go to account settings',
		},
		{
			key: 'b',
			action: () => {
				if (orgSlug) {
					void navigate(`/${orgSlug}/settings/billing`)
				}
			},
			description: 'Go to billing',
		},
		{
			key: 's',
			action: () => {
				if (orgSlug) {
					void navigate(`/${orgSlug}/settings`)
				}
			},
			description: 'Go to settings',
		},
	]

	useHotkeys(configs)
}
