---
name: emit
description: Emit events to the wicked-bus. Use when publishing events from a plugin, logging activity to the bus, or integrating a new system with the event bridge. Covers both programmatic (Node.js) and CLI usage.
---

# wicked-bus emit

Guide for publishing events to the wicked-bus.

## When to use

- User wants to emit an event from their code
- User asks "how do I publish to the bus"
- Integrating a plugin with wicked-bus for the first time
- User wants to fire-and-forget an event

## Prerequisites

Check that wicked-bus is initialized. If not, trigger `wicked-bus-init`.

```bash
npx wicked-bus status 2>/dev/null
```

## Programmatic Usage (Node.js)

### Basic emit

```javascript
import { emit } from 'wicked-bus';
import { loadConfig } from 'wicked-bus/lib/config.js';
import { openDb } from 'wicked-bus/lib/db.js';

const config = loadConfig();
const db = openDb(config);

const result = emit(db, config, {
  event_type: 'wicked.myplugin.task.completed',
  domain: 'my-plugin',
  subdomain: 'workflow.task',
  payload: { taskId: 'abc-123', status: 'done' },
});

console.log(result);
// { event_id: 42, idempotency_key: '550e8400-...' }

db.close();
```

### Fire-and-forget pattern (recommended for integrations)

Plugins should never block on the bus. Use this pattern:

```javascript
let _busEmit = null;
let _busChecked = false;

async function emitToBus(event) {
  if (!_busChecked) {
    _busChecked = true;
    try {
      const mod = await import('wicked-bus');
      const { loadConfig } = await import('wicked-bus/lib/config.js');
      const { openDb } = await import('wicked-bus/lib/db.js');
      const config = loadConfig();
      const db = openDb(config);
      _busEmit = (evt) => mod.emit(db, config, evt);
    } catch (_) {
      _busEmit = null; // Bus not installed — degrade gracefully
    }
  }
  if (!_busEmit) return null;
  try {
    return _busEmit(event);
  } catch (_) {
    return null; // Never throw from fire-and-forget
  }
}
```

### With custom TTL

```javascript
emit(db, config, {
  event_type: 'wicked.myplugin.cache.invalidated',
  domain: 'my-plugin',
  payload: { keys: ['user:123'] },
  ttl_hours: 4, // Override default 72h TTL
});
```

### With explicit idempotency key

```javascript
emit(db, config, {
  event_type: 'wicked.myplugin.job.completed',
  domain: 'my-plugin',
  subdomain: 'jobs.batch',
  payload: { jobId: 'job-42' },
  idempotency_key: 'job-42-completed', // Prevents duplicate events
});
```

## CLI Usage

### Basic emit

```bash
npx wicked-bus emit \
  --type wicked.myplugin.task.completed \
  --domain my-plugin \
  --subdomain workflow.task \
  --payload '{"taskId": "abc-123", "status": "done"}'
```

### Payload from file

```bash
npx wicked-bus emit \
  --type wicked.myplugin.report.generated \
  --domain my-plugin \
  --payload @./report-data.json
```

### With metadata

```bash
npx wicked-bus emit \
  --type wicked.mydeploy.deploy.completed \
  --domain my-deploy \
  --subdomain deploy.production \
  --payload '{"version": "2.0.0"}' \
  --metadata '{"host": "prod-01"}'
```

## Error Handling

| Error | Code | Meaning |
|-------|------|---------|
| WB-001 | INVALID_EVENT_SCHEMA | Event failed validation (bad type, missing fields, payload too large) |
| WB-002 | DUPLICATE_EVENT | Idempotency key already exists |
| WB-004 | DISK_FULL | SQLite database disk is full |
| WB-005 | SCHEMA_VERSION_UNSUPPORTED | schema_version > 1.x |

## Event Naming

For help choosing event_type, domain, and subdomain values, use the
`wicked-bus-naming` skill.
