---
name: status
description: |
  Show wicked-bus health, statistics, and diagnostics. Event counts,
  subscriber lag, provider list, database size, and configuration.

  Use when: "bus status", "is the bus healthy", "how many events",
  "show bus stats", or when diagnosing delivery issues.
---

# wicked-bus status

Show the current state of the wicked-bus.

## When to use

- User asks about bus health or status
- Before debugging delivery issues
- Checking if the bus is initialized and has data
- Monitoring subscriber lag

## Process

### Step 1: Check if bus is initialized

```bash
npx wicked-bus status 2>/dev/null
```

If this fails, the bus isn't initialized. Suggest running `wicked-bus/init`.

### Step 2: Parse and display status

The `status` command returns JSON. Display it in a readable format:

```markdown
## wicked-bus Status

**Database**: {db_path}
**Events**: {total_events} total, {active_events} active (not expired)
**Providers**: {provider_count} registered
**Subscribers**: {subscriber_count} active

### Subscriber Lag
| Plugin | Filter | Cursor | Latest | Lag |
|--------|--------|--------|--------|-----|
| {plugin} | {filter} | {last_event_id} | {max_event_id} | {lag} |
```

### Step 3: Extended diagnostics (if requested)

If the user wants deeper diagnostics, query SQLite directly:

**Event distribution by type:**
```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT event_type, COUNT(*) as count FROM events GROUP BY event_type ORDER BY count DESC LIMIT 20;"
```

**Event distribution by domain:**
```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT domain, COUNT(*) as count FROM events GROUP BY domain ORDER BY count DESC;"
```

**Database size:**
```bash
ls -lh ~/.something-wicked/wicked-bus/bus.db
```

**WAL size (if checkpointing is lagging):**
```bash
ls -lh ~/.something-wicked/wicked-bus/bus.db-wal 2>/dev/null
```

**Events per hour (last 24h):**
```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT strftime('%Y-%m-%d %H:00', emitted_at/1000, 'unixepoch') as hour, COUNT(*) as count FROM events WHERE emitted_at > (strftime('%s','now')-86400)*1000 GROUP BY hour ORDER BY hour;"
```

**Oldest and newest events:**
```bash
sqlite3 ~/.something-wicked/wicked-bus/bus.db \
  "SELECT 'oldest' as which, event_id, event_type, datetime(emitted_at/1000, 'unixepoch') as time FROM events ORDER BY event_id ASC LIMIT 1 UNION ALL SELECT 'newest', event_id, event_type, datetime(emitted_at/1000, 'unixepoch') FROM events ORDER BY event_id DESC LIMIT 1;"
```

**Deregistered subscriptions:**
```bash
npx wicked-bus list --include-deregistered --json
```

**Configuration:**
```bash
cat ~/.something-wicked/wicked-bus/config.json
```

If `WICKED_BUS_DATA_DIR` is set, use that path instead of the default.

### Step 4: Health warnings

Flag these issues if detected:

- **High lag** (cursor > 100 events behind): subscriber may be failing to poll
- **No recent events** (nothing in last 24h): producers may have stopped
- **Large WAL file** (> 10 MB): checkpointing may be blocked
- **Deregistered subscribers with active cursors**: orphaned cursors consuming space
- **Events near dedup_expires_at**: about to be swept — subscribers should poll soon
