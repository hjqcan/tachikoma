# Checkpoint Schema

## Minimal checkpoint example
```json
{
  "checkpointId": "cp-2024-12-26-001",
  "createdAt": "2024-12-26T12:00:00Z",
  "planId": "plan-01",
  "tasks": [
    {"id": "1", "status": "done"},
    {"id": "2", "status": "in_progress"}
  ],
  "artifacts": [
    {"path": "packages/core/src/index.ts", "hash": "sha256:..."}
  ],
  "notes": ["checkpoint before integration"]
}
```

## Required fields
- checkpointId
- createdAt
- planId
- tasks
