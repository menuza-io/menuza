import { type StaffCreateInput, type StaffPositionCreate } from './staff-api.ts'

/**
 * Demo roster for local development and the e2e seed: a dozen made-up people
 * and the positions they work. Every phone number is in a reserved fictional
 * range and every email is on `example.com`. Used only by the seed script;
 * production code never imports this file.
 */

export type DemoPosition = Omit<StaffPositionCreate, 'currency'> & {
	/** Hourly rate in minor units (cents). */
	defaultRateMinor: number
}

export const DEMO_POSITIONS: readonly DemoPosition[] = [
	{
		name: 'Associate',
		nameAr: 'موظف',
		area: 'Customer-facing',
		colorKey: 'blue',
		tipEligible: true,
		defaultRateMinor: 1500,
	},
	{
		name: 'Greeter',
		nameAr: 'مرحب',
		area: 'Customer-facing',
		colorKey: 'teal',
		tipEligible: true,
		defaultRateMinor: 1600,
	},
	{
		name: 'Specialist',
		nameAr: 'أخصائي',
		area: 'Customer-facing',
		colorKey: 'amber',
		tipEligible: true,
		defaultRateMinor: 1700,
	},
	{
		name: 'Technician',
		nameAr: 'فني',
		area: 'Operations',
		colorKey: 'orange',
		tipEligible: false,
		defaultRateMinor: 2000,
	},
	{
		name: 'Assistant',
		nameAr: 'مساعد',
		area: 'Operations',
		colorKey: 'neutral',
		tipEligible: false,
		defaultRateMinor: 1450,
	},
	{
		name: 'Team lead',
		nameAr: 'قائد فريق',
		area: 'Management',
		colorKey: 'violet',
		tipEligible: false,
		defaultRateMinor: 2600,
	},
]

export type DemoStaff = Pick<
	StaffCreateInput,
	'firstName' | 'lastName' | 'firstNameAr' | 'lastNameAr' | 'email' | 'phone'
> & {
	/** Names from `DEMO_POSITIONS`; the first is the main position. */
	positions: readonly string[]
	/** Hourly rate override in minor units; omitted means the position default. */
	rateMinor?: number
}

export const DEMO_STAFF: readonly DemoStaff[] = [
	{
		firstName: 'Maya',
		lastName: 'Okafor',
		email: 'maya.okafor@example.com',
		phone: '+14155550101',
		positions: ['Team lead', 'Associate'],
		rateMinor: 2800,
	},
	{
		firstName: 'Luis',
		lastName: 'Herrera',
		email: 'luis.herrera@example.com',
		phone: '+14155550102',
		positions: ['Technician'],
		rateMinor: 2150,
	},
	{
		firstName: 'Noor',
		lastName: 'Alharbi',
		firstNameAr: 'نور',
		lastNameAr: 'الحربي',
		email: 'noor.alharbi@example.com',
		phone: '+14155550103',
		positions: ['Associate'],
	},
	{
		firstName: 'Tomas',
		lastName: 'Lindqvist',
		phone: '+14155550104',
		positions: ['Assistant'],
	},
	{
		firstName: 'Priya',
		lastName: 'Nair',
		email: 'priya.nair@example.com',
		phone: '+14155550105',
		positions: ['Specialist', 'Greeter'],
		rateMinor: 1750,
	},
	{
		firstName: 'Omar',
		lastName: 'Haddad',
		firstNameAr: 'عمر',
		lastNameAr: 'حداد',
		phone: '+14155550106',
		positions: ['Technician', 'Assistant'],
	},
	{
		firstName: 'Chloe',
		lastName: 'Bennett',
		email: 'chloe.bennett@example.com',
		positions: ['Greeter'],
	},
	{
		firstName: 'Kenji',
		lastName: 'Watanabe',
		phone: '+14155550108',
		positions: ['Associate'],
		rateMinor: 1550,
	},
	{
		firstName: 'Amara',
		lastName: 'Diallo',
		email: 'amara.diallo@example.com',
		phone: '+14155550109',
		positions: ['Specialist'],
	},
	{
		firstName: 'Jonas',
		lastName: 'Keller',
		phone: '+14155550110',
		positions: ['Technician'],
	},
	{
		firstName: 'Sofia',
		lastName: 'Marino',
		email: 'sofia.marino@example.com',
		positions: ['Associate', 'Greeter'],
	},
	{
		firstName: 'Rashid',
		lastName: 'Qureshi',
		phone: '+14155550112',
		positions: ['Assistant'],
	},
]
