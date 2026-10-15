Users
=====

One user schema for the whole system (`server/user-schema.mjs`). A person is one
row in `users`, with one id that every page, tool and agent uses. There is no
second people table; Document Intelligence reads `users` too.

```
user_category                      one company's categories
  id, company_tenant_id
  name          e.g. Superadmin, Department head, Sales, Staff
  access        superadmin | department_head | user   ← what code enforces
  limits        jsonb, e.g. {"max_discount_pct": 8}  ← the owner's business limits
  is_default    the category new users get (one per company)

users                              one row per person
  id, company_tenant_id
  category_id   → user_category    what the user may do
  display_name
  username, password_hash          both set = can sign in
  active                           false = disabled
  email, phone, position, location, notes
  department                       where the user works (a department head's scope)
```

- **Category = what you may do. Department = where.** "Head of IT" is category
  Department head + department IT. One category serves every department.
- **Access levels** are the only thing code checks (`server/roles.mjs`):
  `superadmin` owns the company and manages users and categories;
  `department_head` acts for their own department (and needs one);
  `user` acts for themselves.
- **Limits** are data the Superadmin changes in chat or on the Users page. The
  signed-in line every agent sees names the user's category and its limits.
- **Every company starts with** Superadmin, Department head and Staff (the
  default). The Superadmin renames, adds, changes or deletes them. A category in
  use, or the default one, cannot be deleted.
- **Sign-in** is company code + username + password, the same for everyone
  (`server/users.mjs`). A user without a username and password is on record
  (e.g. for expense claims) but cannot sign in. Changing a password, username,
  category or active status signs that user out.
- **Every company keeps one active Superadmin who can sign in**; a change that
  would remove the last one is refused.

Managing users
--------------

One service (`server/user-service.mjs`) used by the agent tools, the `/demo`
Users page and the Document Intelligence host. Writes need a signed-in
Superadmin; the host passes the actor, tool arguments never choose it.

Agent tools: `list_users`, `create_user`, `update_user`, `list_user_categories`,
`save_user_category`, `delete_user_category`. Ask the AI, for example:

- "Make Gan Zhi Hong a department head of IT."
- "Create a Sales category with max_discount_pct 8 and move tester01 into it."
- "Set the Department head category's max_discount_pct to 11."
- "Disable alice."

Agents read users through row-level security: only their own company, never
password hashes (`document_inteligence/sql/014_one_user_table.sql`).

Validation: `node --test server/users.test.mjs server/execution/user-service.test.mjs` and `npm run build`.
