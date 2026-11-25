--!strict

-- Quote the directory, but keep the executable basename visible to Tern.
local command = "'" .. tern.plugin.dir:gsub("'", "'\"'\"'") .. "'/omo-native"

-- Tern groups OMO under "agent"; register by executable to leave other agents alone.
tern.chrome.program_icon("omo-native", "puzzle")

local owned: { [number]: boolean } = {}

local function launch(id: string, title: string, args: string)
    tern.command({ id = id, title = title, run = function(cx)
        local focused = cx.session:focused()
        local pane = if focused then cx.session:pane(focused) else nil
        local cwd = if pane and (pane.kind == "terminal" or pane.kind == "agent") then pane.cwd else nil
        local launched = cx.layout:new_tab({
            command = (if cx.hosts:current().kind == "local" then command else "omo-native") .. args,
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

local function surface_node(cx: WindowCx, pane: number, mode: string, id: string)
    local tree = cx.session:surface(pane, { root = id, nodes = 1 })
    if type(tree) ~= "table" or tree.surface.id ~= "omo" or tree.surface.mode ~= mode then return nil end
    local node = tree.main or tree.dock or tree.layer
    return if node and node.id == id then node else nil
end

local sized: { [number]: boolean } = {}
tern.on("pane_closed", function(ev)
    sized[ev.pane] = nil
end)

tern.command({
    id = "size-workflow",
    title = "OMO: Initialize Workflow width",
    available = function() return false end,
    run = function(cx)
        if cx.hosts:current().kind ~= "local" then return end
        -- Focus only identifies the shown tab; never use it as a resize target.
        local shown = cx.session:focused()
        local tab = if shown then cx.session:tab_of(shown) else nil
        local layout = if tab then cx.session:layout(tab) else nil
        if not layout or layout.zoomed then return end

        local function visit(tree: TabTree)
            if not tree.split then return end
            local left, right = tree[1], tree[2]
            if tree.split == "right" and tree.ratio == 0.5 and left.pane and right.pane and not sized[right.pane] then
                local chat, pane = left.pane, right.pane
                local pending = surface_node(cx, pane, "screen", "workflow-sizing")
                local text = if pending and pending.p then pending.p.text else nil
                if type(text) == "string" and #text <= 100 then
                    local nonce, owner, companion, window, adjustment = text:match("^([a-f0-9]+):([1-9]%d*):([1-9]%d*):(%d*):(-?%d+%.%d+)$")
                    local cells = tonumber(adjustment)
                    if nonce and #nonce == 32 and tonumber(owner) == chat and tonumber(companion) == pane
                        and window == cx:window_key() and cells and math.abs(cells) <= 4096 then
                        local intent = surface_node(cx, chat, "inline", "workflow-open-intent")
                        if intent and intent.p and intent.p.text == nonce then
                            sized[pane] = true
                            cx.layout:resize(pane, "left", cells)
                        end
                    end
                end
            else
                visit(left)
                visit(right)
            end
        end
        if layout.root then visit(layout.root) end
    end,
})
