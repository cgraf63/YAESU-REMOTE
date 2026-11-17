#!/usr/bin/env bash
#
# YAESU-REMOTE - software update, run as root by
#   yaesu-remote-update@check.service     update.sh check
#   yaesu-remote-update@install.service   update.sh install
# which the server (user yaesu) may start (polkit). By hand:
#   sudo systemctl start yaesu-remote-update@install
#
#   check     git fetch (the server then compares HEAD with origin)
#   install   git fetch, reset to origin/<branch>, scripts/install.sh
#             --update (build, services, restart). If that fails: back
#             to the old commit, installed again.
#
# The log ends with "UPDATE OK <old> -> <new>" or "UPDATE FAILED: ..."
# - the server shows that after its restart.
#
# All in main(): git reset replaces this file while it runs, and bash
# reads scripts piece by piece. A function is read completely first.

main() {

    set -uo pipefail

    local mode="${1:-check}"
    local dir="${YAESU_DIR:-/opt/yaesu-remote}"
    local data="${YAESU_DATA:-/var/lib/yaesu-remote}"
    local log="$data/update.log"

    cd "$dir" || { echo "UPDATE FAILED: $dir not found"; return 1; }
    [ -d .git ] || { echo "UPDATE FAILED: $dir is no git checkout - run scripts/install.sh once more"; return 1; }

    local branch
    branch="$(git rev-parse --abbrev-ref HEAD)" || return 1

    if [ "$mode" = check ]; then
        git fetch --quiet origin "$branch"
        return $?
    fi

    [ "$mode" = install ] || { echo "usage: $0 check|install" >&2; return 2; }

    mkdir -p "$data"
    exec > "$log" 2>&1
    chmod 0644 "$log"

    fail() {
        echo
        echo "UPDATE FAILED: $*"
        return 1
    }

    echo "YAESU-REMOTE update started $(date '+%Y-%m-%d %H:%M:%S')"

    local old new
    old="$(git rev-parse --short HEAD)"

    echo "Getting the new version (git fetch origin $branch) ..."
    git fetch --quiet origin "$branch" || { fail "GitHub not reachable (git fetch) - nothing changed"; return 1; }

    new="$(git rev-parse --short "origin/$branch")"
    if [ "$old" = "$new" ]; then
        echo "Already up to date ($old), installing again."
    fi

    # the box has no own changes: exactly the version from GitHub
    git reset --quiet --hard "origin/$branch" || { fail "git reset failed - nothing changed"; return 1; }
    echo "Code: $old -> $new"

    if bash scripts/install.sh --update; then
        echo
        echo "UPDATE OK $old -> $new"
        return 0
    fi

    echo
    echo "Install of $new failed - going back to $old ..."
    git reset --quiet --hard "$old"
    if bash scripts/install.sh --update; then
        fail "new version $new could not be installed - $old is running again (log above)"
    else
        fail "new version $new and old version $old could not be installed - see the log, run: sudo /opt/yaesu-remote/scripts/install.sh"
    fi

}

main "$@"; exit $?
