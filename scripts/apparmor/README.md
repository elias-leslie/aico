# AppArmor profile for the Electron sandbox (Ubuntu 24.04+)

Ubuntu 24.04+ can set `kernel.apparmor_restrict_unprivileged_userns=1`, which blocks Electron's sandbox from creating the user namespace it needs.

`scripts/aico-install.sh` generates a path-correct `aico-electron` profile for the current checkout and loads it when `sudo` is available in an interactive shell. Prefer that installer path instead of copying a static profile.

If the installer cannot load the profile automatically, it prints the generated temporary profile path plus the exact commands to run, usually:

```bash
sudo cp /tmp/<generated-profile> /etc/apparmor.d/aico-electron
sudo apparmor_parser -r /etc/apparmor.d/aico-electron
aa-status | grep aico-electron
```

After the profile is loaded, run Aico normally. Do not disable Electron's sandbox unless you are debugging a local environment issue.
