# Checkpoints

Checkpoints keep a shadow history of the files an agent changes, so a client can let it edit the project live and then keep or revert its changes file by file. Edits apply to the real project as usual: the viewport and asset editors show them as they happen.

The history is a git repository at `<project>/Saved/UE_MCP_Bridge/shadow.git`, separate from any source control the project uses. The server drives it with isomorphic-git, so no git binary is needed, and it never reads or writes the project's own `.git`, hooks or LFS config. It works on projects under Perforce, Plastic or no source control at all.

## Turning them on

Checkpoints are off unless enabled:

```yaml
ue-mcp:
  checkpoints: on
```

The object form also sets the size above which a file is kept as a plain copy beside the repository instead of a git blob (default 1 GB):

```yaml
ue-mcp:
  checkpoints:
    enabled: on
    largeFileBytes: 1073741824
```

A client can override the setting for one editor session through the daemon (`PUT /v1/checkpoints/enabled`). The override lives in the daemon until it exits and is never written to a file.

While off, no shadow repository is created and the bridge does not intercept saves. Turning them off keeps the history; `editor(clear_checkpoints)` deletes it.

## What gets recorded

Recording is lazy. Nothing is copied for paths the agent never touches, so the first checkpoint on a large project costs the same as any other.

- **Package saves.** The bridge binds `UPackage::PreSavePackageWithContextEvent`. Before the first save of a package after a checkpoint, it copies the package's current bytes into a pending folder (`Saved/UE_MCP_Bridge/shadow-pending/`), or records that it did not exist. A handler that saves with a direct `UPackage::SavePackage`, which raises no such event, records the package's file itself before writing. Deletes are recorded from `FEditorDelegates::OnPackageDeleted`, and bridge renames record their source packages first.
- **Server writes.** `project(write_cpp_file)`, `write_source_file`, `add_module_dependency` and `add_cpp_member` record the file before writing it. `project(set_config)` records the ini file in the editor before writing it.
- **A checkpoint** folds the pending copies into the history and commits the current bytes of every path recorded so far. Git stores each version of a file once.

A write outside the bridge and outside package saves (an external editor, a build) is not recorded until the next checkpoint. `list_changes` marks such a path `untracked`, and `restore` refuses it unless the client passes `force`.

Changes still in memory at a checkpoint (an unsaved level edit, a dirty Blueprint) are not on disk, so the history does not have them. The checkpoint result lists `dirtyPackages`; save them first to record them. Wrap a turn in `editor(begin_transaction)` and `end_transaction` to cover the in-memory part, and cancel the transaction before restoring files when reverting a whole turn.

## Actions

| Action | What it does |
|---|---|
| `editor(checkpoint, label?)` | Record a checkpoint and return its id, the paths it recorded as changed, and the dirty packages. |
| `editor(list_checkpoints, limit?)` | Whether checkpoints are on and why, the repository path, and the checkpoints, newest first. |
| `editor(list_changes, from, to?)` | Every file changed between two checkpoints, or since `from` when `to` is omitted. Text files carry a unified diff, and modified Blueprints carry the structural diff `blueprint(diff)` gives, run against the checkpoint's copy. |
| `editor(restore, checkpoint, paths?, force?)` | Put every path, or only `paths`, back to the checkpoint. Restoring a subset is a cherry pick: the rest of the turn stays. |
| `editor(clear_checkpoints)` | Delete the history. |

A restore:

1. takes a checkpoint (`before`), so restoring to it undoes the restore;
2. closes asset editors on the restored packages and detaches their loaders;
3. writes the files, deleting those that did not exist at the checkpoint;
4. reloads restored packages, unloads deleted ones and drops them from the asset registry, reloads the `GConfig` branch of a restored `Config/Default*.ini`, and reopens the closed editors;
5. takes another checkpoint (`after`).

Restored source is bytes only; rebuilding is the client's call. A restore is refused during PIE. A path changed outside the agent since the checkpoint is refused as `edited-outside`, and a path nothing recorded by then as `not-recorded`.

## Daemon API

The same operations are on the daemon's HTTP API under `/v1/checkpoints`, and on `api.checkpoints` for daemon extensions (extension API 3, feature `checkpoints`). `/v1/health` lists `checkpoints` under `features`.

| Method | Path | Body or query |
|---|---|---|
| GET | `/v1/checkpoints` | `?editor&limit` |
| PUT | `/v1/checkpoints/enabled` | `{ editor?, enabled: true \| false \| null }` |
| POST | `/v1/checkpoints` | `{ editor?, label? }` |
| GET | `/v1/checkpoints/changes` | `?editor&from&to` |
| POST | `/v1/checkpoints/restore` | `{ editor?, checkpoint, paths?, force? }` |
| DELETE | `/v1/checkpoints` | `?editor` |

`editor` names a session as `/v1/health` lists it; omitted is the active session. Events on `/v1/events`: `checkpoints.toggled`, `checkpoint.created`, `checkpoint.restored` and `checkpoints.cleared`.
