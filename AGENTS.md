# Repository Conventions

- Keep source changes focused on the requested behavior; match existing TypeScript style.
- Write tests before code. For any new feature or behavior change, first add test cases that pin the boundaries (inputs, edge cases, expected outputs), then implement until they pass.
- When changing code, update the affected test boundaries in the same change. A test that asserts intentionally-changed behavior must be revised deliberately, not deleted or weakened to make the suite green.
- Run `npm run check` and relevant tests after changing source code.
- Do not commit or delete user data unless explicitly requested.
