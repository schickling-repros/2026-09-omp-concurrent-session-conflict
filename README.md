# oh-my-pi: concurrent session writers lose later turns after a rewrite conflict

Two independent `SessionManager` processes can resume the same JSONL transcript. If B appends while A is open, A's hot-path append succeeds without noticing B's bytes, but A's next rewrite rejects the stale expected size. A's subsequent in-memory turns keep failing to persist. No model calls or credentials are needed.

## Reproduction

Requires Bun 1.4.x and git. From this directory:

```bash
git clone --depth 1 --branch v18.3.4 https://github.com/can1357/oh-my-pi.git upstream
(cd upstream && bun install --frozen-lockfile)
bun run repro.ts
```

The script creates a temporary HOME and XDG directories, uses the upstream `SessionManager` directly, coordinates two **separate processes** deterministically via marker files, and removes its temporary session afterward. No real user session or provider is accessed. It checks that B's turn and A's pre-conflict hot-path turn reach disk, A's rewrite reports `SessionWriteConflictError`, and two later turns in A's memory never reach disk.

## Expected

A second writable resume should fail clearly while A holds the session, or A should reload/merge/fork safely after a conflict; it must not continue accepting turns that cannot be saved.

## Actual

```text
"afterB": ["B durable turn"]
"onDisk": ["B durable turn", "A hot-path turn before conflict"]
"conflict": "SessionWriteConflictError: Session file changed before rewrite: ... (expected 597 bytes, found 766 bytes)."
"inMemory": 3
BUG REPRODUCED: both later in-memory turns are missing from disk
```

`flush()` also throws the same conflict. The persistence error observer fires once; later `appendMessage()` calls return normally and only the in-memory transcript grows.

## Versions

- oh-my-pi: v18.3.4, commit `dff728c572a8c4c29016549b6e407c4550fcdac6`
- Bun: 1.4.2
- OS: Linux x86_64

## Related Issue

https://github.com/can1357/oh-my-pi/issues/13596
