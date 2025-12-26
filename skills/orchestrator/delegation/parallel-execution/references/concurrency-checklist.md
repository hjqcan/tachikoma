# Concurrency Checklist

## Before parallelizing
- Verify no shared file writes.
- Identify shared services or migrations.
- Confirm tests can run independently.

## Conflict avoidance
- Assign ownership per file or directory.
- Serialize tasks touching the same module.
- Re-run integration checks after fan-in.

## Fan-in validation
- Merge outputs.
- Check for conflicting edits.
- Run the smallest relevant test suite.
