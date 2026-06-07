export interface PasswordRuleResult {
	id: string;
	label: string;
	met: boolean;
}

export interface PasswordStrengthResult {
	score: number;
	label: string;
	rules: PasswordRuleResult[];
}

const PASSWORD_MIN_LENGTH = 12;

export const PASSWORD_RULE_DEFINITIONS = [
	{
		id: 'length',
		label: `At least ${PASSWORD_MIN_LENGTH} characters`,
		test: (value: string) => value.length >= PASSWORD_MIN_LENGTH,
	},
	{
		id: 'lowercase',
		label: 'One lowercase letter',
		test: (value: string) => /[a-z]/.test(value),
	},
	{
		id: 'uppercase',
		label: 'One uppercase letter',
		test: (value: string) => /[A-Z]/.test(value),
	},
	{
		id: 'number',
		label: 'One number',
		test: (value: string) => /\d/.test(value),
	},
	{
		id: 'symbol',
		label: 'One symbol',
		test: (value: string) => /[^A-Za-z0-9\s]/.test(value),
	},
	{
		id: 'spaces',
		label: 'No spaces',
		test: (value: string) => value.length > 0 && !/\s/.test(value),
	},
] as const;

export function evaluatePasswordStrength(password: string): PasswordStrengthResult {
	const rules = PASSWORD_RULE_DEFINITIONS.map((rule) => ({
		id: rule.id,
		label: rule.label,
		met: rule.test(password),
	}));
	const score = rules.filter((rule) => rule.met).length;
	const label = score === rules.length
		? 'Strong'
		: score >= 4
			? 'Almost there'
			: score >= 2
				? 'Weak'
				: 'Too weak';
	return { score, label, rules };
}

export function passwordMeetsPolicy(password: string) {
	return evaluatePasswordStrength(password).rules.every((rule) => rule.met);
}

export function passwordPolicyMessage() {
	return `Password must be at least ${PASSWORD_MIN_LENGTH} characters and include uppercase, lowercase, number, symbol, and no spaces.`;
}
