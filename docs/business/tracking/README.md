# Launch working records

These repository files are the shared working memory for the launch. Read them at the start of a resumed task and before assigning work. The launch objective and `../launch-acceptance.md` remain the acceptance authority.

- `status.md`: current work, owners, dependencies and verified evidence.
- `backlog.md`: concrete unfinished work and deliberately deferred features.
- `decisions.md`: user decisions and constraints; proposals are not approvals.
- `scratchpad.md`: observations, hypotheses and next checks. Promote actionable findings into the backlog.

Update these files when work is assigned, evidence changes, a new issue is found, or a handoff occurs. Use stable IDs. Mark completion only with an exact commit, test result, deployment or browser/API proof. Keep local fixtures distinct from real services. Recheck remote and process state instead of trusting historical entries. Never store credentials, raw tokens or private session dumps here. Avoid duplicate tasks: link existing IDs. Each implementation agent should return suggested tracker updates with its handoff; the coordinator integrates them to avoid conflicting edits.
