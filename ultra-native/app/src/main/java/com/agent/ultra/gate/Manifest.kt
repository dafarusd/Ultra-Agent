package com.agent.ultra.gate

import org.json.JSONObject

/**
 * Tool manifests (port of gatellml lang/manifest.py). A tool not declared in
 * the manifest is refused at runtime — deny by default.
 */

enum class Effect { READ, MUTATE, EGRESS, RESOLVE }

data class ToolSpec(
    val name: String,
    val effects: Set<Effect>,
    val requires: List<Contract>,
)

class Manifest(private val specs: Map<String, ToolSpec>) {
    fun tool(name: String): ToolSpec? = specs[name]

    companion object {
        fun fromJson(json: JSONObject): Manifest {
            val tools = json.getJSONArray("tools")
            val map = mutableMapOf<String, ToolSpec>()
            for (i in 0 until tools.length()) {
                val t = tools.getJSONObject(i)
                val name = t.getString("name")
                val effectsArr = t.optJSONArray("effects")
                val effects = mutableSetOf<Effect>()
                if (effectsArr != null) {
                    for (j in 0 until effectsArr.length()) {
                        effects += when (effectsArr.getString(j)) {
                            "read" -> Effect.READ
                            "mutate" -> Effect.MUTATE
                            "egress" -> Effect.EGRESS
                            "resolve" -> Effect.RESOLVE
                            else -> throw IllegalArgumentException("unknown effect in $name")
                        }
                    }
                }
                map[name] = ToolSpec(name, effects, contractsFromJson(t.optJSONArray("requires")))
            }
            return Manifest(map)
        }
    }
}
