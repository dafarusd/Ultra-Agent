package com.agent.ultra.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/** What tool sequence succeeded for a normalized request. */
@Entity(tableName = "task_shortcuts")
data class TaskShortcutEntity(
    @PrimaryKey val requestKey: String,
    val toolsCsv: String,
    val successCount: Int,
    val lastUsed: Long,
)

/** Per-tool reliability counters. */
@Entity(tableName = "tool_reliability")
data class ToolReliabilityEntity(
    @PrimaryKey val tool: String,
    val successes: Int,
    val failures: Int,
    val lastError: String,
)

@Dao
interface TaskMemoryDao {
    @Query("SELECT * FROM task_shortcuts WHERE requestKey = :key")
    suspend fun shortcutFor(key: String): TaskShortcutEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertShortcut(s: TaskShortcutEntity)

    @Query("SELECT * FROM tool_reliability WHERE tool = :tool")
    suspend fun reliabilityFor(tool: String): ToolReliabilityEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertReliability(t: ToolReliabilityEntity)

    @Query("SELECT * FROM tool_reliability WHERE failures > successes")
    suspend fun unreliableTools(): List<ToolReliabilityEntity>
}

@Dao
interface RecipeDao {
    @Query("SELECT * FROM recipes ORDER BY lastRun DESC, createdAt DESC")
    suspend fun list(): List<RecipeEntity>

    @Query("SELECT * FROM recipes WHERE name = :name")
    suspend fun byName(name: String): RecipeEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(r: RecipeEntity)

    @Query("DELETE FROM recipes WHERE name = :name")
    suspend fun delete(name: String)
}
