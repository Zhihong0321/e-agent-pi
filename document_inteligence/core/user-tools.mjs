import { z } from 'zod';

// User tools. Users live in the host's one user table (server/user-schema.mjs); the host runs these
// tools itself (server/user-service.mjs) with the signed-in user as the actor, so these specs only
// name the tools and their inputs. Writes are Superadmin-only.
const fields = {
  position: z.string().optional(), department: z.string().optional().describe('Where the user works; a department head heads this department'),
  email: z.string().optional(), phone: z.string().optional(), location: z.string().optional(), notes: z.string().optional(),
  category: z.string().optional().describe('Category name or id from list_user_categories; it sets what the user may do'),
  username: z.string().optional().describe('Sign-in username; with a password the user can sign in'),
  password: z.string().optional().describe('Never repeat it back'),
  active: z.boolean().optional().describe('false disables the user'),
};
const hostOnly = () => { throw new Error('User tools run in the host'); };
const spec = (agents, description, input) => ({ agents, description, input, run: hostOnly });

/** @param {{ readers: string[], writers: string[] }} agents */
export function userTools({ readers, writers }) {
  return {
    list_users: spec(readers, "List the company's users (one record per person) with category, access level, department, contact details and whether they can sign in. These are the company's own people, not customer contacts.", {}),
    create_user: spec(writers, 'Superadmin only: add a user. A name is required; username + password let them sign in. Never invent credentials.', { name: z.string(), ...fields }),
    update_user: spec(writers, 'Superadmin only: change one user by id from list_users; only the given fields change.', { id: z.string(), name: z.string().optional(), ...fields }),
    list_user_categories: spec(writers, "List the company's user categories: name, access level, limits (e.g. max_discount_pct) and how many users each holds.", {}),
    save_user_category: spec(writers, 'Superadmin only: create a category, or change one by id (name, access, limits, is_default).', {
      id: z.string().optional(), name: z.string().optional(), access: z.enum(['superadmin', 'department_head', 'user']).optional(),
      limits: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])).optional(), is_default: z.boolean().optional(),
    }),
    delete_user_category: spec(writers, 'Superadmin only: delete an empty, non-default category by id.', { id: z.string() }),
  };
}
