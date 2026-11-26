# Source from an interactive Bash or Zsh shell. Never export this function:
# the renderer must still resolve the real omo executable for its RPC child.
case $- in *i*) ;; *) return 0 ;; esac
if alias omo >/dev/null 2>&1 || typeset -f omo >/dev/null 2>&1; then return 0; fi
if [[ -n ${BASH_VERSION-} ]]; then
    _omo_native_entry=${BASH_SOURCE[0]}
elif [[ -n ${ZSH_VERSION-} ]]; then
    _omo_native_entry=${(%):-%x}
else
    return 0
fi
_omo_native_dir=$(CDPATH= cd -- "$(dirname -- "$_omo_native_entry")" && pwd -P) || return 1
unset _omo_native_entry

function omo {
    if [[ ${TERM_PROGRAM-} == tern && -n ${TERN_PANE-} &&
          -z ${SSH_CONNECTION-}${SSH_TTY-}${TMUX-}${STY-}${ZELLIJ-} &&
          -t 0 && -t 1 && -t 2 && -r $_omo_native_dir/main.ts &&
          ( $# == 0 || ( $# == 1 && ( $1 == --resume || $1 == -r ) ) ) ]]; then
        local runner rc=0
        runner=$(command -v bun) || runner=$HOME/.bun/bin/bun
        if [[ -x $runner ]]; then
            "$runner" run "$_omo_native_dir/main.ts" --from-shell "$@" || rc=$?
            # Reserved exclusively for a declined probe, before any surface or RPC.
            if [[ $rc != 75 ]]; then return "$rc"; fi
        fi
    fi
    command omo "$@"
}
