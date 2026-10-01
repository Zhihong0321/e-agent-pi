import { z } from 'zod';

const authorization = { admin_capability: z.string().describe('Current host-provided admin authorization from this turn') };
const profile = { username: z.string().optional(), display_name: z.string().optional(), password: z.string().optional(), role: z.enum(['admin', 'user']).optional(), tier: z.string().optional() };
const spec = input => ({
  agents: ['di-onboarding', 'di-db'],
  description: 'Manage login accounts. Requires current admin login and host-provided admin_capability. Never expose passwords or authorization in replies. Tier is metadata for future access planning. Disable accounts using active=false.',
  input,
  run: () => { throw new Error('User administration must run through the authenticated host'); },
});
export const USER_TOOLS = {
  list_users: spec(authorization),
  create_user: spec({ ...authorization, ...profile, username: z.string(), password: z.string() }),
  update_user: spec({ ...authorization, ...profile, user: z.string().describe('User id or current username'), active: z.boolean().optional() }),
};
