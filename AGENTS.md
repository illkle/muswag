### Running tests

Run tests from the package that owns the changed code.

Desktop app/player changes:
`turbo run @muswag/desktop#test`

Shared sync/API tests:
`turbo run @muswag/tests#test`
`turbo run @muswag/tests#test:integration`
`turbo run @muswag/tests#test:sync-benchmark` (run only when optimizing sync or adding new tables)
