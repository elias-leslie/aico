#!/usr/bin/env bash
# Run by the owner, once per host, in a private terminal. Gives the nightly notes export its own Google Drive login:
# a dedicated rclone config and remote with the drive.file scope (files Aico itself creates, in the SummitFlow-Notes
# folder) and nothing else. It is never the SummitFlow backup's config or token. No OAuth material is accepted in args.
#
#   scripts/authorize-notes-drive.sh                      on the workstation
#   ssh -t -L 53682:127.0.0.1:53682 aico-gem 'cd /srv/workspaces/projects/aico && scripts/authorize-notes-drive.sh'
#                                                         for gem (the forward lets your browser here finish the consent)
#
# Use the same Google OAuth Desktop client (client ID and secret) on both hosts: drive.file shows an app only the files
# that same client created, so both hosts then fill one folder. Run it again to resume or to renew the login.
set +x
set -euo pipefail

fail() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}

[[ $# -eq 0 ]] || fail 'This command takes no arguments; enter credentials only at its private prompts.'
[[ -t 0 && -t 1 ]] || fail 'Run from a private interactive terminal, not a pipe or agent transcript.'
command -v rclone >/dev/null || fail 'rclone is not on PATH.'

remote=${AICO_EXPORT_REMOTE:-aico-notes-drive}
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
[[ "$config_home" == /* ]] || fail 'XDG_CONFIG_HOME must be absolute.'
config=${AICO_EXPORT_RCLONE_CONFIG:-"$config_home/aico-export/notes-drive.conf"}
[[ "$config" == /* ]] || fail 'AICO_EXPORT_RCLONE_CONFIG must be absolute.'
directory=$(dirname -- "$config")
# Discard inherited tool overrides so the dedicated config controls the OAuth flow.
while IFS= read -r variable; do
    if [[ "$variable" == RCLONE_* ]]; then
        unset "$variable"
    fi
done < <(compgen -v)

umask 077
mkdir -p -- "$directory"
[[ -d "$directory" && ! -L "$directory" ]] || fail "$directory must be a real directory."
chmod 700 -- "$directory"
[[ ! -L "$config" ]] || fail 'The rclone config must not be a symlink.'
if [[ -e "$config" ]]; then
    [[ -f "$config" && $(stat -c '%u:%a' -- "$config") == "$(id -u):600" ]] || fail 'The existing rclone config is not a private user-owned regular file.'
    [[ $(rclone listremotes --config "$config") == "$remote:" ]] || fail "The existing config is not the dedicated $remote remote."
    printf 'Resuming the private notes-export authorization. No existing config is overwritten.\n'
else
    printf 'Use your own Google OAuth Desktop client for the same Drive account (the same one on every host).\n'
    printf 'This remote requests drive.file access, limited to files created by this app.\n'
    IFS= read -r -s -p 'Google OAuth client ID (hidden): ' client_id </dev/tty || fail 'Client ID input was interrupted.'
    printf '\n' >/dev/tty
    IFS= read -r -s -p 'Google OAuth client secret (hidden): ' client_secret </dev/tty || fail 'Client secret input was interrupted.'
    printf '\n' >/dev/tty
    [[ "$client_id" =~ ^[A-Za-z0-9._-]+$ && "$client_secret" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'Client ID and secret must be nonempty single-line Google OAuth values.'
    (set -C; printf '[%s]\ntype = drive\nscope = drive.file\nclient_id = %s\nclient_secret = %s\n' "$remote" "$client_id" "$client_secret" > "$config") || fail 'Could not create the private rclone config.'
    unset client_id client_secret
fi
[[ $(stat -c '%u:%a' -- "$config") == "$(id -u):600" ]] || fail 'The rclone config is not a private user-owned file.'

printf 'Complete Google consent in a browser yourself. Do not paste a token into chat.\n'
printf 'On gem, answer Y to local browser authentication and open the printed 127.0.0.1 link in your own browser (the ssh forward carries it back).\n'
rclone config reconnect "$remote:" --config "$config" || fail 'OAuth did not finish. Run this script again to resume securely.'
rclone lsf "$remote:" --config "$config" --max-depth 1 >/dev/null || fail 'OAuth finished but Drive could not be read with the new login.'
[[ $(stat -c '%u:%a' -- "$config") == "$(id -u):600" ]] || fail 'rclone changed the config ownership or permissions; stop before using it for the export.'
printf 'AUTH_READY remote=%s config=%s\n' "$remote" "$config"
