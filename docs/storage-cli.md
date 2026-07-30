# Storage CLI

The desktop installation includes `mythpen-cli.exe` next to `mythpen.exe` and `mythpen-server.exe`. Use it to inspect or relocate the data and export directories:

```powershell
& 'D:\Mythpen\mythpen-cli.exe' data-dir get
& 'D:\Mythpen\mythpen-cli.exe' data-dir set 'D:\EmptyMythpenData'
& 'D:\Mythpen\mythpen-cli.exe' data-dir set 'D:\MythpenData' --migrate
& 'D:\Mythpen\mythpen-cli.exe' export-dir get
& 'D:\Mythpen\mythpen-cli.exe' export-dir set 'E:\EmptyMythpenExports'
& 'D:\Mythpen\mythpen-cli.exe' export-dir set 'E:\MythpenExports' --migrate
```

Plain `set <path>` switches Mythpen to a new or empty directory and does not copy existing data. Add `--migrate` only when the existing contents should be copied and SHA-256 verified before the setting changes. Before a migration, Mythpen must be closed completely. A failed migration leaves the configured path unchanged, and the source is retained after a successful migration, so existing data is never removed. Restart Mythpen when the command finishes for the new storage location to take effect.

During migration, Mythpen first copies data into an owned staging directory beside the final target and compares source and staging manifests that include every directory plus each file's size and SHA-256. Symbolic links, junctions and other reparse points, and unsupported filesystem entries are rejected instead of being followed or silently omitted.

On Windows, final publication uses a fixed PowerShell script that calls `.NET Directory.Move` to atomically move the verified staging directory to a missing final path. The executable is an absolute Windows PowerShell 5.1 path derived from an absolute `SystemRoot` or `WINDIR`; it is never resolved through the working directory or `PATH`. Paths are passed as UTF-16LE Base64-encoded `execFile` arguments and are never interpolated into the script text.

Before every move, Mythpen records the owned source directory's type, device, inode, and birth time. After either a success or error callback, a move is committed only when the source is absent and the non-reparse target has that same identity. This prevents a false callback from overriding filesystem truth. `Directory.Move` fails instead of replacing an existing file, ordinary directory, or junction.

If an empty placeholder already exists at the target path, Mythpen preserves it under an owned backup container before final publication by using the same no-replace move helper. If a backup child is raced, Mythpen preserves the external child and the original target and reports the exact retained container and child. A publication conflict leaves the source and configuration unchanged and never writes to or removes the external target.

Non-Windows migration currently fails closed because no equally safe no-replace directory primitive is implemented. Post-commit backup cleanup failures are non-fatal and report every exact residual path and error. If saving the configuration then fails, the recovery diagnostic also includes all of those residuals.
