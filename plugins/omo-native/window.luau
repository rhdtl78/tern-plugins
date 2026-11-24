--!strict

-- Quote the directory, but keep the executable basename visible to Tern.
local command = "'" .. tern.plugin.dir:gsub("'", "'\"'\"'") .. "'/omo-native"

-- Tern groups OMO under "agent"; register by executable to leave other agents alone.
tern.chrome.program_icon("omo-native", "puzzle")

local owned: { [number]: boolean } = {}

local function launch(id: string, title: string, args: string)
    tern.command({ id = id, title = title, run = function(cx)
        if cx.hosts:current().kind ~= "local" then
            cx:toast("error", "OMO Native is only available in local sessions.")
            return
        end

        local focused = cx.session:focused()
        local pane = if focused then cx.session:pane(focused) else nil
        local cwd = if pane and (pane.kind == "terminal" or pane.kind == "agent") then pane.cwd else nil
        local launched = cx.layout:new_tab({
            command = command .. args,
            cwd = if cwd ~= "" then cwd else nil,
        })
        if launched then
            owned[launched] = true
        end
    end })
end

launch("new-session", "OMO: New Session", "")
launch("resume-session", "OMO: Resume Session", " --resume")

tern.command({ id = "toggle-workflow", title = "OMO: Toggle Workflow", run = function(cx)
    local focused = cx.session:focused()
    if cx.hosts:current().kind == "local" and focused and owned[focused] then
        local pane = cx.session:pane(focused)
        if pane and pane.exited == nil and (pane.kind == "agent" or pane.kind == "terminal") then
            local tree = cx.session:surface(focused, { root = "workflow-toggle", nodes = 1 })
            if type(tree) == "table" and tree.surface.id == "omo"
                and ((tree.dock and tree.dock.id == "workflow-toggle")
                    or (tree.main and tree.main.id == "workflow-toggle")
                    or (tree.layer and tree.layer.id == "workflow-toggle")) then
                cx.session:event(focused, { sf = "omo", ev = "action", id = "workflow-toggle", act = "workflow" })
                return
            end
        end
    end
    cx:toast("error", "Focus a local chat opened by OMO Native to toggle Workflow.")
end })
