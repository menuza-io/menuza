import {
	fetchMenuPhotos,
	menuPhotosPath,
	type MenuPhotosAuthedGet,
} from '../menu-photos'

jest.mock('../index', () => ({ jwtAuthApi: { authenticatedGet: jest.fn() } }))

describe('menuPhotosPath', () => {
	it('encodes the organization, query and limit', () => {
		expect(
			menuPhotosPath({
				organizationId: 'org 1',
				query: ' pasta & co ',
				limit: 20,
			}),
		).toBe('/api/menu/photos?organizationId=org+1&query=pasta+%26+co&limit=20')
	})

	it('leaves out an empty query', () => {
		expect(menuPhotosPath({ organizationId: 'o', query: '  ' })).toBe(
			'/api/menu/photos?organizationId=o',
		)
	})
})

describe('fetchMenuPhotos', () => {
	it('returns the dishes and the missing count', async () => {
		const authenticatedGet = jest.fn(async () => ({
			success: true,
			status: 200,
			data: {
				organizationId: 'o',
				missingCount: 14,
				items: [
					{
						id: 'd1',
						name: 'Pasta',
						categoryName: null,
						hasPhoto: false,
						imageUrl: null,
					},
				],
			},
		}))
		const result = await fetchMenuPhotos(
			{ organizationId: 'o' },
			{
				authenticatedGet:
					authenticatedGet as MenuPhotosAuthedGet['authenticatedGet'],
			},
		)
		expect(authenticatedGet).toHaveBeenCalledWith(
			'/api/menu/photos?organizationId=o',
		)
		expect(result).toMatchObject({
			ok: true,
			data: { missingCount: 14, items: [{ id: 'd1' }] },
		})
	})

	it('passes a 403 through with its code so the screen can explain it', async () => {
		const result = await fetchMenuPhotos(
			{ organizationId: 'o' },
			{
				authenticatedGet: async () => ({
					success: false,
					status: 403,
					error: 'forbidden',
					message: 'No permission',
				}),
			},
		)
		expect(result).toEqual({
			ok: false,
			code: 'forbidden',
			status: 403,
			message: 'No permission',
		})
	})

	it('reports a lost connection as a failure', async () => {
		const result = await fetchMenuPhotos(
			{ organizationId: 'o' },
			{
				authenticatedGet: async () => ({
					success: false,
					status: 0,
					error: 'network_error',
				}),
			},
		)
		expect(result).toMatchObject({
			ok: false,
			code: 'network_error',
			status: 0,
		})
	})
})
