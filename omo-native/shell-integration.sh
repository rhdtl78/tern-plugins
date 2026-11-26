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
    # Single-bracket equality is literal even when Bash enables nocasematch.
    if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --resume ] && [ "$1" != -r ]; }; then
        command omo "$@"
        return $?
    fi
    if [ "${TERM_PROGRAM-}" = tern ] && [[ -n ${TERN_PANE-} &&
          -z ${SSH_CONNECTION-}${SSH_TTY-}${TMUX-}${STY-}${ZELLIJ-} &&
          -t 0 && -t 1 && -t 2 && -r $_omo_native_dir/main.ts ]]; then
        local runner cli
        runner=$(command -v bun) || runner=$HOME/.bun/bin/bun
        if [[ -n ${BASH_VERSION-} ]]; then cli=$(type -P omo) || cli=; else cli=$(whence -p omo) || cli=; fi
        if [ "${cli##*/}" = omo ] && [[ -x $runner && -f $cli && -x $cli ]]; then
            # Resolve before Bun starts. A child status (even 75) is never a routing decision.
            OMO_NATIVE_CLI=$cli "$runner" "$_omo_native_dir/main.ts" --from-shell "$@"
            return $?
        fi
    fi
    command omo "$@"
}
