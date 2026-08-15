## Assignment terms

An `ASSIGNMENT` authorizes one Slice Owner to change one active slice in the existing shared checkout. It contains each of these labeled fields exactly once:

```markdown
Slice: <new slice identifier>
Outcome: <complete observable outcome>
Scope: <included work and affected behavior>
Non-goals: <excluded work and behavior, or None>
Constraints: <binding limits, or None>
Acceptance criteria: <observable pass-or-fail conditions>
Decision authority: <delegated Dispatcher decisions and external authority>
Dependencies: <required preconditions, people, systems, or access, or None>
Base: <full object ID of an existing Git commit>
Branch: <checked-out, non-detached branch name>
Checkout: <absolute path of the existing shared Git checkout>
```

`Outcome`, `Scope`, `Non-goals`, `Constraints`, and `Acceptance criteria` form the requirements baseline. The outcome states the complete observable result. Scope states included work and affected behavior. Non-goals state excluded work and behavior. Constraints state binding limits. Acceptance criteria state the observable pass-or-fail conditions that establish the outcome.

`Decision authority` states decisions delegated to the Work Dispatcher and the external authority for every other baseline or contract change. `Dependencies` states each required precondition, person, system, or access. `Base`, `Branch`, and `Checkout` identify the unchanged checkout that the Slice Owner must admit. `Slice` identifies the assignment in every `UPDATE` and `TERMINAL` until the dispatcher accepts the terminal result or completes confirmed owner-loss handling. Use `None` only when a field has no applicable value; omit no field.

An `ASSIGNMENT` contains slice-specific facts. It does not restate the general Slice Owner protocol.
