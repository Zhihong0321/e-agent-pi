import { z } from 'zod';

const authorization = { admin_capability: z.string().describe('Current host-provided admin authorization from this turn') };
const profile = {
  username: z.string().optional(), display_name: z.string().optional(), password: z.string().optional(), role: z.enum(['admin', 'user']).optional(), tier: z.string().optional(),
  name: z.string().optional(), position: z.string().optional(), department: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), location: z.string().optional(), notes: z.string().optional(),
  login_enabled: z.boolean().optional(), active: z.boolean().optional(), user: z.string().optional(), user_id: z.string().optional(), person_id: z.string().uuid().optional(), member_id: z.string().uuid().optional(), id: z.string().uuid().optional(),
};
const spec = (input, description) => ({
  agents: ['di-onboarding', 'di-db'],
  description: description || 'Manage login accounts. Requires current admin login and host-provided admin_capability. Never expose passwords or authorization in replies. Tier is metadata for future access planning. Disable accounts using active=false.',
  input,
  run: () => { throw new Error('User administration must run through the authenticated host'); },
});
export const USER_TOOLS = {
  list_users: spec(authorization),
  create_user: spec({ ...authorization, ...profile, username: z.string(), password: z.string() }),
  update_user: spec({ ...authorization, ...profile, user: z.string().describe('User id or current username'), active: z.boolean().optional() }),
  list_people: spec({ ...authorization }, 'List internal company people, including profile/contact details and redacted login status. Customer contacts are separate. Requires current admin login.'),
  create_person: spec({ ...authorization, ...profile, name: z.string().optional() }, 'Create one internal company person. Login access is optional; enabling it requires username and password. Never expose passwords or authorization.'),
  update_person: spec({ ...authorization, ...profile, person_id: z.string().uuid().optional(), member_id: z.string().uuid().optional(), id: z.string().uuid().optional() }, 'Update one internal company person or their optional login. Never expose passwords or authorization.'),
};
