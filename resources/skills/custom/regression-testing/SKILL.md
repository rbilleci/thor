# Regression Testing

Reproduce the failure or missing behavior before fixing it. Add a focused regression test that fails
for the original cause, then run the affected suite and relevant broader checks. Avoid tests that
only restate implementation details or pass without exercising the changed behavior.
