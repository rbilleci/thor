## Assignment terms

An `ASSIGNMENT` authorizes one Slice Owner to change one active slice in the existing shared checkout. Its Markdown message contains each field exactly once:

```markdown
Slice: <new slice identifier>
Outcome: <complete observable outcome>
Scope: <included work and affected behavior>
Exclusion: <excluded work and behavior, or None>
Constraint: <binding limits, or None>
Acceptance: <observable pass-or-fail conditions>
Limit: <positive maximum number of review-and-repair rounds>
Dependency: <required preconditions, people, systems, or access, or None>
Base: <full object ID of an existing Git commit>
Branch: <checked-out, non-detached branch name>
Checkout: <absolute path of the existing shared Git checkout>
```

Use `None` only when a field permits it. Do not omit a field or restate the Slice Owner protocol.
