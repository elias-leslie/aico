# AppArmor profile for the Electron sandbox (Ubuntu 24.04+)

Ubuntu 24.04+ can set `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks Electron's sandbox from creating the user namespace it needs.

When, and only when, that sysctl is `1`, `scripts/aico-install.sh` generates the minimal profile Ubuntu documents for such applications: `userns` for the current checkout's `node_modules/electron/dist/electron`. The profile is named `aico-electron-<first 12 hex of sha256(binary path)>`, so two checkouts never overwrite each other's profile. No `aa-status` (root) call is needed: the installer compares the generated profile with `/etc/apparmor.d/<name>`.

The installer prints the generated profile path and the commands before doing anything privileged, and runs them only after an interactive yes or with `AICO_INSTALL_PRIVILEGED=1`:

```bash
sudo install -m 0644 /tmp/<generated-profile> /etc/apparmor.d/aico-electron-<hash>
sudo apparmor_parser -r /etc/apparmor.d/aico-electron-<hash>
```

The Electron binary lives in a user-writable checkout, so anything that replaces that file also receives the `userns` permission. Remove a profile with `sudo apparmor_parser -R <path> && sudo rm <path>`; this also applies to the fixed-name `aico-electron` profile older installers wrote.

Do not disable Electron's sandbox unless you are debugging a local environment issue.
