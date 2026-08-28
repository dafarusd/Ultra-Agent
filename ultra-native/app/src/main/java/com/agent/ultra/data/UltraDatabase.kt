package com.agent.ultra.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [ConversationEntity::class, MessageEntity::class,
        TaskShortcutEntity::class, ToolReliabilityEntity::class,
        RecipeEntity::class],
    version = 4,
)
abstract class UltraDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao
    abstract fun taskMemory(): TaskMemoryDao
    abstract fun recipes(): RecipeDao

    companion object {
        @Volatile private var instance: UltraDatabase? = null

        /** v2 → v3 adds the recipes table. Written as a real migration rather
         * than a destructive fallback: conversations and task memory are the
         * user's data now, not dev scratch. */
        private val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `recipes` (" +
                        "`name` TEXT NOT NULL, " +
                        "`stepsJson` TEXT NOT NULL, " +
                        "`createdAt` INTEGER NOT NULL, " +
                        "`lastRun` INTEGER NOT NULL, " +
                        "`runCount` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`name`))"
                )
            }
        }

        /** v3 → v4 records the full calls, not just the tool names. */
        private val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `task_shortcuts` ADD COLUMN `stepsJson` TEXT NOT NULL DEFAULT ''")
            }
        }

        fun get(context: Context): UltraDatabase = instance ?: synchronized(this) {
            instance ?: Room.databaseBuilder(
                context.applicationContext, UltraDatabase::class.java, "ultra.db"
            ).addMigrations(MIGRATION_2_3, MIGRATION_3_4)
            .fallbackToDestructiveMigration()  // last resort for older dev schemas
            .build().also { instance = it }
        }
    }
}
