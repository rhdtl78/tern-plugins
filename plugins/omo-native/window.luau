--!strict

local entry = tern.plugin.dir .. "/main.ts"
-- Launch.command takes a shell line, not argv. Pass the entry as one literal argument.
local command = [=[/bin/sh -c 'if command -v bun >/dev/null 2>&1; then exec bun "$@"; fi; exec "$HOME/.bun/bin/bun" "$@"' omo-native run ]=]
    .. "'" .. entry:gsub("'", "'\"'\"'") .. "'"

local function launch(id: string, title: string, args: string)
    tern.command({ id = id, title = title, run = function(cx)
        if cx.hosts:current().kind ~= "local" then
            cx:toast("error", "OMO Native is only available in local sessions.")
            return
        end

        local focused = cx.session:focused()
        local pane = if focused then cx.session:pane(focused) else nil
        local cwd = if pane and (pane.kind == "terminal" or pane.kind == "agent") then pane.cwd else nil
        cx.layout:new_tab({
            command = command .. args,
            cwd = if cwd ~= "" then cwd else nil,
        })
    end })
end

launch("new-session", "OMO: New Session", "")
launch("resume-session", "OMO: Resume Session", " --resume")
