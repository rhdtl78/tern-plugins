--!strict

-- The phone's copy of window.luau cannot know this host's plugin path.
-- Only claim the two exact launch lines, never arguments from a user draft.
local commands = {
    ["omo-native"] = false,
    ["omo-native --resume"] = true,
}

tern.on("spawn", function(spec: SpawnSpec)
    if #spec.args ~= 3 or spec.args[1] ~= "-l" or spec.args[2] ~= "-c" then return nil end
    local resume = commands[spec.args[3]]
    if resume == nil then return nil end
    local command = "'" .. tern.plugin.dir:gsub("'", "'\"'\"'") .. "'/omo-native"
    spec.args[3] = command .. (if resume then " --resume" else "")
    return spec
end)
