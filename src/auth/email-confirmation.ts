import React from 'react';
import { render } from '@react-email/render';
import type { APIContext } from 'astro';
import { sendAuthEmail } from './email.ts';

interface EmailConfirmationInput {
	email: string;
	displayName?: string | null;
	confirmationUrl: string;
	expiresInSeconds: number;
}

const colors = {
	page: '#f6f7f2',
	ink: '#17211b',
	muted: '#526052',
	border: '#d9ded4',
	card: '#ffffff',
	green: '#2f6f4e',
	gold: '#d9a441',
};

function expiryLabel(seconds: number) {
	const minutes = Math.max(1, Math.round(seconds / 60));
	return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function EmailConfirmation({ displayName, confirmationUrl, expiresInSeconds }: {
	displayName: string;
	confirmationUrl: string;
	expiresInSeconds: number;
}) {
	return React.createElement('html', { lang: 'en' },
		React.createElement('body', {
			style: {
				margin: 0,
				backgroundColor: colors.page,
				color: colors.ink,
				fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
			},
		},
		React.createElement('div', { style: { padding: '32px 18px' } },
			React.createElement('div', {
				style: {
					maxWidth: 560,
					margin: '0 auto',
					backgroundColor: colors.card,
					border: `1px solid ${colors.border}`,
					borderRadius: 8,
					overflow: 'hidden',
					boxShadow: '0 18px 40px rgba(19, 31, 22, 0.08)',
				},
			},
			React.createElement('div', {
				style: {
					padding: '28px 32px 22px',
					backgroundColor: '#edf2e9',
					borderBottom: `1px solid ${colors.border}`,
				},
			},
			React.createElement('div', {
				style: {
					display: 'inline-block',
					padding: '5px 9px',
					borderRadius: 999,
					backgroundColor: '#fff7df',
					color: '#6e4c0d',
					fontSize: 12,
					fontWeight: 700,
					letterSpacing: 0,
					marginBottom: 16,
				},
			}, 'Confirm your email'),
			React.createElement('h1', {
				style: {
					margin: 0,
					fontSize: 28,
					lineHeight: '34px',
					fontWeight: 800,
					letterSpacing: 0,
				},
			}, `Finish creating your Treeseed Market account, ${displayName}.`),
			React.createElement('p', {
				style: {
					margin: '12px 0 0',
					color: colors.muted,
					fontSize: 15,
					lineHeight: '23px',
				},
			}, `This link expires in ${expiryLabel(expiresInSeconds)}.`)),
			React.createElement('div', { style: { padding: '28px 32px 32px' } },
				React.createElement('p', {
					style: {
						margin: '0 0 18px',
						color: colors.muted,
						fontSize: 15,
						lineHeight: '24px',
					},
				}, 'Confirm this email address to activate your account and continue to Treeseed Market.'),
				React.createElement('a', {
					href: confirmationUrl,
					style: {
						display: 'inline-block',
						backgroundColor: colors.green,
						color: '#ffffff',
						textDecoration: 'none',
						borderRadius: 6,
						padding: '12px 18px',
						fontWeight: 800,
						fontSize: 14,
					},
				}, 'Confirm email'),
				React.createElement('div', {
					style: {
						marginTop: 24,
						paddingTop: 20,
						borderTop: `1px solid ${colors.border}`,
					},
				},
				React.createElement('p', {
					style: {
						margin: 0,
						color: colors.muted,
						fontSize: 13,
						lineHeight: '20px',
					},
				}, 'If the button does not work, open this link in your browser:'),
				React.createElement('p', {
					style: {
						margin: '6px 0 0',
						color: colors.green,
						fontSize: 13,
						lineHeight: '20px',
						wordBreak: 'break-all',
					},
				}, confirmationUrl)),
				React.createElement('p', {
					style: {
						margin: '24px 0 0',
						color: colors.muted,
						fontSize: 12,
						lineHeight: '18px',
					},
				}, 'You are receiving this because this email address was used to create a Treeseed Market account.'))))));
}

function firstName(value: string) {
	return value.trim().split(/\s+/u)[0] || value;
}

export async function sendEmailConfirmation(
	context: Pick<APIContext, 'locals' | 'url'> | undefined,
	input: EmailConfirmationInput,
) {
	const email = input.email.trim();
	if (!email) return;
	const displayName = firstName(input.displayName?.trim() || email.split('@')[0] || 'there');
	const element = React.createElement(EmailConfirmation, {
		displayName,
		confirmationUrl: input.confirmationUrl,
		expiresInSeconds: input.expiresInSeconds,
	});
	const [html, text] = await Promise.all([
		render(element),
		render(element, { plainText: true }),
	]);
	await sendAuthEmail(context, {
		to: email,
		subject: 'Confirm your Treeseed Market email',
		text,
		html,
	});
}
